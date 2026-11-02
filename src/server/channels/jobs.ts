/**
 * Channel job handlers (owner: channels slice). Registered by the worker's job registry.
 *
 * channel.deliver payload: { orgId, agentId, channel: ChannelKind, messageId?: string, deliverableId?: string,
 *                           conversationId?: string, to?: string, subject?: string, text: string }
 *   - messageId: send that existing OUTBOUND message (engine inserted it with deliveryStatus "pending").
 *   - conversationId + text (no messageId): an outbound message is created in that conversation, then sent.
 *   - deliverableId (no messageId): deliver the deliverable on `channel` (to `to`, or the org's default
 *     recipients: owner/admin members' email/phone, Slack install channel). Appends to deliverables.deliveredVia.
 *   - "portal" | "api" | "mcp": nothing to push — success no-op (message marked sent).
 *   Suggested enqueue idempotencyKey: `deliver:<messageId>` or `deliver:<deliverableId>:<channel>`.
 *
 * inbound.process payload: { provider: "resend" | "twilio" | "slack", webhookEventId: string }
 *
 * Exactly-once-ish delivery: each send runs inside a transaction holding a row lock (SELECT … FOR UPDATE) on the
 * message, re-checks deliveryStatus, sends, and records the provider id — so concurrent or retried jobs never
 * double-send a recorded message. Email additionally passes a provider Idempotency-Key (message id), which
 * also covers a crash between send and commit. Permanent provider errors mark the message failed without retry;
 * transient ones throw so the queue retries with backoff.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { portalDeliverableUrl } from "@/server/api/v1";
import {
  agentAddress,
  agentFromName,
  formatFrom,
  isEmailAddress,
  newMessageId,
  ProviderError,
  replySubject,
  sendEmail,
  type SendResult,
} from "./email";
import { renderEmail } from "./email-render";
import { markProcessed, processResendEvent, processSlackEvent, processTwilioEvent } from "./inbound";
import { slackBotToken, slackPostMessage } from "./slack";
import { E164_RE, segmentSms, sendSms } from "./sms";
import { markdownToSlack } from "./text";

export type JobContext = { db: DB; jobId: string };

const channelKind = z.enum(["email", "sms", "slack", "api", "mcp", "portal"]);

const deliverPayload = z.object({
  orgId: z.uuid(),
  agentId: z.uuid(),
  channel: channelKind,
  messageId: z.uuid().optional(),
  deliverableId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  to: z.string().max(320).optional(),
  subject: z.string().max(300).optional(),
  text: z.string().max(100_000).optional().default(""),
});
type DeliverPayload = z.infer<typeof deliverPayload>;

/** Payload problems are permanent: log and drop rather than retrying forever. */
class PermanentJobError extends Error {}

type Org = typeof schema.organizations.$inferSelect;
type Agent = typeof schema.agents.$inferSelect;

async function loadOrgAgent(database: DB, orgId: string, agentId: string): Promise<{ org: Org; agent: Agent }> {
  const [row] = await database
    .select({ org: schema.organizations, agent: schema.agents })
    .from(schema.agents)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.agents.orgId))
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)))
    .limit(1);
  if (!row) throw new PermanentJobError("agent not found in org");
  return row;
}

const COST_MICROS = { email: 400, sms: 7900 } as const;

async function recordUsage(database: DB, org: Org, agentId: string, kind: "email" | "sms", quantity: number) {
  try {
    await database.insert(schema.usageEvents).values({
      orgId: org.id,
      agencyId: org.agencyId,
      agentId,
      kind,
      quantity,
      costMicros: COST_MICROS[kind] * quantity,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "channels: usage write failed");
  }
}

// ── Sending one outbound message ────────────────────────────────────────────

async function sendOne(
  tx: DB,
  ctx: { org: Org; agent: Agent; message: typeof schema.messages.$inferSelect; conversation: typeof schema.conversations.$inferSelect; payload: DeliverPayload },
): Promise<{ result: SendResult; meta: Record<string, unknown>; externalId: string | null; parts?: number }> {
  const { org, agent, message, conversation, payload } = ctx;
  const channel = conversation.channel;

  const contact = conversation.contactId
    ? (await tx.select().from(schema.contacts).where(and(eq(schema.contacts.id, conversation.contactId), eq(schema.contacts.orgId, org.id))).limit(1))[0]
    : undefined;

  let deliverable: typeof schema.deliverables.$inferSelect | undefined;
  if (message.deliverableId) {
    [deliverable] = await tx
      .select()
      .from(schema.deliverables)
      .where(and(eq(schema.deliverables.id, message.deliverableId), eq(schema.deliverables.orgId, org.id)))
      .limit(1);
  }
  const portalUrl = deliverable ? portalDeliverableUrl(org.slug, deliverable.id) : null;

  if (channel === "email") {
    if (!agent.emailHandle) throw new ProviderError("agent has no inbox handle", false);
    const to = payload.to && isEmailAddress(payload.to) ? payload.to : contact?.email;
    if (!to || !isEmailAddress(to)) throw new ProviderError("no email recipient", false);

    // Thread onto the latest message in this conversation that has a Message-ID.
    const [prev] = await tx
      .select({ meta: schema.messages.meta })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversation.id),
          sql`${schema.messages.meta}->>'emailMessageId' is not null`,
          sql`${schema.messages.id} <> ${message.id}`,
        ),
      )
      .orderBy(sql`${schema.messages.createdAt} desc`)
      .limit(1);
    const prevId = typeof prev?.meta.emailMessageId === "string" ? prev.meta.emailMessageId : null;
    const prevRefs = Array.isArray(prev?.meta.references) ? (prev!.meta.references as unknown[]).filter((r): r is string => typeof r === "string") : [];
    const references = prevId ? [...prevRefs.filter((r) => r !== prevId), prevId].slice(-20) : [];

    const messageId = typeof message.meta.emailMessageId === "string" ? message.meta.emailMessageId : newMessageId();
    const subject = deliverable
      ? payload.subject ?? deliverable.title
      : payload.subject ?? (typeof message.meta.subject === "string" ? message.meta.subject : replySubject(conversation.subject));
    const rendered = await renderEmail({
      title: deliverable?.title ?? null,
      preview: deliverable?.preview ?? null,
      markdown: deliverable ? deliverable.body : message.body,
      agentName: agent.name,
      agentRole: agent.role,
      orgName: org.branding.displayName ?? org.name,
      portalUrl,
      branding: org.branding,
    });
    const address = agentAddress(agent.emailHandle);
    const result = await sendEmail({
      from: formatFrom(agentFromName(agent.name, org.branding), address),
      to: [to],
      subject,
      text: rendered.text,
      html: rendered.html,
      replyTo: address,
      messageId,
      inReplyTo: prevId,
      references,
      idempotencyKey: `roster-msg-${message.id}`,
    });
    if (!result.simulated) await recordUsage(tx, org, agent.id, "email", 1);
    return {
      result,
      externalId: result.providerId ? `email:${result.providerId}` : null,
      meta: { emailMessageId: messageId, references, subject, to },
    };
  }

  if (channel === "sms") {
    const to = payload.to && E164_RE.test(payload.to) ? payload.to : contact?.phone ?? conversation.externalThreadId;
    if (!to || !E164_RE.test(to)) throw new ProviderError("no sms recipient", false);
    if (deliverable && contact?.allowProactive === "no") throw new ProviderError("recipient opted out (STOP)", false);
    const text = deliverable
      ? `${agent.name}: ${deliverable.title}${deliverable.preview ? `\n\n${deliverable.preview}` : ""}${portalUrl ? `\n\n${portalUrl}` : ""}`
      : message.body;
    const parts = segmentSms(text, portalUrl);
    if (!parts.length) throw new ProviderError("empty sms", false);
    let first: SendResult | null = null;
    for (const part of parts) {
      const r = await sendSms({ to, body: part, from: agent.phoneNumber });
      first ??= r;
    }
    if (!first!.simulated) await recordUsage(tx, org, agent.id, "sms", parts.length);
    return { result: first!, externalId: first!.providerId ? `sms:${first!.providerId}` : null, meta: { to, parts: parts.length }, parts: parts.length };
  }

  if (channel === "slack") {
    const [conn] = await tx
      .select()
      .from(schema.channelConnections)
      .where(and(eq(schema.channelConnections.orgId, org.id), eq(schema.channelConnections.kind, "slack"), eq(schema.channelConnections.status, "connected")))
      .limit(1);
    let target: string | null = null;
    let threadTs: string | null = null;
    const key = conversation.externalThreadId ?? "";
    const m = /^([A-Z0-9]{2,32}):(\d+\.\d+)$/.exec(key);
    if (m) {
      target = m[1]!;
      threadTs = m[2]!;
    } else {
      const slackMeta = message.meta.slack as { channel?: unknown } | undefined;
      target =
        (payload.to && /^[A-Z0-9]{2,32}$/.test(payload.to) ? payload.to : null) ??
        (typeof slackMeta?.channel === "string" ? slackMeta.channel : null) ??
        (typeof conn?.config.defaultChannelId === "string" ? conn.config.defaultChannelId : null);
    }
    if (!target) throw new ProviderError("no slack channel", false);
    if (!conn) throw new ProviderError("slack not connected", false);
    const token = await slackBotToken(org.id, conn.secretId);
    const text = deliverable
      ? `*${markdownToSlack(deliverable.title)}*${deliverable.preview ? `\n${markdownToSlack(deliverable.preview)}` : ""}${portalUrl ? `\n<${portalUrl}|View in portal>` : ""}`
      : markdownToSlack(message.body);
    const result = await slackPostMessage({ token, channel: target, text, threadTs });
    // A top-level post starts a thread: key the conversation by it so replies continue here.
    if (!threadTs && result.providerId) {
      await tx
        .update(schema.conversations)
        .set({ externalThreadId: `${target}:${result.providerId}` })
        .where(eq(schema.conversations.id, conversation.id));
    }
    return {
      result,
      externalId: result.providerId ? `slack:${target}:${result.providerId}` : null,
      meta: { slack: { channel: target, ts: result.providerId, threadTs: threadTs ?? result.providerId } },
    };
  }

  // portal / api / mcp: nothing to push.
  return { result: { providerId: null, simulated: false }, externalId: null, meta: {} };
}

/**
 * Deliver one outbound message under a row lock. Returns the final status.
 * Permanent failures are recorded on the message; transient failures are recorded and re-thrown.
 */
export async function deliverMessage(database: DB, payload: DeliverPayload, messageId: string): Promise<"sent" | "skipped" | "failed"> {
  const { org, agent } = await loadOrgAgent(database, payload.orgId, payload.agentId);
  let transient: unknown = null;
  const outcome = await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const [message] = await tx
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.orgId, org.id)))
      .for("update")
      .limit(1);
    if (!message) throw new PermanentJobError("message not found");
    if (message.direction !== "outbound") throw new PermanentJobError("message is not outbound");
    if (message.deliveryStatus === "sent" || message.deliveryStatus === "delivered") return "skipped" as const;
    const [conversation] = await tx
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, message.conversationId), eq(schema.conversations.orgId, org.id)))
      .limit(1);
    if (!conversation || conversation.agentId !== agent.id) throw new PermanentJobError("conversation mismatch");

    try {
      const out = await sendOne(tx, { org, agent, message, conversation, payload });
      await tx
        .update(schema.messages)
        .set({
          deliveryStatus: "sent",
          // Keep an existing idempotency key (deliver:/job:) stable; the provider id always goes in meta.
          externalId: message.externalId ?? out.externalId,
          meta: {
            ...message.meta,
            ...out.meta,
            providerId: out.externalId ?? undefined,
            simulated: out.result.simulated || undefined,
            sentAt: new Date().toISOString(),
            lastError: undefined,
          },
        })
        .where(eq(schema.messages.id, message.id));
      if (out.result.simulated) {
        logger.info({ messageId: message.id, channel: conversation.channel }, "channels: delivered in simulated mode");
      }
      return "sent" as const;
    } catch (err) {
      const permanent = err instanceof ProviderError ? !err.retryable : false;
      const msg = err instanceof Error ? err.message.slice(0, 300) : "send failed";
      await tx
        .update(schema.messages)
        .set({ deliveryStatus: "failed", meta: { ...message.meta, lastError: msg, failedAt: new Date().toISOString() } })
        .where(eq(schema.messages.id, message.id));
      if (!permanent) transient = err;
      logger.warn({ messageId: message.id, channel: conversation.channel, permanent, error: msg }, "channels: delivery failed");
      return "failed" as const;
    }
  });
  if (transient) throw transient;
  return outcome;
}

// ── Deliverables ────────────────────────────────────────────────────────────

async function defaultRecipients(database: DB, orgId: string, channel: "email" | "sms"): Promise<string[]> {
  const rows = await database
    .select({ email: schema.users.email, phone: schema.users.phone })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.role, ["owner", "admin"])))
    .limit(10);
  const vals = rows.map((r) => (channel === "email" ? r.email?.toLowerCase() : r.phone)).filter((v): v is string => !!v);
  return [...new Set(vals)].filter((v) => (channel === "email" ? isEmailAddress(v) : E164_RE.test(v)));
}

async function ensureContact(database: DB, orgId: string, c: { email?: string; phone?: string }): Promise<string> {
  const cond = c.email ? sql`lower(${schema.contacts.email}) = ${c.email.toLowerCase()}` : eq(schema.contacts.phone, c.phone!);
  const [found] = await database
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), cond))
    .limit(1);
  if (found) return found.id;
  const [row] = await database
    .insert(schema.contacts)
    .values({ orgId, email: c.email?.toLowerCase() ?? null, phone: c.phone ?? null })
    .returning({ id: schema.contacts.id });
  return row!.id;
}

/** Find or create the conversation + outbound message that carries a deliverable to one recipient. */
async function deliverableMessage(
  database: DB,
  input: { org: Org; agent: Agent; deliverable: typeof schema.deliverables.$inferSelect; channel: "email" | "sms" | "slack"; recipient: string },
): Promise<string> {
  const { org, agent, deliverable, channel, recipient } = input;
  let contactId: string | null = null;
  let threadKey: string;
  if (channel === "email") {
    contactId = await ensureContact(database, org.id, { email: recipient });
    threadKey = `deliverable:${deliverable.id}:${contactId}`;
  } else if (channel === "sms") {
    contactId = await ensureContact(database, org.id, { phone: recipient });
    threadKey = recipient; // continue the contact's SMS thread
  } else {
    threadKey = `deliverable:${deliverable.id}:${recipient}`;
  }
  await database
    .insert(schema.conversations)
    .values({ orgId: org.id, agentId: agent.id, channel, externalThreadId: threadKey, contactId, subject: deliverable.title.slice(0, 300) })
    .onConflictDoNothing();
  const [conv] = await database
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.agentId, agent.id), eq(schema.conversations.channel, channel), eq(schema.conversations.externalThreadId, threadKey)))
    .limit(1);
  if (!conv) throw new Error("conversation create failed");
  const [existing] = await database
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conv.id),
        eq(schema.messages.deliverableId, deliverable.id),
        eq(schema.messages.direction, "outbound"),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [msg] = await database
    .insert(schema.messages)
    .values({
      orgId: org.id,
      conversationId: conv.id,
      direction: "outbound",
      author: "agent",
      body: deliverable.preview ?? deliverable.title,
      deliverableId: deliverable.id,
      runId: deliverable.runId,
      // Deliverable delivery: key the message for idempotency (one per deliverable × channel × recipient).
      externalId: `deliver:${deliverable.id}:${channel}:${recipient}`.slice(0, 300),
      meta: channel === "slack" ? { slack: { channel: recipient } } : {},
      deliveryStatus: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });
  if (msg) return msg.id;
  const [again] = await database
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, org.id), eq(schema.messages.externalId, `deliver:${deliverable.id}:${channel}:${recipient}`.slice(0, 300))))
    .limit(1);
  if (!again) throw new Error("deliverable message create failed");
  return again.id;
}

async function markDeliveredVia(database: DB, orgId: string, deliverableId: string, channel: string) {
  await database
    .update(schema.deliverables)
    .set({
      deliveredVia: sql`case when ${schema.deliverables.deliveredVia} @> ${JSON.stringify([channel])}::jsonb
        then ${schema.deliverables.deliveredVia} else ${schema.deliverables.deliveredVia} || ${JSON.stringify([channel])}::jsonb end`,
    })
    .where(and(eq(schema.deliverables.id, deliverableId), eq(schema.deliverables.orgId, orgId)));
}

async function deliverDeliverable(database: DB, payload: DeliverPayload, deliverableId: string) {
  const { org, agent } = await loadOrgAgent(database, payload.orgId, payload.agentId);
  const [deliverable] = await database
    .select()
    .from(schema.deliverables)
    .where(and(eq(schema.deliverables.id, deliverableId), eq(schema.deliverables.orgId, org.id), eq(schema.deliverables.agentId, agent.id)))
    .limit(1);
  if (!deliverable) throw new PermanentJobError("deliverable not found");
  const channel = payload.channel;
  if (channel === "portal" || channel === "api" || channel === "mcp") {
    await markDeliveredVia(database, org.id, deliverable.id, channel);
    return;
  }

  let recipients: string[];
  if (channel === "slack") {
    const [conn] = await database
      .select({ config: schema.channelConnections.config })
      .from(schema.channelConnections)
      .where(and(eq(schema.channelConnections.orgId, org.id), eq(schema.channelConnections.kind, "slack"), eq(schema.channelConnections.status, "connected")))
      .limit(1);
    const target = payload.to && /^[A-Z0-9]{2,32}$/.test(payload.to) ? payload.to : typeof conn?.config.defaultChannelId === "string" ? conn.config.defaultChannelId : null;
    recipients = target ? [target] : [];
  } else if (payload.to) {
    const ok = channel === "email" ? isEmailAddress(payload.to.toLowerCase()) : E164_RE.test(payload.to);
    recipients = ok ? [channel === "email" ? payload.to.toLowerCase() : payload.to] : [];
  } else {
    recipients = await defaultRecipients(database, org.id, channel);
  }
  if (!recipients.length) {
    logger.warn({ deliverableId: deliverable.id, channel }, "channels: no recipients for deliverable; skipping");
    return;
  }

  let sentAny = false;
  let firstTransient: unknown = null;
  for (const r of recipients) {
    const messageId = await deliverableMessage(database, { org, agent, deliverable, channel, recipient: r });
    try {
      const status = await deliverMessage(database, { ...payload, to: r }, messageId);
      if (status !== "failed") sentAny = true;
    } catch (err) {
      firstTransient ??= err;
    }
  }
  if (sentAny) await markDeliveredVia(database, org.id, deliverable.id, channel);
  if (firstTransient) throw firstTransient; // retry: already-sent recipients are skipped by status
}

export async function channelDeliver(rawPayload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  const parsed = deliverPayload.safeParse(rawPayload);
  if (!parsed.success) {
    logger.error({ jobId: ctx.jobId, issues: parsed.error.issues.slice(0, 3) }, "channel.deliver: invalid payload; dropping");
    return;
  }
  const payload = parsed.data;
  const database = ctx.db;
  try {
    if (payload.messageId) {
      await deliverMessage(database, payload, payload.messageId);
      return;
    }
    if (payload.deliverableId) {
      await deliverDeliverable(database, payload, payload.deliverableId);
      return;
    }
    if (payload.conversationId && payload.text) {
      const { org, agent } = await loadOrgAgent(database, payload.orgId, payload.agentId);
      const [conv] = await database
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.id, payload.conversationId), eq(schema.conversations.orgId, org.id), eq(schema.conversations.agentId, agent.id)))
        .limit(1);
      if (!conv) throw new PermanentJobError("conversation not found");
      // Job-scoped idempotency: a retried job reuses the same message instead of creating a second one.
      const externalId = `job:${ctx.jobId}`;
      await database
        .insert(schema.messages)
        .values({
          orgId: org.id,
          conversationId: conv.id,
          direction: "outbound",
          author: "agent",
          body: payload.text,
          externalId,
          meta: payload.subject ? { subject: payload.subject } : {},
          deliveryStatus: "pending",
        })
        .onConflictDoNothing();
      const [msg] = await database
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(and(eq(schema.messages.orgId, org.id), eq(schema.messages.externalId, externalId)))
        .limit(1);
      if (!msg) throw new Error("message create failed");
      await deliverMessage(database, payload, msg.id);
      return;
    }
    logger.error({ jobId: ctx.jobId }, "channel.deliver: nothing to deliver (need messageId, deliverableId or conversationId+text)");
  } catch (err) {
    if (err instanceof PermanentJobError) {
      logger.error({ jobId: ctx.jobId, error: err.message }, "channel.deliver: permanent failure; dropping");
      return;
    }
    throw err;
  }
}

// ── Inbound ─────────────────────────────────────────────────────────────────

const inboundPayload = z.object({ provider: z.enum(["resend", "twilio", "slack"]), webhookEventId: z.uuid() });

export async function inboundProcess(rawPayload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  const parsed = inboundPayload.safeParse(rawPayload);
  if (!parsed.success) {
    logger.error({ jobId: ctx.jobId }, "inbound.process: invalid payload; dropping");
    return;
  }
  const { provider, webhookEventId } = parsed.data;
  const database = ctx.db;
  const [event] = await database
    .select()
    .from(schema.webhookEvents)
    .where(and(eq(schema.webhookEvents.id, webhookEventId), eq(schema.webhookEvents.provider, provider)))
    .limit(1);
  if (!event) {
    logger.warn({ webhookEventId }, "inbound.process: event not found");
    return;
  }
  if (event.processedAt) return;

  let outcome: string;
  if (provider === "resend") outcome = await processResendEvent(database, event.payload);
  else if (provider === "twilio") outcome = await processTwilioEvent(database, event.payload);
  else outcome = await processSlackEvent(database, event.payload);

  await markProcessed(database, event.id);
  logger.info({ provider, webhookEventId, outcome, env: env().NODE_ENV }, "inbound.process: done");
}
