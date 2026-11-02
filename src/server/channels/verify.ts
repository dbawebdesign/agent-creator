/**
 * Webhook signature verification for Resend (Svix), Twilio and Slack.
 * All comparisons are constant-time; timestamps outside the replay window are rejected.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const REPLAY_WINDOW_SEC = 5 * 60;

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function freshTimestamp(tsRaw: string | null, nowSec: number): boolean {
  if (!tsRaw || !/^\d{1,12}$/.test(tsRaw)) return false;
  const ts = Number(tsRaw);
  return Math.abs(nowSec - ts) <= REPLAY_WINDOW_SEC;
}

/**
 * Svix-style signature (used by Resend webhooks).
 * signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, key = base64(secret without "whsec_"),
 * header `svix-signature` = space separated `v1,<base64 sig>` entries (multiple during secret rotation).
 */
export function verifySvix(
  input: { id: string | null; timestamp: string | null; signature: string | null; body: string },
  secret: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !input.id || !input.signature) return false;
  if (input.id.length > 200 || input.signature.length > 4096) return false;
  if (!freshTimestamp(input.timestamp, nowSec)) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${input.id}.${input.timestamp}.${input.body}`).digest();
  let matched = false;
  for (const part of input.signature.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    // Evaluate every candidate (no early exit) to keep timing independent of which entry matched.
    if (constantTimeEqual(given, expected)) matched = true;
  }
  return matched;
}

/** Produce a Svix signature header (tests and local tooling). */
export function signSvix(id: string, timestamp: string, body: string, secret: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + concat(sorted(key) + value))).
 * `urls` are candidate public URLs for this request (the canonical APP_URL-based URL first).
 */
export function twilioSignature(authToken: string, url: string, params: Array<[string, string]>): string {
  const sorted = [...params].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  let data = url;
  for (const [k, v] of sorted) data += k + v;
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilio(
  input: { signature: string | null; urls: string[]; params: Array<[string, string]> },
  authToken: string | undefined,
): boolean {
  if (!authToken || !input.signature || input.signature.length > 200) return false;
  const given = Buffer.from(input.signature);
  let matched = false;
  for (const url of input.urls) {
    const expected = Buffer.from(twilioSignature(authToken, url, input.params));
    if (constantTimeEqual(given, expected)) matched = true;
  }
  return matched;
}

/**
 * Slack v0 signature: `v0=` + hex(HMAC-SHA256(signingSecret, `v0:${timestamp}:${rawBody}`)).
 */
export function verifySlack(
  input: { signature: string | null; timestamp: string | null; body: string },
  signingSecret: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!signingSecret || !input.signature || input.signature.length > 200) return false;
  if (!freshTimestamp(input.timestamp, nowSec)) return false;
  const expected = Buffer.from(
    `v0=${createHmac("sha256", signingSecret).update(`v0:${input.timestamp}:${input.body}`).digest("hex")}`,
  );
  return constantTimeEqual(Buffer.from(input.signature), expected);
}

export function signSlack(timestamp: string, body: string, signingSecret: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}
