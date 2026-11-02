/**
 * Inbound processing (worker): webhook_events row → agent, contact, conversation, idempotent message,
 * and one `agent.run` job per new message.
 *
 * agent.run payload: { orgId, agentId, conversationId, messageId, trigger: "message" }
 */
import "server-only";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import type { ChannelKind } from "@/server/db/schema";
import { env } from "@/server/env";
import { enqueue } from "@/server/jobs/queue";
import { logger } from "@/server/lib/logger";
import { fetchReceivedEmail, htmlToText, normalizeSubject, parseAddress, parseMessageIds, stripQuotedReply } from "./email";
import { E164_RE, START_WORDS, STOP_WORDS } from "./sms";
import { stripMention } from "./slack";

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
};

export type IngestResult = { conversationId: string; messageId: string | null; duplicate: boolean; jobId: string | null };

async function findOrCreateContact(database: DB, orgId: string, c: IngestInput["contact"]): Promise<string> {
  const cond = c.email
    ? sql`lower(${schema.contacts.email}) = ${c.email.toLowerCase()}`
    : c.phone
      ? eq(schema.contacts.phone, c.phone)
      : c.slackUserId
        ? eq(schema.contacts.slackUserId, c.slackUserId)
        : null;
  if (cond) {
    const [found] = await database
      .select({ id: schema.contacts.id, name: schema.contacts.name })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), cond))
      .orderBy(schema.contacts.createdAt)
      .limit(1);
    if (found) {
      if (!found.name && c.name) await database.update(schema.contacts).set({ name: c.name }).where(eq(schema.contacts.id, found.id));
      return found.id;
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
  return row!.id;
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

/** Store an inbound message exactly once and wake the agent. Safe to call repeatedly with the same input. */
export async function ingestInbound(database: DB, input: IngestInput): Promise<IngestResult> {
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const contactId = await findOrCreateContact(tx, input.orgId, input.contact);
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
        meta: { ...input.meta, contactId },
        deliveryStatus: "received",
      })
      .onConflictDoNothing()
      .returning({ id: schema.messages.id });
    const messageId = inserted[0]?.id ?? null;
    if (!messageId) return { conversationId, messageId: null, duplicate: true, jobId: null };

    await tx
      .update(schema.conversations)
      .set({ lastMessageAt: new Date(), contactId: sql`coalesce(${schema.conversations.contactId}, ${contactId}::uuid)` })
      .where(eq(schema.conversations.id, conversationId));

    let jobId: string | null = null;
    if (input.triggerAgent) {
      jobId = await enqueue(
        tx,
        "agent.run",
        { orgId: input.orgId, agentId: input.agentId, conversationId, messageId, trigger: "message" },
        { orgId: input.orgId, idempotencyKey: `agent.run:message:${messageId}`, priority: 10 },
      );
    }
    return { conversationId, messageId, duplicate: false, jobId };
  });
}

// ── Email (Resend) ──────────────────────────────────────────────────────────

type ResendEvent = { type?: string; created_at?: string; data?: Record<string, unknown> };

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function addrList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.split(",").map((s) => s.trim());
  return [];
}

/** Read a header from Resend's headers (object map or [{name,value}] array), case-insensitively. */
function header(headers: unknown, name: string): string | null {
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
  const autoSubmitted = (header(headers, "auto-submitted") ?? "no").toLowerCase();
  const precedence = (header(headers, "precedence") ?? "").toLowerCase();
  const isAuto = autoSubmitted !== "no" || ["bulk", "junk", "auto_reply", "list"].includes(precedence);

  const subject = str(full.subject)?.slice(0, 300) ?? null;
  const rawText = str(full.text) ?? (str(full.html) ? htmlToText(str(full.html)!) : "");
  const body = stripQuotedReply(rawText) || subject || "(empty message)";

  const ids = [...new Set([...inReplyTo, ...references])];
  const conversationId = await threadEmail(database, agent, ids, from.email, subject);
  const threadKey = references[0] ?? inReplyTo[0] ?? messageIdHeader ?? `resend:${emailId}`;

  const res = await ingestInbound(database, {
    orgId: agent.orgId,
    agentId: agent.id,
    channel: "email",
    conversationId,
    threadKey,
    subject,
    contact: { email: from.email, name: from.name },
    body,
    externalId: `email:${emailId}`,
    meta: {
      emailMessageId: messageIdHeader,
      inReplyTo: inReplyTo[0] ?? null,
      references: [...references, ...(inReplyTo[0] && !references.includes(inReplyTo[0]) ? [inReplyTo[0]] : [])].slice(-20),
      subject,
      from: from.email,
      fromName: from.name,
      autoSubmitted: isAuto || undefined,
      attachments: Array.isArray(full.attachments) ? full.attachments.length : 0,
    },
    triggerAgent: !isAuto && agent.status === "active",
  });
  return res.duplicate ? "duplicate" : "stored";
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

export async function processTwilioEvent(database: DB, params: Record<string, unknown>): Promise<string> {
  const sid = str(params.MessageSid) ?? str(params.SmsSid);
  const from = str(params.From);
  const to = str(params.To);
  if (!sid || !from || !to || !E164_RE.test(from) || !E164_RE.test(to)) return "ignored:bad-params";
  const agent = await agentForNumber(database, to);
  if (!agent) return "ignored:no-agent";
  const body = (str(params.Body) ?? "").trim();
  const keyword = body.toLowerCase();
  const isStop = STOP_WORDS.has(keyword);
  const isStart = START_WORDS.has(keyword);

  const res = await ingestInbound(database, {
    orgId: agent.orgId,
    agentId: agent.id,
    channel: "sms",
    threadKey: from,
    contact: { phone: from },
    body: body || "(empty message)",
    externalId: `sms:${sid}`,
    meta: { from, to, numMedia: Number(str(params.NumMedia) ?? 0) || 0, keyword: isStop ? "stop" : isStart ? "start" : undefined },
    triggerAgent: !isStop && !isStart && agent.status === "active",
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

  const threadTs = str(ev.thread_ts) ?? ts;
  const text = stripMention(str(ev.text) ?? "", botUserId);
  const res = await ingestInbound(database, {
    orgId: agent.orgId,
    agentId: agent.id,
    channel: "slack",
    threadKey: `${channel}:${threadTs}`,
    contact: { slackUserId: user },
    body: text || "(empty message)",
    externalId: `slack:${channel}:${ts}`,
    meta: { slack: { team: teamId, channel, ts, threadTs, user, type: ev.type } },
    triggerAgent: true,
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
