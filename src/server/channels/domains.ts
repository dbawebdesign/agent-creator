/**
 * Per-agency (white-label) email domains.
 *
 * - `emailDomainFor(orgId)`: the nearest VERIFIED domain up the org chain (customer → client → agency),
 *   else env EMAIL_DOMAIN. Every place that forms or shows an agent address uses this.
 * - Inbound: `resolveInboundDomain(domain)` says whether a recipient domain is ours (env domain or a verified
 *   org domain) and which org owns it; the agent must then sit in that org's subtree (see inbound.ts), so a
 *   handle can't be reached through another tenant's domain.
 * - Verification: through Resend's Domains API when RESEND_API_KEY is set (status pending until DNS checks
 *   pass); without a key (dev/test) the domain is marked verified + simulated.
 */
import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readBytesCapped } from "@/server/api/body";
import { db, schema, type DB } from "@/server/db/client";
import type { DnsRecord } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";

export type EmailDomain = typeof schema.emailDomains.$inferSelect;

export class DomainError extends Error {
  constructor(
    public code: "invalid_input" | "conflict" | "not_found" | "provider",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_TLDS = new Set(["local", "localhost", "test", "example", "invalid", "internal"]);

/** Normalize + validate a sending domain ("Agents.Northbeam.ai." → "agents.northbeam.ai"). Null if invalid. */
export function normalizeEmailDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/\.$/, "");
  if (d.length < 4 || d.length > 253 || d.includes("@") || d.includes("/")) return null;
  const labels = d.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) return null; // IP address
  return d;
}

function platformDomain(): string {
  return env().EMAIL_DOMAIN.toLowerCase();
}

/** Org ids from `orgId` up to its root, nearest first (max depth 8). */
async function chainIds(database: DB, orgId: string): Promise<string[]> {
  const r = await database.execute(sql`
    with recursive chain(id, parent_id, depth) as (
      select id, parent_id, 0 from organizations where id = ${orgId}::uuid
      union all
      select o.id, o.parent_id, c.depth + 1 from organizations o join chain c on o.id = c.parent_id
      where c.depth < 8
    )
    select id from chain order by depth`);
  return (r.rows as { id: string }[]).map((x) => x.id);
}

/** Nearest verified domain for each org (batch, for lists). Orgs without one map to env EMAIL_DOMAIN. */
export async function emailDomainsFor(orgIds: string[], database: DB = db()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return out;
  const r = await database.execute(sql`
    with recursive chain(start_id, id, parent_id, depth) as (
      select id, id, parent_id, 0 from organizations where id in (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)})
      union all
      select c.start_id, o.id, o.parent_id, c.depth + 1 from organizations o join chain c on o.id = c.parent_id
      where c.depth < 8
    )
    select distinct on (c.start_id) c.start_id, d.domain
    from chain c join email_domains d on d.org_id = c.id and d.status = 'verified'
    order by c.start_id, c.depth`);
  for (const row of r.rows as { start_id: string; domain: string }[]) out.set(row.start_id, row.domain);
  for (const id of unique) if (!out.has(id)) out.set(id, platformDomain());
  return out;
}

/** The domain agents of `orgId` send from and are shown with. */
export async function emailDomainFor(orgId: string, database: DB = db()): Promise<string> {
  return (await emailDomainsFor([orgId], database)).get(orgId) ?? platformDomain();
}

export function addressAt(handle: string, domain: string): string {
  return `${handle}@${domain}`;
}

/** An agent's address on its org's domain, or null without a handle. */
export async function agentAddressFor(agent: { orgId: string; emailHandle: string | null }, database: DB = db()): Promise<string | null> {
  if (!agent.emailHandle) return null;
  return addressAt(agent.emailHandle, await emailDomainFor(agent.orgId, database));
}

/**
 * Is `domain` one we receive mail for? Returns { platform: true } for env EMAIL_DOMAIN, { orgId } for a
 * verified org domain, or null (not ours: drop).
 */
export async function resolveInboundDomain(domain: string, database: DB = db()): Promise<{ platform: true } | { platform: false; orgId: string } | null> {
  const d = domain.toLowerCase();
  if (d === platformDomain()) return { platform: true };
  const [row] = await database
    .select({ orgId: schema.emailDomains.orgId })
    .from(schema.emailDomains)
    .where(and(eq(schema.emailDomains.domain, d), eq(schema.emailDomains.status, "verified")))
    .limit(1);
  return row ? { platform: false, orgId: row.orgId } : null;
}

/** True when the org owning `domainOrgId` is the agent's org or one of its ancestors. */
export async function orgIsInChain(agentOrgId: string, domainOrgId: string, database: DB = db()): Promise<boolean> {
  return (await chainIds(database, agentOrgId)).includes(domainOrgId);
}

/** Domains that are ours (platform + all verified), for loop detection on From. */
export async function isOwnEmailDomain(domain: string, database: DB = db()): Promise<boolean> {
  return (await resolveInboundDomain(domain, database)) !== null;
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function getOrgEmailDomain(orgId: string): Promise<EmailDomain | null> {
  const [row] = await db().select().from(schema.emailDomains).where(eq(schema.emailDomains.orgId, orgId)).limit(1);
  return row ?? null;
}

type ResendDomain = { id?: string; name?: string; status?: string; records?: unknown[] };

async function resend(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<ResendDomain | null> {
  const key = env().RESEND_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await readBytesCapped(res.body, 256 * 1024, res.headers.get("content-length"));
  let json: Record<string, unknown> = {};
  try {
    json = raw ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    logger.warn({ status: res.status, path: path.replace(/\/[^/]+$/, "/:id") }, "resend domains api error");
    const msg = typeof json.message === "string" ? json.message.slice(0, 200) : `Resend returned ${res.status}`;
    throw new DomainError("provider", msg);
  }
  return json as ResendDomain;
}

function toRecords(raw: unknown[] | undefined): DnsRecord[] {
  return (raw ?? []).slice(0, 20).flatMap((r): DnsRecord[] => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : "");
    return [{ record: s(o.record), name: s(o.name), type: s(o.type), value: s(o.value), ttl: s(o.ttl) || undefined, priority: typeof o.priority === "number" ? o.priority : undefined, status: s(o.status) || undefined }];
  });
}

function statusFrom(resendStatus: string | undefined): EmailDomain["status"] {
  return resendStatus === "verified" ? "verified" : resendStatus === "failed" ? "failed" : "pending";
}

/**
 * Set (or replace) the org's email domain. Callers must authorize admin on `orgId` first.
 * Agents switch to it only once it's verified; until then they keep their current address.
 */
export async function setOrgEmailDomain(orgId: string, rawDomain: string, actor?: { userId?: string | null; ip?: string | null }): Promise<EmailDomain> {
  const domain = normalizeEmailDomain(rawDomain);
  if (!domain) throw new DomainError("invalid_input", "Enter a domain like agents.yourcompany.com.");
  const platform = platformDomain();
  if (domain === platform || domain.endsWith(`.${platform}`)) throw new DomainError("invalid_input", "That's the platform's own domain. Use a domain you own.");
  const tld = domain.split(".").pop()!;
  const simulatedOk = !env().RESEND_API_KEY;
  if (RESERVED_TLDS.has(tld) && !simulatedOk) throw new DomainError("invalid_input", "Use a real, public domain.");

  const database = db();
  const [taken] = await database.select({ orgId: schema.emailDomains.orgId }).from(schema.emailDomains).where(eq(schema.emailDomains.domain, domain)).limit(1);
  if (taken && taken.orgId !== orgId) throw new DomainError("conflict", "That domain is already in use by another workspace.");
  const current = await getOrgEmailDomain(orgId);
  if (current?.domain === domain) return current;

  let values: Pick<EmailDomain, "status" | "providerId" | "records" | "simulated" | "verifiedAt">;
  if (simulatedOk) {
    values = { status: "verified", providerId: null, records: [], simulated: true, verifiedAt: new Date() };
  } else {
    const created = await resend("POST", "/domains", { name: domain });
    values = { status: statusFrom(created?.status), providerId: created?.id ?? null, records: toRecords(created?.records), simulated: false, verifiedAt: created?.status === "verified" ? new Date() : null };
  }
  // Replacing: release the old provider domain (best effort).
  if (current?.providerId) await resend("DELETE", `/domains/${encodeURIComponent(current.providerId)}`).catch(() => null);
  const [row] = await database
    .insert(schema.emailDomains)
    .values({ orgId, domain, ...values, checkedAt: new Date() })
    .onConflictDoUpdate({ target: schema.emailDomains.orgId, set: { domain, ...values, checkedAt: new Date() } })
    .returning();
  await audit({ orgId, actorType: actor?.userId ? "user" : "system", actorId: actor?.userId ?? null, action: "email_domain.set", targetType: "email_domain", targetId: row!.id, metadata: { domain, status: row!.status, simulated: row!.simulated }, ip: actor?.ip ?? null });
  return row!;
}

/** Ask Resend to (re)check DNS and store the result. No-op for simulated domains. */
export async function checkOrgEmailDomain(orgId: string): Promise<EmailDomain> {
  const current = await getOrgEmailDomain(orgId);
  if (!current) throw new DomainError("not_found", "No email domain set.");
  if (current.simulated || !current.providerId || !env().RESEND_API_KEY) return current;
  const id = encodeURIComponent(current.providerId);
  await resend("POST", `/domains/${id}/verify`).catch((err: unknown) => {
    if (!(err instanceof DomainError)) throw err;
  });
  const got = await resend("GET", `/domains/${id}`);
  const status = statusFrom(got?.status);
  const [row] = await db()
    .update(schema.emailDomains)
    .set({ status, records: got?.records ? toRecords(got.records) : current.records, checkedAt: new Date(), verifiedAt: status === "verified" ? (current.verifiedAt ?? new Date()) : null })
    .where(and(eq(schema.emailDomains.id, current.id), eq(schema.emailDomains.orgId, orgId)))
    .returning();
  return row!;
}

export async function removeOrgEmailDomain(orgId: string, actor?: { userId?: string | null; ip?: string | null }): Promise<void> {
  const current = await getOrgEmailDomain(orgId);
  if (!current) return;
  if (current.providerId) await resend("DELETE", `/domains/${encodeURIComponent(current.providerId)}`).catch(() => null);
  await db().delete(schema.emailDomains).where(and(eq(schema.emailDomains.id, current.id), eq(schema.emailDomains.orgId, orgId)));
  await audit({ orgId, actorType: actor?.userId ? "user" : "system", actorId: actor?.userId ?? null, action: "email_domain.removed", targetType: "email_domain", targetId: current.id, metadata: { domain: current.domain }, ip: actor?.ip ?? null });
}

/** Verified-domain rows for a set of orgs (e.g. to show "Using agents.northbeam.ai (from Northbeam)"). */
export async function emailDomainRows(orgIds: string[]): Promise<EmailDomain[]> {
  if (orgIds.length === 0) return [];
  return db().select().from(schema.emailDomains).where(inArray(schema.emailDomains.orgId, orgIds));
}

export type EmailDomainView = {
  domain: string;
  status: EmailDomain["status"];
  simulated: boolean;
  records: DnsRecord[];
  verifiedAt: string | null;
  checkedAt: string | null;
};

export function domainView(d: EmailDomain): EmailDomainView {
  return { domain: d.domain, status: d.status, simulated: d.simulated, records: d.records, verifiedAt: d.verifiedAt?.toISOString() ?? null, checkedAt: d.checkedAt?.toISOString() ?? null };
}

/** For a settings page: this org's own domain (if any) and the domain its agents use right now. */
export async function getEmailDomainSettings(orgId: string): Promise<{ current: EmailDomainView | null; effectiveDomain: string; platformDomain: string }> {
  const [current, effectiveDomain] = await Promise.all([getOrgEmailDomain(orgId), emailDomainFor(orgId)]);
  return { current: current ? domainView(current) : null, effectiveDomain, platformDomain: platformDomain() };
}
