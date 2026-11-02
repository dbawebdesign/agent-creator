/**
 * Inbound processing (worker): webhook_events row → agent, contact, conversation, idempotent message,
 * then exactly one reply run per message via engine.startConversationRun (which queues agent.run { orgId, runId })
 * plus engine.triggerEvent for event-triggered workflows (email.received / sms.received / slack.message).
 */
import "server-only";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import type { ChannelKind } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { rateLimit } from "@/server/security/rate-limit";
import * as engine from "@/server/services/engine";
import { fetchReceivedEmail, htmlToText, MAX_TEXT, normalizeSubject, parseAddress, parseMessageIds, stripQuotedReply } from "./email";
import { E164_RE, START_WORDS, STOP_WORDS } from "./sms";
import { stripMention } from "./slack";
import { attachmentList, attachmentNote, emailSenderTrustedForFiles, processEmailAttachments } from "./attachments";

type Agent = typeof schema.agents.$inferSelect;

const MAX_BODY = 50_000;

export type IngestInput = {
  orgId: string;
  agentId: string;
  channel: ChannelKind;
  /** Existing conversation (email threading) or a key to find/create one. */
  conversationId?: string | null;
  threadKey: string;
  subject?: string | null;
  contact: { email?: string | null; phone?: string | null; slackUserId?: string | null; name?: string | null };
  body: string;
  externalId: string;
  meta: Record<string, unknown>;
  /** false: store the message but don't wake the agent (auto-replies, STOP keywords). */
  triggerAgent: boolean;
  /**
   * Whether the channel authenticated the sender: email = DMARC/SPF/DKIM verdict of the receiving MTA
   * ("none" when no Authentication-Results), Slack = verified event from the connected workspace, Twilio =
   * signed webhook. Stored on every inbound message as meta.senderAuth; the engine treats anything but
   * "pass" from a non-member as untrusted.
   */
  senderAuth: SenderAuth;
};

export type SenderAuth = "pass" | "fail" | "none";

export type IngestResult = { conversationId: string; messageId: string | null; duplicate: boolean };

async function findOrCreateContact(database: DB, orgId: string, c: IngestInput["contact"]): Promise<{ id: string; userId: string | null }> {
  const cond = c.email
    ? sql`lower(${schema.contacts.email}) = ${c.email.toLowerCase()}`
    : c.phone
      ? eq(schema.contacts.phone, c.phone)
      : c.slackUserId
        ? eq(schema.contacts.slackUserId, c.slackUserId)
        : null;
  if (cond) {
    const [found] = await database
      .select({ id: schema.contacts.id, name: schema.contacts.name, userId: schema.contacts.userId })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), cond))
      .orderBy(schema.contacts.createdAt)
      .limit(1);
    if (found) {
      if (!found.name && c.name) await database.update(schema.contacts).set({ name: c.name }).where(eq(schema.contacts.id, found.id));
      return { id: found.id, userId: found.userId };
    }
  }
  // Link to a platform user with the same email in this org's membership, when there is one.
  let userId: string | null = null;
  if (c.email) {
    const [u] = await database
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(and(eq(schema.memberships.orgId, orgId), sql`lower(${schema.users.email}) = ${c.email.toLowerCase()}`))
      .limit(1);
    userId = u?.id ?? null;
  }
  const [row] = await database
    .insert(schema.contacts)
    .values({
      orgId,
      userId,
      name: c.name ?? null,
      email: c.email?.toLowerCase() ?? null,
      phone: c.phone ?? null,
      slackUserId: c.slackUserId ?? null,
    })
    .returning({ id: schema.contacts.id });
  return { id: row!.id, userId };
}

async function findOrCreateConversation(
  database: DB,
  input: Pick<IngestInput, "orgId" | "agentId" | "channel" | "threadKey" | "subject">,
  contactId: string | null,
): Promise<string> {
  await database
    .insert(schema.conversations)
    .values({
      orgId: input.orgId,
      agentId: input.agentId,
      channel: input.channel,
      externalThreadId: input.threadKey.slice(0, 500),
      contactId,
      subject: input.subject?.slice(0, 300) ?? null,
    })
    .onConflictDoNothing();
  const [conv] = await database
    .select({ id: schema.conversations.id, orgId: schema.conversations.orgId })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.agentId, input.agentId),
        eq(schema.conversations.channel, input.channel),
        eq(schema.conversations.externalThreadId, input.threadKey.slice(0, 500)),
      ),
    )
    .limit(1);
  if (!conv || conv.orgId !== input.orgId) throw new Error("conversation resolution failed");
  return conv.id;
}

class DuplicateMessage extends Error {}

async function priorMessage(database: DB, orgId: string, externalId: string) {
  const [prior] = await database
    .select({ id: schema.messages.id, conversationId: schema.messages.conversationId })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.externalId, externalId.slice(0, 300))))
    .limit(1);
  return prior ?? null;
}

/**
 * Store an inbound message exactly once. Safe to call repeatedly with the same input: a duplicate makes no
 * writes at all (no stray contacts/conversations) and returns the original message and its conversation.
 */
export async function ingestInbound(database: DB, input: IngestInput): Promise<IngestResult> {
  const existing = await priorMessage(database, input.orgId, input.externalId);
  if (existing) return { conversationId: existing.conversationId, messageId: existing.id, duplicate: true };
  try {
    return await database.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      const contact = await findOrCreateContact(tx, input.orgId, input.contact);
      const contactId = contact.id;
      let conversationId = input.conversationId ?? null;
      if (conversationId) {
        const [ok] = await tx
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, input.orgId), eq(schema.conversations.agentId, input.agentId)))
          .limit(1);
        if (!ok) conversationId = null;
      }
      conversationId ??= await findOrCreateConversation(tx, input, contactId);

      const inserted = await tx
        .insert(schema.messages)
        .values({
          orgId: input.orgId,
          conversationId,
          direction: "inbound",
          author: "contact",
          body: input.body.slice(0, MAX_BODY) || "(empty message)",
          externalId: input.externalId.slice(0, 300),
          meta: {
            ...input.meta,
            contactId,
            senderAuth: input.senderAuth,
            // Only an authenticated sender may be identified as a platform member.
            senderUserId: input.senderAuth === "pass" ? contact.userId : null,
          },
          deliveryStatus: "received",
        })
        .onConflictDoNothing()
        .returning({ id: schema.messages.id });
      const messageId = inserted[0]?.id;
      if (!messageId) throw new DuplicateMessage(); // lost a race: roll back everything written above

      await tx
        .update(schema.conversations)
        .set({ lastMessageAt: new Date(), contactId: sql`coalesce(${schema.conversations.contactId}, ${contactId}::uuid)` })
        .where(eq(schema.conversations.id, conversationId));

      return { conversationId, messageId, duplicate: false };
    });
  } catch (err) {
    if (!(err instanceof DuplicateMessage)) throw err;
    const prior = await priorMessage(database, input.orgId, input.externalId);
    if (!prior) throw err;
    return { conversationId: prior.conversationId, messageId: prior.id, duplicate: true };
  }
}

/** Inbound volume caps (cost DoS, SMS pumping, reply loops): per sender per agent, and per agent. */
export const INBOUND_LIMITS = { perSenderPerHour: 20, perAgentPerHour: 300 } as const;

async function inboundThrottled(agentId: string, messageId: string, database: DB): Promise<boolean> {
  const [msg] = await database.select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, messageId)).limit(1);
  const sender = typeof msg?.meta.contactId === "string" ? msg.meta.contactId : "unknown";
  const perSender = await rateLimit(`inbound:sender:${agentId}:${sender}`, INBOUND_LIMITS.perSenderPerHour, 3600);
  const perAgent = perSender.ok ? await rateLimit(`inbound:agent:${agentId}`, INBOUND_LIMITS.perAgentPerHour, 3600) : perSender;
  if (perSender.ok && perAgent.ok) return false;
  const reason = perSender.ok ? "agent" : "sender";
  await database
    .update(schema.messages)
    .set({ meta: sql`${schema.messages.meta} || ${JSON.stringify({ throttled: reason })}::jsonb` })
    .where(eq(schema.messages.id, messageId));
  logger.warn({ agentId, messageId, reason }, "inbound: volume cap reached; stored without waking the agent");
  return true;
}

const EVENT_FOR: Partial<Record<ChannelKind, "email.received" | "sms.received" | "slack.message">> = {
  email: "email.received",
  sms: "sms.received",
  slack: "slack.message",
};

/**
 * Store + wake: ingest the message, then (once per message) ask the engine for a reply run and fire any
 * event-triggered workflows. Crash-safe: if the process dies after the message commit, the retried
 * inbound.process job finds the stored message, sees no run for it yet, and starts it then.
 */
export async function ingestAndWake(
  database: DB,
  input: IngestInput,
  hooks: {
    /** Runs after the message is stored and before the agent wakes (attachments). Errors are logged, not thrown. */
    afterStore?: (r: { messageId: string; conversationId: string; throttled: boolean }) => Promise<void>;
  } = {},
): Promise<IngestResult & { runId: string | null }> {
  const res = await ingestInbound(database, input);
  if (!res.messageId) return { ...res, runId: null };
  const throttled = input.triggerAgent && !res.duplicate ? await inboundThrottled(input.agentId, res.messageId, database) : false;
  if (hooks.afterStore) {
    await hooks
      .afterStore({ messageId: res.messageId, conversationId: res.conversationId, throttled })
      .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.name : "unknown" }, "inbound: afterStore hook failed"));
  }
  if (!input.triggerAgent || throttled) return { ...res, runId: null };
  const [prior] = await database
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.orgId, input.orgId),
        eq(schema.runs.conversationId, res.conversationId),
        sql`${schema.runs.input}->>'messageId' = ${res.messageId}`,
      ),
    )
    .limit(1);
  if (prior) return { ...res, runId: prior.id };
  const { runId } = await engine.startConversationRun({
    orgId: input.orgId,
    agentId: input.agentId,
    conversationId: res.conversationId,
    messageId: res.messageId,
  });
  const event = EVENT_FOR[input.channel];
  if (event) {
    await engine
      .triggerEvent({ orgId: input.orgId, agentId: input.agentId, event, payload: { conversationId: res.conversationId, messageId: res.messageId }, dedupeKey: res.messageId })
      .catch((err: unknown) => logger.warn({ error: err instanceof Error ? err.message : String(err) }, "inbound: triggerEvent failed"));
  }
  return { ...res, runId };
}

// ── Email (Resend) ──────────────────────────────────────────────────────────

type ResendEvent = { type?: string; created_at?: string; data?: Record<string, unknown> };

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function addrList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").slice(0, 50);
  if (typeof v === "string") return v.slice(0, 20_000).split(",").slice(0, 50).map((s) => s.trim());
  return [];
}

/** Read a header from Resend's headers (object map or [{name,value}] array), case-insensitively; capped. */
function header(headers: unknown, name: string): string | null {
  const v = headerRaw(headers, name);
  return v === null ? null : v.slice(0, 8192);
}

function headerRaw(headers: unknown, name: string): string | null {
  const n = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && typeof h === "object" && String((h as { name?: unknown }).name ?? "").toLowerCase() === n) {
        return str((h as { value?: unknown }).value);
      }
    }
    return null;
  }
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === n) return Array.isArray(v) ? str(v[0]) : str(v);
    }
  }
  return null;
}

async function agentForRecipients(database: DB, recipients: string[]): Promise<Agent | null> {
  const domain = env().EMAIL_DOMAIN.toLowerCase();
  const handles: string[] = [];
  for (const r of recipients) {
    const a = parseAddress(r);
    if (!a) continue;
    const [local, dom] = a.email.split("@");
    if (!local || dom !== domain) continue;
    handles.push(local.split("+")[0]!);
  }
  if (!handles.length) return null;
  const rows = await database
    .select()
    .from(schema.agents)
    .where(and(inArray(sql`lower(${schema.agents.emailHandle})`, handles), ne(schema.agents.status, "archived")))
    .limit(5);
  // Prefer the first addressed handle.
  for (const h of handles) {
    const hit = rows.find((r) => r.emailHandle?.toLowerCase() === h);
    if (hit) return hit;
  }
  return null;
}

async function threadEmail(
  database: DB,
  agent: Agent,
  ids: string[],
  senderEmail: string,
  subject: string | null,
): Promise<string | null> {
  if (ids.length) {
    const [hit] = await database
      .select({ conversationId: schema.messages.conversationId })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
      .where(
        and(
          eq(schema.messages.orgId, agent.orgId),
          eq(schema.conversations.agentId, agent.id),
          eq(schema.conversations.channel, "email"),
          inArray(sql`${schema.messages.meta}->>'emailMessageId'`, ids),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (hit) return hit.conversationId;
    const [root] = await database
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.agentId, agent.id),
          eq(schema.conversations.channel, "email"),
          inArray(schema.conversations.externalThreadId, ids),
        ),
      )
      .limit(1);
    if (root) return root.id;
  }
  // Fallback: same sender + same normalized subject within 30 days.
  const norm = normalizeSubject(subject);
  if (!norm) return null;
  const recent = await database
    .select({ id: schema.conversations.id, subject: schema.conversations.subject })
    .from(schema.conversations)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.conversations.contactId))
    .where(
      and(
        eq(schema.conversations.agentId, agent.id),
        eq(schema.conversations.channel, "email"),
        sql`lower(${schema.contacts.email}) = ${senderEmail}`,
        sql`${schema.conversations.lastMessageAt} > now() - interval '30 days'`,
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(25);
  return recent.find((c) => normalizeSubject(c.subject) === norm)?.id ?? null;
}

const DELIVERY_STATUS: Record<string, "sent" | "delivered" | "failed"> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "failed",
  "email.complained": "failed",
  "email.failed": "failed",
};

export async function processResendEvent(database: DB, event: ResendEvent): Promise<string> {
  const data = event.data ?? {};
  const type = event.type ?? "";

  const status = DELIVERY_STATUS[type];
  if (status) {
    const emailId = str(data.email_id);
    if (!emailId) return "ignored:no-id";
    const fields: Record<string, unknown> = { deliveryStatus: status };
    if (status === "failed") fields.meta = sql`${schema.messages.meta} || ${JSON.stringify({ deliveryEvent: type })}::jsonb`;
    await database
      .update(schema.messages)
      .set(fields)
      .where(
        and(
          or(eq(schema.messages.externalId, `email:${emailId}`), sql`${schema.messages.meta}->>'providerId' = ${`email:${emailId}`}`),
          eq(schema.messages.direction, "outbound"),
          // Never move a message backwards (delivered → sent).
          status === "sent" ? eq(schema.messages.deliveryStatus, "pending") : sql`true`,
        ),
      );
    return `status:${status}`;
  }

  if (type !== "email.received") return "ignored:type";

  const emailId = str(data.email_id) ?? str(data.id);
  if (!emailId) return "ignored:no-id";

  // The webhook carries metadata; fetch the content when it's missing.
  let full: Record<string, unknown> = data;
  if (data.text === undefined && data.html === undefined) {
    const fetched = await fetchReceivedEmail(emailId);
    if (fetched) full = { ...data, ...fetched };
  }

  const recipients = [...addrList(full.to), ...addrList(full.cc)];
  const agent = await agentForRecipients(database, recipients);
  if (!agent) {
    logger.info({ emailId }, "inbound email: no agent for recipients");
    return "ignored:no-agent";
  }
  const from = parseAddress(str(full.from) ?? "");
  if (!from) return "ignored:bad-from";
  if (from.email.endsWith(`@${env().EMAIL_DOMAIN.toLowerCase()}`)) return "ignored:loop"; // agent ↔ agent mail loops

  const headers = full.headers;
  const messageIdHeader = parseMessageIds(str(full.message_id) ?? header(headers, "message-id"))[0] ?? null;
  const inReplyTo = parseMessageIds(header(headers, "in-reply-to") ?? str(full.in_reply_to));
  const references = parseMessageIds(header(headers, "references") ?? str(full.references));
  const isAuto = isAutomatedEmail(headers, from.email, header(headers, "content-type"));
  const senderAuth = emailSenderAuth(header(headers, "authentication-results"), from.email);

  const subject = str(full.subject)?.slice(0, 300) ?? null;
  // Both helpers cap their input before parsing (see email.ts); never feed unbounded HTML to regexes.
  const rawText = str(full.text)?.slice(0, MAX_TEXT) ?? (str(full.html) ? htmlToText(str(full.html)!) : "");
  const body = stripQuotedReply(rawText) || subject || "(empty message)";

  const ids = [...new Set([...inReplyTo, ...references])];
  const conversationId = await threadEmail(database, agent, ids, from.email, subject);
  const threadKey = references[0] ?? inReplyTo[0] ?? messageIdHeader ?? `resend:${emailId}`;

  // Attachment trust is decided before ingest creates/links the contact (see attachments.ts).
  const attachments = attachmentList(full.attachments);
  const filesTrusted = attachments.length > 0 && !isAuto ? await emailSenderTrustedForFiles(database, agent.orgId, from.email, senderAuth) : false;
  const externalId = `email:${emailId}`;

  const res = await ingestAndWake(database, {
    orgId: agent.orgId,
    agentId: agent.id,
    channel: "email",
    conversationId,
    threadKey,
    subject,
    contact: { email: from.email, name: from.name },
    body,
    externalId,
    meta: {
      emailMessageId: messageIdHeader,
      inReplyTo: inReplyTo[0] ?? null,
      references: [...references, ...(inReplyTo[0] && !references.includes(inReplyTo[0]) ? [inReplyTo[0]] : [])].slice(-20),
      subject,
      from: from.email,
      fromName: from.name,
      automated: isAuto || undefined,
      attachments: attachments.length,
    },
    triggerAgent: !isAuto && senderAuth !== "fail" && agent.status === "active",
    senderAuth,
  }, {
    afterStore: async ({ messageId, throttled }) => {
      if (attachments.length === 0) return;
      const outcomes = await processEmailAttachments(database, { orgId: agent.orgId, agentId: agent.id, emailId, sourceRef: externalId, attachments, trusted: filesTrusted, throttled });
      const note = attachmentNote(outcomes);
      await database
        .update(schema.messages)
        .set({
          body: sql`case when ${schema.messages.meta} ? 'files' then ${schema.messages.body} else ${schema.messages.body} || ${`\n\n${note}`} end`,
          meta: sql`${schema.messages.meta} || ${JSON.stringify({ files: outcomes, filesTrusted })}::jsonb`,
        })
        .where(and(eq(schema.messages.id, messageId), eq(schema.messages.orgId, agent.orgId)));
    },
  });
  return res.duplicate ? "duplicate" : "stored";
}

/**
 * Sender authentication verdict from the receiving MTA's Authentication-Results header (the topmost one, which
 * our provider adds). DMARC decides when present; otherwise an SPF or DKIM pass counts only when its domain
 * aligns with the From domain. Missing/neutral results are "none" (unverified), never "pass".
 * Set EMAIL_AUTHSERV_ID to only trust results stamped by your receiving MTA.
 */
export function emailSenderAuth(authResults: string | null, fromEmail: string): SenderAuth {
  if (!authResults) return "none";
  const r = authResults.slice(0, 4096).toLowerCase();
  const trusted = process.env.EMAIL_AUTHSERV_ID?.trim().toLowerCase();
  if (trusted) {
    const servId = r.split(";", 1)[0]!.trim().split(/\s/, 1)[0];
    if (servId !== trusted) return "none";
  }
  const fromDomain = fromEmail.split("@")[1] ?? "";
  const aligned = (d: string | undefined) => !!d && !!fromDomain && (d === fromDomain || d.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${d}`));
  const dmarc = /\bdmarc=([a-z]+)/.exec(r)?.[1];
  if (dmarc === "pass") return "pass";
  if (dmarc === "fail") return "fail";
  let dkimPass = false;
  for (const m of r.matchAll(/\bdkim=pass\b[^;]{0,300}?header\.(?:d|i)=@?([a-z0-9.-]{1,253})/g)) if (aligned(m[1]?.split("@").pop())) dkimPass = true;
  const spf = /\bspf=([a-z]+)/.exec(r)?.[1];
  const mailFrom = /smtp\.mailfrom=(?:[^@;\s]{0,64}@)?([a-z0-9.-]{1,253})/.exec(r)?.[1];
  if (dkimPass || (spf === "pass" && aligned(mailFrom))) return "pass";
  if ((spf === "fail" || spf === "softfail") && !/\bdkim=pass\b/.test(r)) return "fail";
  return "none";
}

const AUTO_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)([+._-]|@|$)/;

/** Auto-replies, bounces, lists and bulk mail never wake the agent (prevents reply loops and backscatter). */
export function isAutomatedEmail(headers: unknown, fromEmail: string, contentType: string | null): boolean {
  const autoSubmitted = (header(headers, "auto-submitted") ?? "no").trim().toLowerCase();
  if (autoSubmitted !== "no") return true;
  const precedence = (header(headers, "precedence") ?? "").trim().toLowerCase();
  if (["bulk", "junk", "list", "auto_reply"].includes(precedence)) return true;
  for (const h of ["x-autoreply", "x-autorespond", "x-auto-reply", "x-failed-recipients", "list-id", "list-unsubscribe", "feedback-id"]) {
    if (header(headers, h) !== null) return true;
  }
  const suppress = (header(headers, "x-auto-response-suppress") ?? "").toLowerCase();
  if (/\b(all|oof|autoreply)\b/.test(suppress)) return true;
  if ((header(headers, "return-path") ?? "").trim() === "<>") return true;
  if ((contentType ?? "").toLowerCase().includes("multipart/report")) return true;
  return AUTO_SENDER.test(fromEmail.split("@")[0] ?? "");
}

// ── SMS (Twilio) ────────────────────────────────────────────────────────────

export async function agentForNumber(database: DB, to: string): Promise<Agent | null> {
  const [direct] = await database
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.phoneNumber, to), ne(schema.agents.status, "archived")))
    .limit(1);
  if (direct) return direct;
  const [conn] = await database
    .select({ agent: schema.agents })
    .from(schema.channelConnections)
    .innerJoin(schema.agents, and(eq(schema.agents.id, schema.channelConnections.agentId), eq(schema.agents.orgId, schema.channelConnections.orgId)))
    .where(
      and(
        eq(schema.channelConnections.kind, "sms"),
        eq(schema.channelConnections.externalId, to),
        eq(schema.channelConnections.status, "connected"),
        ne(schema.agents.status, "archived"),
      ),
    )
    .limit(1);
  return conn?.agent ?? null;
}

const SMS_STATUS: Record<string, "sent" | "delivered" | "failed"> = { sent: "sent", delivered: "delivered", undelivered: "failed", failed: "failed" };

export async function processTwilioEvent(database: DB, params: Record<string, unknown>): Promise<string> {
  const sid = str(params.MessageSid) ?? str(params.SmsSid);
  const statusParam = str(params.MessageStatus);
  if (statusParam) {
    const status = SMS_STATUS[statusParam];
    if (!status || !sid) return "ignored:status";
    const key = `sms:${sid}`;
    await database
      .update(schema.messages)
      .set({ deliveryStatus: status })
      .where(
        and(
          eq(schema.messages.direction, "outbound"),
          or(eq(schema.messages.externalId, key), sql`${schema.messages.meta}->>'providerId' = ${key}`),
          status === "sent" ? eq(schema.messages.deliveryStatus, "pending") : sql`true`,
        ),
      );
    return `status:${status}`;
  }
  const from = str(params.From);
  const to = str(params.To);
  if (!sid || !from || !to || !E164_RE.test(from) || !E164_RE.test(to)) return "ignored:bad-params";
  const agent = await agentForNumber(database, to);
  if (!agent) return "ignored:no-agent";
  const body = (str(params.Body) ?? "").trim();
  const keyword = body.toLowerCase();
  const isStop = STOP_WORDS.has(keyword);
  const isStart = START_WORDS.has(keyword);

  const res = await ingestAndWake(database, {
    orgId: agent.orgId,
    agentId: agent.id,
    channel: "sms",
    threadKey: from,
    contact: { phone: from },
    body: body || "(empty message)",
    externalId: `sms:${sid}`,
    meta: { from, to, numMedia: Number(str(params.NumMedia) ?? 0) || 0, keyword: isStop ? "stop" : isStart ? "start" : undefined },
    triggerAgent: !isStop && !isStart && agent.status === "active",
    senderAuth: "pass", // reached us through a Twilio-signed webhook
  });
  if (!res.duplicate && (isStop || isStart)) {
    await database
      .update(schema.contacts)
      .set({ allowProactive: isStop ? "no" : "yes" })
      .where(and(eq(schema.contacts.orgId, agent.orgId), eq(schema.contacts.phone, from)));
  }
  return res.duplicate ? "duplicate" : "stored";
}

// ── Slack ───────────────────────────────────────────────────────────────────

type SlackEnvelope = { team_id?: string; event_id?: string; event?: Record<string, unknown> };

/** Events we act on: app mentions and direct messages from humans. */
export function isActionableSlackEvent(ev: Record<string, unknown> | undefined): boolean {
  if (!ev) return false;
  if (ev.bot_id || ev.subtype || ev.bot_profile) return false; // bot messages, edits, joins, deletions
  if (ev.type === "app_mention") return true;
  return ev.type === "message" && ev.channel_type === "im";
}

export async function processSlackEvent(database: DB, envelope: SlackEnvelope): Promise<string> {
  const ev = envelope.event;
  const teamId = envelope.team_id;
  if (!teamId || !ev || !isActionableSlackEvent(ev)) return "ignored:event";
  const channel = str(ev.channel);
  const ts = str(ev.ts);
  const user = str(ev.user);
  if (!channel || !ts || !user || !/^[A-Z0-9]{2,32}$/.test(channel) || !/^\d+\.\d+$/.test(ts)) return "ignored:bad-event";

  const [conn] = await database
    .select()
    .from(schema.channelConnections)
    .where(
      and(
        eq(schema.channelConnections.kind, "slack"),
        eq(schema.channelConnections.externalId, teamId),
        eq(schema.channelConnections.status, "connected"),
      ),
    )
    .limit(1);
  if (!conn) return "ignored:no-connection";
  const botUserId = typeof conn.config.botUserId === "string" && /^[A-Z0-9]+$/.test(conn.config.botUserId) ? conn.config.botUserId : null;
  if (botUserId && user === botUserId) return "ignored:self";

  const agentId = conn.agentId ?? (typeof conn.config.defaultAgentId === "string" ? conn.config.defaultAgentId : null);
  const agentConds = [eq(schema.agents.orgId, conn.orgId), eq(schema.agents.status, "active")];
  if (agentId) agentConds.push(eq(schema.agents.id, agentId));
  const [agent] = await database
    .select()
    .from(schema.agents)
    .where(and(...agentConds))
    .orderBy(schema.agents.createdAt)
    .limit(1);
  if (!agent) return "ignored:no-agent";

  const explicitThread = str(ev.thread_ts);
  const threadTs = explicitThread ?? ts;
  const isDm = ev.type === "message" && ev.channel_type === "im";
  // Channel mentions: one conversation per thread (reply in-thread). DMs: one running conversation per DM
  // channel unless the user replied inside a thread.
  const threadKey = isDm && !explicitThread ? channel : `${channel}:${threadTs}`;
  const text = stripMention(str(ev.text) ?? "", botUserId);
  const res = await ingestAndWake(database, {
    orgId: agent.orgId,
    agentId: agent.id,
    channel: "slack",
    threadKey,
    contact: { slackUserId: user },
    body: text || "(empty message)",
    externalId: `slack:${channel}:${ts}`,
    meta: { slack: { team: teamId, channel, ts, threadTs, user, type: ev.type } },
    triggerAgent: true,
    senderAuth: "pass", // signed event from the org's connected workspace
  });
  return res.duplicate ? "duplicate" : "stored";
}

/** Mark a webhook event processed (no-op if already). */
export async function markProcessed(database: DB, webhookEventId: string) {
  await database
    .update(schema.webhookEvents)
    .set({ processedAt: new Date() })
    .where(and(eq(schema.webhookEvents.id, webhookEventId), isNull(schema.webhookEvents.processedAt)));
}
