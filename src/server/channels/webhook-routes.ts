/**
 * Webhook route logic (kept out of src/app so it can be unit-tested with plain Request objects).
 * Each handler: read the raw body → verify signature (constant-time, replay window) → record the event
 * idempotently (webhook_events unique provider+external id) and queue inbound.process → respond fast.
 */
import "server-only";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { isActionableSlackEvent } from "./inbound";
import { EMPTY_TWIML } from "./sms";
import { verifySlack, verifySvix, verifyTwilio } from "./verify";
import { recordWebhookEvent } from "./webhooks";

const MAX_BODY = 1024 * 1024;

function reject(status: number, message: string) {
  return Response.json({ error: { code: status === 413 ? "invalid_request" : "unauthorized", message } }, { status });
}

async function rawBody(req: Request): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return null;
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ── Resend (Svix) ───────────────────────────────────────────────────────────

export async function handleResendWebhook(req: Request): Promise<Response> {
  const body = await rawBody(req);
  if (body === null) return reject(413, "Payload too large");
  const id = req.headers.get("svix-id");
  const ok = verifySvix(
    { id, timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature"), body },
    env().RESEND_WEBHOOK_SECRET,
  );
  if (!ok || !id) {
    if (!env().RESEND_WEBHOOK_SECRET) logger.warn("resend webhook rejected: RESEND_WEBHOOK_SECRET not set");
    return reject(401, "Invalid signature");
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = asObject(JSON.parse(body));
  } catch {
    payload = null;
  }
  if (!payload) return reject(400, "Invalid JSON");
  const res = await recordWebhookEvent("resend", id, payload);
  return Response.json({ ok: true, duplicate: res.duplicate });
}

// ── Twilio ──────────────────────────────────────────────────────────────────

/** Candidate public URLs Twilio may have signed: canonical APP_URL-based first, then the request URL. */
function twilioUrls(req: Request): string[] {
  const u = new URL(req.url);
  const canonical = `${env().APP_URL.replace(/\/+$/, "")}${u.pathname}${u.search}`;
  return [...new Set([canonical, req.url])];
}

function twiml(status = 200) {
  return new Response(EMPTY_TWIML, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

export async function handleTwilioWebhook(req: Request): Promise<Response> {
  const body = await rawBody(req);
  if (body === null) return reject(413, "Payload too large");
  const form = new URLSearchParams(body);
  const params = [...form.entries()];
  const ok = verifyTwilio({ signature: req.headers.get("x-twilio-signature"), urls: twilioUrls(req), params }, env().TWILIO_AUTH_TOKEN);
  if (!ok) {
    if (!env().TWILIO_AUTH_TOKEN) logger.warn("twilio webhook rejected: TWILIO_AUTH_TOKEN not set");
    return reject(403, "Invalid signature");
  }
  const accountSid = env().TWILIO_ACCOUNT_SID;
  if (accountSid && form.get("AccountSid") !== accountSid) return reject(403, "Unknown account");
  const sid = form.get("MessageSid") ?? form.get("SmsSid");
  if (!sid || !/^[A-Za-z0-9]{10,64}$/.test(sid)) return twiml(); // status callbacks etc.: acknowledge, ignore
  await recordWebhookEvent("twilio", sid, Object.fromEntries(params));
  return twiml();
}

// ── Slack ───────────────────────────────────────────────────────────────────

export async function handleSlackWebhook(req: Request): Promise<Response> {
  const body = await rawBody(req);
  if (body === null) return reject(413, "Payload too large");
  const ok = verifySlack(
    { signature: req.headers.get("x-slack-signature"), timestamp: req.headers.get("x-slack-request-timestamp"), body },
    env().SLACK_SIGNING_SECRET,
  );
  if (!ok) {
    if (!env().SLACK_SIGNING_SECRET) logger.warn("slack webhook rejected: SLACK_SIGNING_SECRET not set");
    return reject(401, "Invalid signature");
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = asObject(JSON.parse(body));
  } catch {
    payload = null;
  }
  if (!payload) return reject(400, "Invalid JSON");

  if (payload.type === "url_verification") {
    const challenge = typeof payload.challenge === "string" ? payload.challenge.slice(0, 200) : "";
    return Response.json({ challenge });
  }
  if (payload.type !== "event_callback") return Response.json({ ok: true });

  const eventId = typeof payload.event_id === "string" ? payload.event_id : null;
  const event = asObject(payload.event) ?? undefined;
  // Bot messages, edits and non-DM channel chatter are acknowledged and dropped. Retries of an event we've
  // already recorded are deduplicated by event_id (X-Slack-Retry-Num is informational only).
  if (!eventId || !/^[A-Za-z0-9]{4,64}$/.test(eventId) || !isActionableSlackEvent(event)) return Response.json({ ok: true });
  const res = await recordWebhookEvent("slack", eventId, {
    team_id: payload.team_id,
    api_app_id: payload.api_app_id,
    event_id: eventId,
    event_time: payload.event_time,
    event,
  });
  return Response.json({ ok: true, duplicate: res.duplicate });
}
