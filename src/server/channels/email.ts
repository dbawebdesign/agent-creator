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
import { readTextCapped } from "@/server/api/body";
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

/** Max length of an address header value we will even look at (RFC 5321 path limit is 256). */
const MAX_ADDRESS_HEADER = 512;

/**
 * Parse `Name <a@b.c>`, `"Name" <a@b.c>` or `a@b.c`. Linear (no backtracking regex) and length-capped.
 * Returns null for anything that isn't a single valid address.
 */
export function parseAddress(raw: string): { name: string | null; email: string } | null {
  if (typeof raw !== "string" || raw.length > MAX_ADDRESS_HEADER) return null;
  const s = raw.trim();
  let email = s;
  let name: string | null = null;
  if (s.endsWith(">")) {
    const lt = s.lastIndexOf("<");
    if (lt < 0) return null;
    email = s.slice(lt + 1, -1);
    let display = s.slice(0, lt).trim();
    if (display.length >= 2 && display.startsWith('"') && display.endsWith('"')) display = display.slice(1, -1);
    if (display.includes("<") || display.includes(">")) return null;
    name = display.replace(/"/g, "").trim() ? headerSafe(display.replace(/"/g, ""), 120) : null;
  }
  email = email.trim().toLowerCase();
  if (!isEmailAddress(email)) return null;
  return { name, email };
}

export function newMessageId(domain = env().EMAIL_DOMAIN): string {
  return `<${Date.now().toString(36)}.${randomBytes(9).toString("base64url")}@${domain}>`;
}

/** Keep only well-formed message ids from untrusted headers (In-Reply-To / References). */
export function parseMessageIds(raw: string | null | undefined, max = 20): string[] {
  if (!raw) return [];
  const ids = raw.slice(0, 16_384).match(/<[^<>\s]{1,500}>/g) ?? [];
  return ids.filter((id) => MSGID_RE.test(id)).slice(-max);
}

/** "Re: Fwd: RE: Weekly report" → "weekly report" */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").slice(0, 1000).trim();
  for (;;) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|sv|antw)(?:\s*\[\d{1,6}\])?\s*:\s*/i, "");
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
export function stripQuotedReply(input: string): string {
  const text = input.slice(0, MAX_TEXT);
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

/** Inbound bodies are cut to this many characters before any parsing (agents don't need more). */
export const MAX_TEXT = 100_000;
const MAX_HTML = 400_000;

const SKIP_CONTENT = ["script", "style", "head", "title", "template", "noscript"];
const BREAK_TAGS = new Set(["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "section", "article", "ul", "ol"]);
const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", amp: "&" };

/**
 * HTML → text for inbound mail that has no text part. A single linear scan (indexOf only moves forward; an
 * unclosed tag or skip-block ends the scan), so hostile input can't trigger regex backtracking.
 */
export function htmlToText(input: string): string {
  const html = input.slice(0, MAX_HTML);
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break; // unterminated tag: drop the rest
    // Tag name: letters/digits after "<" or "</", read with a bounded loop.
    let j = lt + 1;
    const closing = html[j] === "/";
    if (closing) j++;
    let nameEnd = j;
    while (nameEnd < gt && nameEnd - j < 16 && /[a-z0-9]/i.test(html[nameEnd]!)) nameEnd++;
    const name = lower.slice(j, nameEnd);
    if (!closing && SKIP_CONTENT.includes(name)) {
      const end = lower.indexOf(`</${name}`, gt + 1);
      if (end < 0) break; // unclosed <script>: nothing after it is text
      const endGt = html.indexOf(">", end);
      if (endGt < 0) break;
      i = endGt + 1;
      continue;
    }
    if (BREAK_TAGS.has(name)) out.push("\n");
    i = gt + 1;
    if (out.length > 50_000) break;
  }
  return out
    .join("")
    .replace(/&(nbsp|lt|gt|quot|#39|apos|amp);/g, (_m, e: string) => ENTITIES[e] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, MAX_TEXT)
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
    const log = env().NODE_ENV === "production" ? logger.warn.bind(logger) : logger.info.bind(logger);
    log({ recipients: to.length }, "email: simulated send (RESEND_API_KEY not set)");
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
  // Size-capped read: a huge message must not exhaust memory or feed megabytes into parsing.
  const raw = await readTextCapped(res, 2_000_000);
  if (raw === null) {
    logger.warn({ emailId }, "inbound email too large; using webhook metadata only");
    return null;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Display name for outbound mail: "Maya · Brandlord" when the org sets an email sender name. */
export function agentFromName(agentName: string, branding: { emailFromName?: string } | null | undefined): string {
  const brand = branding?.emailFromName ? headerSafe(branding.emailFromName, 60) : "";
  return brand ? `${headerSafe(agentName, 40)} · ${brand}` : headerSafe(agentName, 60);
}

export function agentAddress(handle: string): string {
  return `${handle}@${env().EMAIL_DOMAIN}`;
}
