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
import { resolveTxt } from "node:dns/promises";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { readBytesCapped } from "@/server/api/body";
import { db, schema, type DB } from "@/server/db/client";
import type { DnsRecord } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";
import { randomToken } from "@/server/security/crypto";

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
    from chain c join email_domains d on d.org_id = c.id and d.status = 'verified' and (d.simulated = false or ${simulationAllowed()})
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
    .where(and(eq(schema.emailDomains.domain, d), eq(schema.emailDomains.status, "verified"), simulationAllowed() ? sql`true` : eq(schema.emailDomains.simulated, false)))
    .limit(1);
  return row ? { platform: false, orgId: row.orgId } : null;
}

/** True when the org owning `domainOrgId` is the agent's org or one of its ancestors. */
export async function orgIsInChain(agentOrgId: string, domainOrgId: string, database: DB = db()): Promise<boolean> {
  return (await chainIds(database, agentOrgId)).includes(domainOrgId);
}

/** The local part email.ts newMessageId() produces: base36 time "." 12 base64url chars. */
const OUR_MESSAGE_ID_LOCAL = /^[0-9a-z]{6,12}\.[A-Za-z0-9_-]{12}$/;

/** Does `<local@domain>` look like a Message-ID we minted, on one of our domains? */
export async function ourMessageIdDomain(messageId: string, database: DB = db()): Promise<boolean> {
  const m = /^<([^@<>\s]{1,64})@([a-z0-9.-]{1,253})>$/i.exec(messageId.trim());
  if (!m || !OUR_MESSAGE_ID_LOCAL.test(m[1]!)) return false;
  return (await resolveInboundDomain(m[2]!, database)) !== null;
}

/**
 * Verification without DNS ("simulated") is honored only in dev/test with no Resend key. In production, or as
 * soon as a key is configured, simulated rows stop counting and must be re-verified for real.
 */
export function simulationAllowed(): boolean {
  const e = env();
  return e.NODE_ENV !== "production" && !e.RESEND_API_KEY;
}

// ── Settings ────────────────────────────────────────────────────────────────

/** Pending claims lapse after this; the domain is then free to claim again (by anyone). */
export const CLAIM_TTL_MS = 72 * 3600_000;

/** Mailbox providers: nobody "owns" these, so they can never be a workspace's agent domain. */
const FREE_MAIL = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com",
  "gmx.net", "gmx.de", "web.de", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com",
  "126.com", "fastmail.com", "hey.com", "tutanota.com", "tuta.io", "duck.com", "hushmail.com", "comcast.net",
  "verizon.net", "att.net", "btinternet.com", "orange.fr", "free.fr", "libero.it", "naver.com", "rediffmail.com",
];

/** Common multi-label public suffixes (bare TLDs are already refused: a domain needs 2+ labels). */
const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "com.br", "com.cn", "com.hk", "com.tw", "co.in", "co.za", "com.mx", "com.ar", "com.sg",
  "com.my", "co.kr", "com.tr", "co.il", "com.ua", "com.pl", "co.id", "com.ph", "com.vn", "com.ng", "com.eg",
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "workers.dev", "web.app",
  "firebaseapp.com", "appspot.com", "blogspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com",
  "onrender.com", "fly.dev", "railway.app", "ngrok.io", "ngrok-free.app", "repl.co", "glitch.me", "wixsite.com",
  "squarespace.com", "myshopify.com",
]);

/** Why a domain can't be claimed, or null when it's acceptable. */
export function domainRefusal(domain: string): string | null {
  const platform = platformDomain();
  if (domain === platform || domain.endsWith(`.${platform}`)) return "That's the platform's own domain. Use a domain you own.";
  if (FREE_MAIL.some((f) => domain === f || domain.endsWith(`.${f}`))) return "That's a public mailbox provider. Use a domain your business owns.";
  if (PUBLIC_SUFFIXES.has(domain)) return "That's a public suffix, not a domain. Use a domain your business owns.";
  const tld = domain.split(".").pop()!;
  if (RESERVED_TLDS.has(tld) && !simulationAllowed()) return "Use a real, public domain.";
  return null;
}

export async function getOrgEmailDomain(orgId: string): Promise<EmailDomain | null> {
  const [row] = await db().select().from(schema.emailDomains).where(eq(schema.emailDomains.orgId, orgId)).limit(1);
  return row ?? null;
}

type ResendDomain = { id?: string; name?: string; status?: string; records?: unknown[]; data?: ResendDomain[] };

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

/** Our ownership record: proves THIS workspace controls the domain (Resend's records are shared by all claimers). */
export function ownershipRecord(domain: string, token: string): DnsRecord {
  return { record: "Ownership", name: `_roster-verify.${domain}`, type: "TXT", value: `roster-verify=${token}` };
}

async function ownershipPublished(domain: string, token: string): Promise<boolean> {
  try {
    const txt = await resolveTxt(`_roster-verify.${domain}`);
    return txt.some((parts) => parts.join("") === `roster-verify=${token}`);
  } catch {
    return false;
  }
}

/** Register the domain with Resend (or find it when another claim already registered it). */
async function ensureResendDomain(domain: string): Promise<{ id: string | null; records: DnsRecord[]; status?: string }> {
  try {
    const created = await resend("POST", "/domains", { name: domain });
    return { id: created?.id ?? null, records: toRecords(created?.records), status: created?.status };
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    const list = await resend("GET", "/domains").catch(() => null);
    const found = (list?.data ?? []).find((d) => d.name?.toLowerCase() === domain);
    if (!found?.id) throw err;
    const got = await resend("GET", `/domains/${encodeURIComponent(found.id)}`).catch(() => null);
    return { id: found.id, records: toRecords(got?.records), status: got?.status };
  }
}

const NO_PROVIDER_NOTE = "Connect email sending (Resend) to verify this domain.";

async function verifiedElsewhere(database: DB, domain: string, orgId: string): Promise<boolean> {
  const rows = await database
    .select({ orgId: schema.emailDomains.orgId, simulated: schema.emailDomains.simulated })
    .from(schema.emailDomains)
    .where(and(eq(schema.emailDomains.domain, domain), eq(schema.emailDomains.status, "verified")));
  return rows.some((r) => r.orgId !== orgId && (!r.simulated || simulationAllowed()));
}

/**
 * Claim (or replace) the org's email domain. Callers must authorize admin on `orgId` first.
 * - Refuses mailbox providers, public suffixes, the platform domain, and domains another workspace has VERIFIED.
 *   Pending claims never block anyone; they lapse after CLAIM_TTL_MS, and the first claim verified by DNS wins.
 * - Dev/test without a Resend key: verified at once (simulated). Production without a key: stays pending
 *   ("Connect email sending…"). With a key: pending until Resend's records AND our ownership TXT are published.
 * Agents switch to the domain only once it's verified.
 */
export async function setOrgEmailDomain(orgId: string, rawDomain: string, actor?: { userId?: string | null; ip?: string | null }): Promise<EmailDomain> {
  const domain = normalizeEmailDomain(rawDomain);
  if (!domain) throw new DomainError("invalid_input", "Enter a domain like agents.yourcompany.com.");
  const refusal = domainRefusal(domain);
  if (refusal) throw new DomainError("invalid_input", refusal);
  const database = db();
  if (await verifiedElsewhere(database, domain, orgId)) throw new DomainError("conflict", "That domain is already in use by another workspace.");
  const current = await getOrgEmailDomain(orgId);
  if (current?.domain === domain && current.status !== "failed" && (!current.simulated || simulationAllowed())) return current;

  const token = randomToken(16);
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
  let values: Pick<EmailDomain, "status" | "providerId" | "records" | "simulated" | "verifiedAt" | "token" | "expiresAt" | "note">;
  if (simulationAllowed()) {
    values = { status: "verified", providerId: null, records: [], simulated: true, verifiedAt: new Date(), token, expiresAt: null, note: "Test mode: not checked against DNS." };
  } else if (!env().RESEND_API_KEY) {
    values = { status: "pending", providerId: null, records: [ownershipRecord(domain, token)], simulated: false, verifiedAt: null, token, expiresAt, note: NO_PROVIDER_NOTE };
  } else {
    const r = await ensureResendDomain(domain);
    values = { status: "pending", providerId: r.id, records: [...r.records, ownershipRecord(domain, token)], simulated: false, verifiedAt: null, token, expiresAt, note: "Publish these DNS records, then check again." };
  }
  // Replacing a different domain: release the old provider domain (best effort) unless others still claim it.
  if (current?.providerId && current.domain !== domain) await resend("DELETE", `/domains/${encodeURIComponent(current.providerId)}`).catch(() => null);
  const [row] = await database
    .insert(schema.emailDomains)
    .values({ orgId, domain, ...values, checkedAt: new Date() })
    .onConflictDoUpdate({ target: schema.emailDomains.orgId, set: { domain, ...values, checkedAt: new Date() } })
    .returning();
  await audit({ orgId, actorType: actor?.userId ? "user" : "system", actorId: actor?.userId ?? null, action: "email_domain.set", targetType: "email_domain", targetId: row!.id, metadata: { domain, status: row!.status, simulated: row!.simulated }, ip: actor?.ip ?? null });
  return row!;
}

/**
 * Re-check a claim: lapses expired pending claims, converts simulated rows to real claims once real verification
 * is available, and marks the claim verified only when Resend's records and our ownership TXT both check out
 * and no other workspace verified the domain first. Other workspaces' pending claims on it then fail.
 */
export async function checkOrgEmailDomain(orgId: string): Promise<EmailDomain> {
  let current = await getOrgEmailDomain(orgId);
  if (!current) throw new DomainError("not_found", "No email domain set.");
  const database = db();
  const update = async (set: Partial<EmailDomain>) => {
    const [row] = await database
      .update(schema.emailDomains)
      .set({ ...set, checkedAt: new Date() })
      .where(and(eq(schema.emailDomains.id, current!.id), eq(schema.emailDomains.orgId, orgId)))
      .returning();
    return row!;
  };

  if (current.simulated) {
    if (simulationAllowed()) return current;
    // A key is configured now (or this is production): the test-mode verification no longer counts.
    const token = current.token ?? randomToken(16);
    current = await update({ status: "pending", simulated: false, verifiedAt: null, token, expiresAt: new Date(Date.now() + CLAIM_TTL_MS), records: [ownershipRecord(current.domain, token)], note: NO_PROVIDER_NOTE });
  }
  if (current.status === "verified") return current;
  if (current.status === "pending" && current.expiresAt && current.expiresAt.getTime() < Date.now()) {
    return update({ status: "failed", note: "This claim expired. Set the domain again to restart verification." });
  }
  if (!env().RESEND_API_KEY) return update({ note: NO_PROVIDER_NOTE });
  if (await verifiedElsewhere(database, current.domain, orgId)) return update({ status: "failed", note: "Another workspace verified this domain first." });

  let providerId = current.providerId;
  let records = current.records;
  if (!providerId) {
    const r = await ensureResendDomain(current.domain);
    providerId = r.id;
    records = [...r.records, ownershipRecord(current.domain, current.token ?? "")];
  }
  if (!providerId) return update({ note: "Couldn't register the domain with Resend. Try again." });
  const id = encodeURIComponent(providerId);
  await resend("POST", `/domains/${id}/verify`).catch((err: unknown) => {
    if (!(err instanceof DomainError)) throw err;
  });
  const got = await resend("GET", `/domains/${id}`);
  if (got?.records) records = [...toRecords(got.records), ownershipRecord(current.domain, current.token ?? "")];
  const providerOk = got?.status === "verified";
  const ownerOk = current.token ? await ownershipPublished(current.domain, current.token) : false;
  if (got?.status === "failed") return update({ providerId, records, status: "failed", note: "Resend couldn't verify the DNS records. Fix them and set the domain again." });
  if (!providerOk || !ownerOk) {
    return update({ providerId, records, note: !ownerOk ? "Waiting for the ownership TXT record." : "Waiting for Resend to see the DNS records." });
  }
  try {
    const row = await database.transaction(async (tx) => {
      const [won] = await tx
        .update(schema.emailDomains)
        .set({ providerId, records, status: "verified", verifiedAt: new Date(), expiresAt: null, note: null, checkedAt: new Date() })
        .where(and(eq(schema.emailDomains.id, current!.id), eq(schema.emailDomains.orgId, orgId)))
        .returning();
      // First verified claim wins; everyone else's pending claim on this domain ends.
      await tx
        .update(schema.emailDomains)
        .set({ status: "failed", note: "Another workspace verified this domain.", checkedAt: new Date() })
        .where(and(eq(schema.emailDomains.domain, current!.domain), ne(schema.emailDomains.orgId, orgId), ne(schema.emailDomains.status, "verified")));
      return won!;
    });
    return row;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return update({ status: "failed", note: "Another workspace verified this domain first." });
    throw err;
  }
}

export async function removeOrgEmailDomain(orgId: string, actor?: { userId?: string | null; ip?: string | null }): Promise<void> {
  const current = await getOrgEmailDomain(orgId);
  if (!current) return;
  if (current.providerId && current.status === "verified") await resend("DELETE", `/domains/${encodeURIComponent(current.providerId)}`).catch(() => null);
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
  expiresAt: string | null;
  /** Plain-words status, e.g. "Connect email sending (Resend) to verify this domain." */
  note: string | null;
};

export function domainView(d: EmailDomain): EmailDomainView {
  // A test-mode verification that no longer counts (key configured / production) shows as pending.
  const stale = d.simulated && !simulationAllowed();
  return {
    domain: d.domain,
    status: stale ? "pending" : d.status,
    simulated: d.simulated,
    records: d.records,
    verifiedAt: stale ? null : (d.verifiedAt?.toISOString() ?? null),
    checkedAt: d.checkedAt?.toISOString() ?? null,
    expiresAt: d.expiresAt?.toISOString() ?? null,
    note: stale ? "Test-mode verification. Check again to verify against DNS." : d.note,
  };
}

/** For a settings page: this org's own domain (if any) and the domain its agents use right now. */
export async function getEmailDomainSettings(orgId: string): Promise<{ current: EmailDomainView | null; effectiveDomain: string; platformDomain: string }> {
  const [current, effectiveDomain] = await Promise.all([getOrgEmailDomain(orgId), emailDomainFor(orgId)]);
  return { current: current ? domainView(current) : null, effectiveDomain, platformDomain: platformDomain() };
}
