/**
 * Email channel: each agent has its own inbox `<emailHandle>@<EMAIL_DOMAIN>`.
 * Outbound through the Resend REST API; inbound through Resend webhooks (see inbound.ts).
 *
 * Header safety: every value that reaches a header (display names, subject, Message-ID references) is
 * stripped of CR/LF/control characters and length-capped; addresses must pass a strict pattern. References
 * coming from inbound mail are only accepted if they look like `<local@domain>`.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";

const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MSGID_RE = /^<[^<>\s@]{1,200}@[^<>\s@]{1,200}>$/;

/** Remove anything that could break out of a header line. */
export function headerSafe(value: string, max = 200): string {
  return value
    .replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

export function isEmailAddress(v: string): boolean {
  return v.length <= 254 && ADDRESS_RE.test(v);
}

/** Display name for a From header, quoted per RFC 5322 with quotes/backslashes escaped. */
export function formatFrom(displayName: string, address: string): string {
  if (!isEmailAddress(address)) throw new Error("invalid from address");
  const name = headerSafe(displayName.replace(/[\\"<>]/g, ""), 80);
  return name ? `"${name}" <${address}>` : address;
}

/** Parse `Name <a@b.c>` or `a@b.c` into parts. Returns null for anything that isn't a single valid address. */
export function parseAddress(raw: string): { name: string | null; email: string } | null {
  const s = raw.trim();
  const m = /^(?:"?([^"<]*)"?\s*)?<([^<>\s]+)>$/.exec(s);
  const email = (m ? m[2] : s)?.trim().toLowerCase() ?? "";
  if (!isEmailAddress(email)) return null;
  const name = m?.[1]?.trim() ? headerSafe(m[1].trim(), 120) : null;
  return { name, email };
}

export function newMessageId(domain = env().EMAIL_DOMAIN): string {
  return `<${Date.now().toString(36)}.${randomBytes(9).toString("base64url")}@${domain}>`;
}

/** Keep only well-formed message ids from untrusted headers (In-Reply-To / References). */
export function parseMessageIds(raw: string | null | undefined, max = 20): string[] {
  if (!raw) return [];
  const ids = raw.match(/<[^<>\s]+>/g) ?? [];
  return ids.filter((id) => MSGID_RE.test(id)).slice(-max);
}

/** "Re: Fwd: RE: Weekly report" → "weekly report" */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (;;) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
}

export function replySubject(subject: string | null | undefined): string {
  const s = headerSafe(subject ?? "", 250);
  if (!s) return "Re: your message";
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Strip quoted history from a reply so the agent sees only the new text. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^On .{4,200}wrote:\s*$/.test(line.trim())) break;
    // "On Mon, ... at 9:00 AM Dana <dana@x.com>" + "wrote:" split over two lines (Gmail wraps)
    if (/^On .{4,200}$/.test(line.trim()) && /^.{0,120}wrote:\s*$/.test((lines[i + 1] ?? "").trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line) && /^(Sent|Date): .+/.test(lines[i + 1] ?? "")) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  const result = out.join("\n").trim();
  return result || text.trim();
}

/** Crude but safe HTML → text for inbound mail that has no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type OutboundEmail = {
  from: string; // formatted via formatFrom
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Provider idempotency key so a retried job never sends twice. */
  idempotencyKey: string;
};

export type SendResult = { providerId: string | null; simulated: boolean };

export class ProviderError extends Error {
  constructor(
    message: string,
    /** false = permanent (4xx other than 429): don't retry. */
    public retryable: boolean,
  ) {
    super(message);
  }
}

export async function sendEmail(msg: OutboundEmail): Promise<SendResult> {
  const to = msg.to.filter(isEmailAddress);
  if (!to.length) throw new ProviderError("no valid recipients", false);
  const headers: Record<string, string> = { "Message-ID": msg.messageId };
  if (msg.inReplyTo && MSGID_RE.test(msg.inReplyTo)) headers["In-Reply-To"] = msg.inReplyTo;
  const refs = (msg.references ?? []).filter((r) => MSGID_RE.test(r)).slice(-20);
  if (refs.length) headers.References = refs.join(" ");

  const key = env().RESEND_API_KEY;
  if (!key) {
    logger.info({ to: to.length, subject: headerSafe(msg.subject, 80) }, "email: simulated send (RESEND_API_KEY not set)");
    return { providerId: null, simulated: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": msg.idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify({
      from: msg.from,
      to,
      subject: headerSafe(msg.subject, 250),
      text: msg.text,
      html: msg.html,
      reply_to: msg.replyTo && isEmailAddress(msg.replyTo) ? [msg.replyTo] : undefined,
      headers,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(`resend ${res.status}: ${detail}`, res.status >= 500 || res.status === 429);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { providerId: data.id ?? null, simulated: false };
}

/** Fetch the full content of a received email (Resend's webhook only carries metadata). */
export async function fetchReceivedEmail(emailId: string): Promise<Record<string, unknown> | null> {
  const key = env().RESEND_API_KEY;
  if (!key || !/^[A-Za-z0-9-]{1,100}$/.test(emailId)) return null;
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new ProviderError(`resend receiving ${res.status}`, true);
    return null;
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Display name for outbound mail: "Maya · Brandlord" when the org sets an email sender name. */
export function agentFromName(agentName: string, branding: { emailFromName?: string } | null | undefined): string {
  const brand = branding?.emailFromName ? headerSafe(branding.emailFromName, 60) : "";
  return brand ? `${headerSafe(agentName, 40)} · ${brand}` : headerSafe(agentName, 60);
}

export function agentAddress(handle: string): string {
  return `${handle}@${env().EMAIL_DOMAIN}`;
}
