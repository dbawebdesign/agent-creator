/**
 * Inbound email attachments → the same file pipeline as uploads (src/server/files).
 *
 * Trust: an attachment is indexed into the agent's knowledge only when the sender is TRUSTED — the
 * receiving MTA's verdict is senderAuth "pass" AND the sender is a member of the org (or an ancestor,
 * e.g. agency staff) or a known contact (a contact the business has already emailed). Everything else is
 * stored (original kept, visible to staff) but never indexed, so a stranger can't plant text in the
 * knowledge base that later steers the agent.
 *
 * Bytes come from, in order: inline base64 `content` on the payload; a `download_url` on an allowlisted
 * HTTPS host (no redirects, size-capped); or Resend's attachment API (which returns a signed download_url).
 * Only supported document types are downloaded; others (images, archives, executables) are listed by
 * name only. Per message: ≤ 10 files, ≤ 25 MB total. Per org: ≤ 200 files/hour.
 */
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { readBytesCapped } from "@/server/api/body";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { rateLimit } from "@/server/security/rate-limit";
import { fileKind, safeFileName, UPLOAD_MAX_BYTES } from "@/server/files/extract";
import { ingestFile } from "@/server/files/service";
import type { SenderAuth } from "./inbound";

export const ATTACHMENT_LIMITS = { perMessage: 10, totalBytes: 25 * 1024 * 1024, perOrgPerHour: 200 } as const;

/** Hosts a download_url may point at (suffix match). Override with ATTACHMENT_DOWNLOAD_HOSTS=a.com,b.com. */
export function attachmentHosts(): string[] {
  const raw = process.env.ATTACHMENT_DOWNLOAD_HOSTS;
  return (raw ? raw.split(",") : ["resend.com", "resend.app"]).map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function allowedDownloadUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  return attachmentHosts().some((h) => host === h || host.endsWith(`.${h}`)) ? u : null;
}

export type InboundAttachment = {
  id: string | null;
  filename: string;
  contentType: string | null;
  size: number | null;
  inline: boolean;
  content: string | null;
  downloadUrl: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Normalize the provider's attachment list (Resend webhook / receiving API shapes). */
export function attachmentList(raw: unknown): InboundAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((a): InboundAttachment[] => {
    if (!a || typeof a !== "object") return [];
    const o = a as Record<string, unknown>;
    const filename = str(o.filename) ?? str(o.name);
    if (!filename) return [];
    const size = typeof o.size === "number" && Number.isFinite(o.size) ? o.size : null;
    return [
      {
        id: str(o.id),
        filename: safeFileName(filename),
        contentType: str(o.content_type) ?? str(o.contentType),
        size,
        inline: str(o.content_disposition)?.toLowerCase() === "inline",
        content: str(o.content),
        downloadUrl: str(o.download_url) ?? str(o.downloadUrl),
      },
    ];
  });
}

/** Sender is a member of the org or of an org above it (agency staff), by account email. */
async function isMemberEmail(database: DB, orgId: string, email: string): Promise<boolean> {
  const r = await database.execute(sql`
    with recursive chain(id, depth) as (
      select id, 0 from organizations where id = ${orgId}::uuid
      union all
      select o.parent_id, c.depth + 1 from organizations o join chain c on o.id = c.id
      where o.parent_id is not null and c.depth < 8
    )
    select 1 from users u join memberships m on m.user_id = u.id
    where lower(u.email) = lower(${email}) and m.org_id in (select id from chain) limit 1`);
  return r.rows.length > 0;
}

/** A contact the business has already written to (an outbound message went to their conversation). */
export async function isKnownEmailContact(database: DB, orgId: string, email: string): Promise<boolean> {
  const r = await database.execute(sql`
    select 1 from contacts c
    join conversations cv on cv.contact_id = c.id and cv.org_id = c.org_id
    join messages m on m.conversation_id = cv.id and m.org_id = c.org_id
    where c.org_id = ${orgId}::uuid and lower(c.email) = lower(${email})
      and m.direction = 'outbound' and m.delivery_status in ('sent', 'delivered')
    limit 1`);
  return r.rows.length > 0;
}

/** Call BEFORE ingesting the message (ingest creates the contact, which would make anyone "known"). */
export async function emailSenderTrustedForFiles(database: DB, orgId: string, email: string, senderAuth: SenderAuth): Promise<boolean> {
  if (senderAuth !== "pass") return false;
  return (await isMemberEmail(database, orgId, email)) || (await isKnownEmailContact(database, orgId, email));
}

async function fetchBytes(url: URL, maxBytes: number, headers?: Record<string, string>): Promise<Buffer | null> {
  const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return readBytesCapped(res.body, maxBytes, res.headers.get("content-length"));
}

/** Resend: GET /emails/receiving/{emailId}/attachments/{id} → { download_url }. */
async function resendDownloadUrl(emailId: string, attachmentId: string): Promise<string | null> {
  const key = env().RESEND_API_KEY;
  if (!key || !/^[A-Za-z0-9-]{1,100}$/.test(emailId) || !/^[A-Za-z0-9-]{1,100}$/.test(attachmentId)) return null;
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments/${attachmentId}`, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const raw = await readBytesCapped(res.body, 64 * 1024, res.headers.get("content-length"));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    return str(j.download_url) ?? str((j.data as Record<string, unknown> | undefined)?.download_url);
  } catch {
    return null;
  }
}

function decodeBase64Capped(b64: string, maxBytes: number): Buffer | null {
  // 4 base64 chars → 3 bytes; refuse before decoding anything oversized.
  if ((b64.length * 3) / 4 > maxBytes + 4) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length > maxBytes ? null : buf;
}

async function attachmentBytes(emailId: string, a: InboundAttachment, maxBytes: number): Promise<Buffer | null> {
  if (a.content) return decodeBase64Capped(a.content, maxBytes);
  let url = a.downloadUrl;
  if (!url && a.id) url = await resendDownloadUrl(emailId, a.id);
  if (!url) return null;
  const allowed = allowedDownloadUrl(url);
  if (!allowed) {
    logger.warn({ host: (() => { try { return new URL(url).hostname; } catch { return "invalid"; } })() }, "attachment download host not allowed");
    return null;
  }
  return fetchBytes(allowed, maxBytes);
}

export type AttachmentOutcome = { name: string; fileId: string | null; status: "indexed" | "stored" | "failed" | "skipped"; reason?: string };

/**
 * Store (and for trusted senders, index) a message's attachments. Idempotent per email: files already
 * stored for `sourceRef` are not stored again. Never throws; failures are logged and reported per file.
 */
export async function processEmailAttachments(
  database: DB,
  input: { orgId: string; agentId: string; emailId: string; sourceRef: string; attachments: InboundAttachment[]; trusted: boolean; throttled: boolean },
): Promise<AttachmentOutcome[]> {
  const out: AttachmentOutcome[] = [];
  if (input.attachments.length === 0) return out;
  const existing = await database
    .select({ id: schema.files.id, name: schema.files.name, status: schema.files.status })
    .from(schema.files)
    .where(and(eq(schema.files.orgId, input.orgId), eq(schema.files.sourceRef, input.sourceRef)));
  const done = new Map(existing.map((f) => [f.name, f]));
  let total = 0;
  let count = 0;
  for (const a of input.attachments) {
    const prior = done.get(a.filename);
    if (prior) {
      out.push({ name: a.filename, fileId: prior.id, status: prior.status });
      continue;
    }
    const skip = (reason: string) => out.push({ name: a.filename, fileId: null, status: "skipped", reason });
    if (a.inline && !fileKind(a.filename)) {
      skip("inline");
      continue;
    }
    if (!fileKind(a.filename)) {
      skip("unsupported type");
      continue;
    }
    if (input.throttled) {
      skip("sender over volume limit");
      continue;
    }
    if (count >= ATTACHMENT_LIMITS.perMessage) {
      skip("too many attachments");
      continue;
    }
    if (a.size !== null && a.size > UPLOAD_MAX_BYTES) {
      skip("over 10 MB");
      continue;
    }
    const budget = Math.min(UPLOAD_MAX_BYTES, ATTACHMENT_LIMITS.totalBytes - total);
    if (budget <= 0) {
      skip("message over 25 MB of attachments");
      continue;
    }
    const rl = await rateLimit(`attach:org:${input.orgId}`, ATTACHMENT_LIMITS.perOrgPerHour, 3600);
    if (!rl.ok) {
      skip("org attachment limit reached");
      continue;
    }
    try {
      const bytes = await attachmentBytes(input.emailId, a, budget);
      if (!bytes) {
        skip("couldn't download");
        continue;
      }
      total += bytes.length;
      count++;
      const res = await ingestFile({
        orgId: input.orgId,
        agentId: input.agentId,
        name: a.filename,
        bytes,
        source: "email",
        sourceRef: input.sourceRef,
        index: input.trusted,
        actor: { type: "system" },
        meta: { emailId: input.emailId, trusted: input.trusted, contentType: a.contentType },
      });
      out.push({ name: res.name, fileId: res.fileId, status: res.status, ...(res.error ? { reason: res.error } : {}) });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.name : "unknown", emailId: input.emailId }, "attachment processing failed");
      out.push({ name: a.filename, fileId: null, status: "failed", reason: "error" });
    }
  }
  return out;
}

/** One line for the agent's view of the message, so it knows what came with it. */
export function attachmentNote(outcomes: AttachmentOutcome[]): string {
  if (outcomes.length === 0) return "";
  const parts = outcomes.map((o) =>
    o.status === "indexed"
      ? `${o.name} (added to your knowledge)`
      : o.status === "stored"
        ? `${o.name} (saved, not read: sender not verified)`
        : `${o.name} (not saved${o.reason ? `: ${o.reason}` : ""})`,
  );
  return `[Attachments: ${parts.join("; ")}]`;
}
