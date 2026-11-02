/**
 * API keys for the public REST API (/api/v1) and the MCP server (/api/mcp).
 *
 * Format: `rk_live_<32 random base64url chars>` (~192 bits). Only sha256(key) is stored; the raw key is
 * returned exactly once from `createApiKey`. `prefix` (first 12 chars) is stored for identification in the UI.
 *
 * Tenancy decision: a key belongs to exactly one org and can only ever see that org's data. It does NOT
 * reach descendant orgs (an agency key cannot read its clients, a client key cannot read its customers).
 * Resellers create keys inside the customer org instead. A key may be further pinned to a single agent.
 *
 * Callers of createApiKey/listApiKeys/revokeApiKey must already have authorized `orgId`
 * (requireOrg(slug, "admin") in the UI).
 */
import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db/client";
import { audit } from "@/server/security/audit";
import { randomToken, safeEqual, sha256 } from "@/server/security/crypto";

export const API_SCOPES = ["agents:read", "agents:invoke", "deliverables:read", "workflows:run"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const apiScope = z.enum(API_SCOPES);

/**
 * Scopes for a key created without an explicit choice (e.g. the portal's "Create key" button): everything,
 * including workflows:run, so every tool MCP advertises works out of the box. MCP's tools/list and its
 * server instructions only ever mention the tools a key's scopes allow, so a narrower key never sees a
 * tool it can't call. createApiKey uses this when `scopes` is omitted.
 */
export const DEFAULT_API_SCOPES: readonly ApiScope[] = API_SCOPES;

export const KEY_PREFIX = "rk_live_";
const KEY_RE = /^rk_live_[A-Za-z0-9_-]{32}$/;

export const SCOPE_LABELS: Record<ApiScope, string> = {
  "agents:read": "List and read agents",
  "agents:invoke": "Send messages to agents",
  "deliverables:read": "Read delivered work",
  "workflows:run": "Run workflows on demand",
};

export type ApiKeyRow = typeof schema.apiKeys.$inferSelect;

export type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  agentId: string | null;
  agentName: string | null;
  createdBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  status: "active" | "revoked" | "expired";
};

const createInput = z.object({
  orgId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  /** Omitted → DEFAULT_API_SCOPES. */
  scopes: z.array(apiScope).min(1).max(API_SCOPES.length).optional(),
  agentId: z.uuid().nullish(),
  createdBy: z.uuid().nullish(),
  expiresAt: z.date().nullish(),
  ip: z.string().max(100).nullish(),
});

export class ApiKeyError extends Error {
  constructor(
    public code: "not_found" | "invalid_input",
    message: string,
  ) {
    super(message);
  }
}

function keyStatus(row: Pick<ApiKeyRow, "revokedAt" | "expiresAt">, now = new Date()): ApiKeySummary["status"] {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt <= now) return "expired";
  return "active";
}

/** Create a key. Returns the raw key ONCE — it cannot be recovered later. */
export async function createApiKey(input: z.input<typeof createInput>): Promise<{ key: string; apiKey: ApiKeySummary }> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw new ApiKeyError("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  const { orgId, name, agentId, createdBy, expiresAt, ip } = parsed.data;
  const scopes = [...new Set(parsed.data.scopes ?? DEFAULT_API_SCOPES)];

  let agentName: string | null = null;
  if (agentId) {
    const [agent] = await db()
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)))
      .limit(1);
    if (!agent) throw new ApiKeyError("not_found", "Agent not found");
    agentName = agent.name;
  }
  if (expiresAt && expiresAt <= new Date()) throw new ApiKeyError("invalid_input", "Expiry must be in the future");

  const key = `${KEY_PREFIX}${randomToken(24)}`;
  const prefix = key.slice(0, 12);
  const [row] = await db()
    .insert(schema.apiKeys)
    .values({
      orgId,
      agentId: agentId ?? null,
      name,
      prefix,
      keyHash: sha256(key),
      scopes,
      createdBy: createdBy ?? null,
      expiresAt: expiresAt ?? null,
    })
    .returning();
  if (!row) throw new Error("api key insert failed");

  await audit({
    orgId,
    actorType: createdBy ? "user" : "system",
    actorId: createdBy ?? null,
    action: "api_key.created",
    targetType: "api_key",
    targetId: row.id,
    metadata: { name, prefix, scopes, agentId: agentId ?? null, expiresAt: expiresAt?.toISOString() ?? null },
    ip: ip ?? null,
  });

  return { key, apiKey: toSummary(row, agentName) };
}

function toSummary(row: ApiKeyRow, agentName: string | null): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
    agentId: row.agentId,
    agentName,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    status: keyStatus(row),
  };
}

/** All keys for an org, newest first (never includes hashes). */
export async function listApiKeys(orgId: string): Promise<ApiKeySummary[]> {
  const rows = await db()
    .select({ key: schema.apiKeys, agentName: schema.agents.name })
    .from(schema.apiKeys)
    .leftJoin(schema.agents, and(eq(schema.agents.id, schema.apiKeys.agentId), eq(schema.agents.orgId, schema.apiKeys.orgId)))
    .where(eq(schema.apiKeys.orgId, orgId))
    .orderBy(desc(schema.apiKeys.createdAt));
  return rows.map((r) => toSummary(r.key, r.agentName ?? null));
}

/** Revoke a key (idempotent). Throws ApiKeyError("not_found") when the key is not in this org. */
export async function revokeApiKey(
  orgId: string,
  keyId: string,
  actor?: { userId?: string | null; ip?: string | null },
): Promise<void> {
  if (!z.uuid().safeParse(keyId).success) throw new ApiKeyError("not_found", "API key not found");
  const [existing] = await db()
    .select({ id: schema.apiKeys.id, revokedAt: schema.apiKeys.revokedAt, prefix: schema.apiKeys.prefix })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.orgId, orgId)))
    .limit(1);
  if (!existing) throw new ApiKeyError("not_found", "API key not found");
  if (existing.revokedAt) return;
  await db()
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.orgId, orgId), isNull(schema.apiKeys.revokedAt)));
  await audit({
    orgId,
    actorType: actor?.userId ? "user" : "system",
    actorId: actor?.userId ?? null,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: keyId,
    metadata: { prefix: existing.prefix },
    ip: actor?.ip ?? null,
  });
}

export type ApiPrincipal = {
  keyId: string;
  orgId: string;
  orgSlug: string;
  /** When set, the key can only see/act on this agent. */
  agentId: string | null;
  scopes: ApiScope[];
  prefix: string;
};

/**
 * Resolve a raw bearer key to a principal. Returns null for malformed, unknown, revoked or expired keys and for
 * keys whose org was deleted. Lookup is by sha256 (unique index), followed by a constant-time hash compare.
 */
export async function authenticateApiKey(raw: string | null | undefined): Promise<ApiPrincipal | null> {
  if (!raw || raw.length > 200 || !KEY_RE.test(raw)) return null;
  const hash = sha256(raw);
  const [row] = await db()
    .select({ key: schema.apiKeys, orgSlug: schema.organizations.slug, orgDeletedAt: schema.organizations.deletedAt })
    .from(schema.apiKeys)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.apiKeys.orgId))
    .where(eq(schema.apiKeys.keyHash, hash))
    .limit(1);
  if (!row || !safeEqual(row.key.keyHash, hash)) return null;
  if (row.orgDeletedAt || keyStatus(row.key) !== "active") return null;

  // Throttle last-used writes to once a minute per key.
  const last = row.key.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - last > 60_000) {
    await db().update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.key.id));
  }
  return {
    keyId: row.key.id,
    orgId: row.key.orgId,
    orgSlug: row.orgSlug,
    agentId: row.key.agentId,
    scopes: toSummary(row.key, null).scopes,
    prefix: row.key.prefix,
  };
}

export function hasScope(p: Pick<ApiPrincipal, "scopes">, scope: ApiScope): boolean {
  return p.scopes.includes(scope);
}

export { mcpConfigSnippet } from "./mcp-config";
