/**
 * SMS channel via Twilio Programmable Messaging (Messaging Service SID).
 */
import "server-only";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { markdownToText } from "./text";
import { ProviderError, type SendResult } from "./email";

export const E164_RE = /^\+[1-9]\d{6,14}$/;

export function normalizeE164(raw: string): string | null {
  const s = raw.replace(/[\s().-]/g, "");
  return E164_RE.test(s) ? s : null;
}

/** Twilio concatenates up to 1600 chars; we keep each part comfortably below that. */
const MAX_PART = 1500;
const MAX_PARTS = 4;

/**
 * Split a reply into SMS-sized messages at paragraph → sentence → word boundaries, numbering them "(1/3)".
 * Anything past MAX_PARTS is cut and a link (if given) is appended so the reader can see the rest.
 */
export function segmentSms(text: string, moreUrl?: string | null): string[] {
  const clean = markdownToText(text).replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= MAX_PART) return [clean];
  const budget = MAX_PART - 8; // room for " (n/m)"
  const parts: string[] = [];
  let rest = clean;
  while (rest.length && parts.length < MAX_PARTS) {
    if (rest.length <= budget) {
      parts.push(rest);
      rest = "";
      break;
    }
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf("\n\n");
    if (cut < budget * 0.5) cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? ")) + 1;
    if (cut < budget * 0.5) cut = window.lastIndexOf(" ");
    if (cut < budget * 0.3) cut = budget;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length) {
    const tail = moreUrl ? `… Full reply: ${moreUrl}` : "…";
    const last = parts[parts.length - 1] ?? "";
    parts[parts.length - 1] = `${last.slice(0, budget - tail.length).trim()}${tail}`;
  }
  return parts.map((p, i) => (parts.length > 1 ? `${p} (${i + 1}/${parts.length})` : p));
}

export async function sendSms(input: { to: string; body: string; from?: string | null }): Promise<SendResult> {
  if (!E164_RE.test(input.to)) throw new ProviderError("invalid destination number", false);
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_MESSAGING_SERVICE_SID: mss } = env();
  if (!sid || !token || (!mss && !input.from)) {
    logger.info({ parts: 1, chars: input.body.length }, "sms: simulated send (Twilio not configured)");
    return { providerId: null, simulated: true };
  }
  const form = new URLSearchParams({ To: input.to, Body: input.body.slice(0, 1600) });
  // With a Messaging Service, From (when the agent owns a number in its sender pool) pins the reply to the
  // agent's own number so the conversation stays on one thread on the customer's phone.
  if (mss) form.set("MessagingServiceSid", mss);
  if (input.from && E164_RE.test(input.from)) form.set("From", input.from);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(`twilio ${res.status}: ${detail}`, res.status >= 500 || res.status === 429);
  }
  const data = (await res.json().catch(() => ({}))) as { sid?: string };
  return { providerId: data.sid ?? null, simulated: false };
}

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
export const START_WORDS = new Set(["start", "unstop", "yes"]);
