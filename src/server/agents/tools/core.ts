/**
 * Core agent tools: knowledge, memory, deliverables, messaging, approvals, follow-ups.
 * Every query is scoped by ctx.run.orgId / ctx.agent.id.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { truncate } from "@/server/llm/text";
import { recallMemories, searchKnowledge } from "@/server/knowledge";
import { sha256 } from "@/server/security/crypto";
import { normalizePhone, type Participant } from "../trust";
import { defineTool, ok, toolError, type ToolContext } from "./types";

const DELIVERABLE_KINDS = ["report", "document", "table", "email_draft", "message"] as const;

export const knowledgeSearch = defineTool({
  name: "knowledge_search",
  description:
    "Search this business's knowledge base (discovery call transcript, documents, catalogs, SOPs, URLs) and return the most relevant passages. Use it before writing anything factual.",
  schema: z.object({ query: z.string().min(2).max(500), limit: z.number().int().min(1).max(10).optional() }),
  async run(input, ctx) {
    const hits = await searchKnowledge(ctx.db, {
      orgId: ctx.run.orgId,
      agentId: ctx.agent.id,
      query: input.query,
      limit: input.limit ?? 5,
      // The discovery call is internal: never surface it in work done for an unverified sender.
      excludeKinds: ctx.trust.trusted ? [] : ["transcript"],
    });
    return ok({ results: hits.map((h) => ({ title: h.title, content: truncate(h.content, 1500), score: Number(h.score.toFixed(4)) })) });
  },
});

export const memoryRecall = defineTool({
  name: "memory_recall",
  description: "Recall facts, preferences, people and past episodes you have saved about this business, ranked by relevance, importance and recency.",
  schema: z.object({ query: z.string().max(500).optional(), limit: z.number().int().min(1).max(20).optional() }),
  async run(input, ctx) {
    const hits = await recallMemories(ctx.db, { orgId: ctx.run.orgId, agentId: ctx.agent.id, query: input.query, limit: input.limit ?? 8 });
    return ok({ results: hits.map((h) => ({ kind: h.kind, content: h.content, importance: h.importance })) });
  },
});

export const memorySave = defineTool({
  name: "memory_save",
  description:
    "Save something durable you learned (a fact, a preference, a person, or an episode worth remembering). Keep it to one specific sentence.",
  schema: z.object({
    content: z.string().min(3).max(500),
    kind: z.enum(["fact", "preference", "person", "episode"]).optional(),
    importance: z.number().int().min(1).max(5).optional(),
  }),
  // Payment details (bank, IBAN, routing/account numbers, "pay to" changes) are a fraud vector: never saved silently.
  approvalAction: (input) => (mentionsPaymentDetails(input.content) ? "change_payment_details" : null),
  describe: (i) => `Remember: “${truncate(i.content, 240)}”`,
  async run(input, ctx) {
    const existing = await ctx.db
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(and(eq(schema.memories.orgId, ctx.run.orgId), eq(schema.memories.agentId, ctx.agent.id), eq(schema.memories.content, input.content)))
      .limit(1);
    if (existing[0]) return ok({ saved: true, id: existing[0].id, duplicate: true });
    const [row] = await ctx.db
      .insert(schema.memories)
      .values({
        orgId: ctx.run.orgId,
        agentId: ctx.agent.id,
        kind: input.kind ?? "fact",
        content: input.content,
        importance: input.importance ?? 3,
        // Learned from an email/SMS conversation: kept out of prompts and recall until a member confirms it.
        source: memoryNeedsConfirmation(ctx) ? UNCONFIRMED_MEMORY_SOURCE : `run:${ctx.run.id}`,
      })
      .returning({ id: schema.memories.id });
    return ok({ saved: true, id: row?.id, ...(memoryNeedsConfirmation(ctx) ? { pendingConfirmation: true } : {}) });
  },
});

/** memories.source for facts learned over email/SMS that a member has not confirmed yet (see knowledge.recallMemories). */
export const UNCONFIRMED_MEMORY_SOURCE = "unconfirmed";

/** Email and SMS senders can be spoofed, so what a message-triggered run learns there is held for confirmation. */
function memoryNeedsConfirmation(ctx: ToolContext): boolean {
  if (ctx.run.input?.kind !== "message") return false;
  const channel = ctx.trust.participant?.channel;
  return channel === "email" || channel === "sms";
}

const PAYMENT_RE =
  /\b(?:iban|swift(?: code)?|bic(?: code)?|routing (?:number|no)|aba (?:number|routing)|sort code|bank (?:account|details|info(?:rmation)?|transfer|wire)|wire (?:transfer|instructions|details)|ach (?:transfer|details|payment)|remit(?:tance)? (?:to|address|details)|payment (?:details|instructions|info(?:rmation)?))\b|\b(?:pay|paid|payments?|invoices?|deposit)\b[^.\n]{0,40}\b(?:to|into) (?:account|our new account|the new account|a new account)\b|\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}\b|\baccount (?:number|no\.?|#)\D{0,6}\d{4,}/i;

/** Does this text carry bank/payment details or a change of where money goes? */
export function mentionsPaymentDetails(text: string): boolean {
  return PAYMENT_RE.test(text.slice(0, 5_000));
}

export const createDeliverable = defineTool({
  name: "create_deliverable",
  description:
    "Deliver finished work to the client (it appears in their portal and is sent to their delivery channels). Body is markdown; GFM tables are allowed. Lead with the result.",
  schema: z.object({
    title: z.string().min(2).max(160),
    kind: z.enum(DELIVERABLE_KINDS).optional(),
    body: z.string().min(1).max(200_000),
    preview: z.string().max(280).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  async run(input, ctx) {
    const { db, run, agent } = ctx;
    // Idempotent per run+title so a retried run never double-delivers (the id is derived from both).
    const id = deliverableIdFor(run.id, input.title);
    const dupe = await db
      .select({ id: schema.deliverables.id })
      .from(schema.deliverables)
      .where(and(eq(schema.deliverables.orgId, run.orgId), eq(schema.deliverables.runId, run.id), eq(schema.deliverables.title, input.title)))
      .limit(1);
    if (dupe[0]) {
      if (!ctx.state.deliverableIds.includes(dupe[0].id)) ctx.state.deliverableIds.push(dupe[0].id);
      return ok({ delivered: true, deliverableId: dupe[0].id, duplicate: true });
    }
    const kind = input.kind ?? (ctx.workflow?.outputKind && (DELIVERABLE_KINDS as readonly string[]).includes(ctx.workflow.outputKind) ? (ctx.workflow.outputKind as (typeof DELIVERABLE_KINDS)[number]) : "report");
    const hoursSaved = hoursCreditFor(run, ctx.workflow, ctx.state.deliverableIds.length);
    const draft: DeliverableDraft = {
      id,
      title: input.title,
      kind,
      preview: input.preview ?? truncate(input.body.replace(/[#*_`|>-]/g, " ").replace(/\s+/g, " ").trim(), 200),
      body: input.body,
      data: input.data ?? null,
      // Work requested by an unverified sender is never presented as the agent's own finished output.
      needsReview: kind === "email_draft" || run.trigger === "setup" || !ctx.trust.trusted,
      hoursSaved: Number.isFinite(hoursSaved) ? hoursSaved : 0,
    };

    // Finished early (the first overnight deliverable): hand it over at the release time, not at 1 AM.
    const releaseAt = typeof run.input?.releaseAt === "string" ? new Date(run.input.releaseAt) : null;
    if (releaseAt && releaseAt.getTime() > Date.now()) {
      await enqueue(db, "deliverable.release", { orgId: run.orgId, runId: run.id, deliverable: draft }, { orgId: run.orgId, runAt: releaseAt, idempotencyKey: `release:${id}` });
      if (!ctx.state.deliverableIds.includes(id)) ctx.state.deliverableIds.push(id);
      return ok({ delivered: false, scheduled: true, deliverableId: id, releaseAt: releaseAt.toISOString(), note: "Saved; it will be handed to the client at the release time." });
    }
    const out = await publishDeliverable(db, { run, agent, workflow: ctx.workflow }, draft);
    if (!ctx.state.deliverableIds.includes(out.id)) ctx.state.deliverableIds.push(out.id);
    return ok({ delivered: true, deliverableId: out.id, channels: ["portal", ...out.channels] });
  },
});

/**
 * Hours saved are credited once per piece of real recurring work: the first new deliverable of a scheduled or
 * event-triggered workflow run, or of the setup (first overnight) run. Manual re-runs, revisions, follow-ups and
 * chat requests add 0, so "Run now" and "request changes" can't inflate the number.
 */
export function hoursCreditFor(run: ToolContext["run"], workflow: ToolContext["workflow"], deliverablesSoFar: number): number {
  if (deliverablesSoFar > 0) return 0;
  const kind = typeof run.input?.kind === "string" ? run.input.kind : "workflow";
  if (kind === "revision" || kind === "followup" || kind === "message") return 0;
  if (run.trigger === "setup") {
    const h = Number(run.input?.hoursSaved ?? 0);
    return Number.isFinite(h) && h > 0 ? h : 0;
  }
  if (run.trigger !== "schedule" && run.trigger !== "event") return 0;
  return workflow?.hoursSavedPerRun ?? 0;
}

export type DeliverableDraft = {
  id: string;
  title: string;
  kind: string;
  preview: string;
  body: string;
  data: Record<string, unknown> | null;
  needsReview: boolean;
  hoursSaved: number;
};

/** Deterministic deliverable id per (run, title): retries and staged releases converge on one row. */
export function deliverableIdFor(runId: string, title: string): string {
  const h = sha256(`deliverable|${runId}|${title}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Insert the deliverable (idempotent by id), notify the client, and send it out on the delivery channels. */
export async function publishDeliverable(
  db: ToolContext["db"],
  c: { run: ToolContext["run"]; agent: ToolContext["agent"]; workflow: ToolContext["workflow"] },
  d: DeliverableDraft,
): Promise<{ id: string; channels: string[]; duplicate: boolean }> {
  const { run, agent } = c;
  const inserted = await db
    .insert(schema.deliverables)
    .values({
      id: d.id,
      orgId: run.orgId,
      agentId: agent.id,
      runId: run.id,
      workflowId: run.workflowId,
      title: d.title,
      kind: d.kind,
      preview: d.preview,
      body: d.body,
      data: d.data,
      needsReview: d.needsReview,
      deliveredVia: ["portal"],
      hoursSaved: d.hoursSaved,
    })
    .onConflictDoNothing({ target: schema.deliverables.id })
    .returning({ id: schema.deliverables.id });
  const channels = (c.workflow?.deliverTo ?? agent.config.defaultDelivery ?? ["portal"]).filter((ch) => ch === "email" || ch === "sms" || ch === "slack");
  if (!inserted[0]) return { id: d.id, channels, duplicate: true };

  await db.insert(schema.notifications).values({
    orgId: run.orgId,
    kind: "deliverable.created",
    title: `${agent.name} delivered “${truncate(d.title, 80)}”`,
    body: d.preview,
    href: `/deliverables/${d.id}`,
  });
  for (const channel of channels) {
    await enqueue(
      db,
      "channel.deliver",
      { orgId: run.orgId, agentId: agent.id, channel, deliverableId: d.id, subject: d.title, text: `${d.preview}\n\nOpen it in your portal.` },
      { orgId: run.orgId, idempotencyKey: `deliver:${d.id}:${channel}` },
    );
  }
  return { id: d.id, channels, duplicate: false };
}

/** Does this send go back to the conversation's participant (same thread, or their own address/number/channel)? */
function isConversationTarget(input: { channel: string; to?: string }, p: Participant): boolean {
  if (!input.to) return input.channel === p.channel;
  if (input.channel === "email") return p.email !== null && input.to.trim().toLowerCase() === p.email;
  if (input.channel === "sms") return p.phone !== null && normalizePhone(input.to) === p.phone;
  if (input.channel === "slack") return p.slackChannel !== null && input.to.trim() === p.slackChannel;
  return false;
}

async function isInternalRecipient(ctx: ToolContext, to: string | undefined): Promise<boolean> {
  if (!to) return true; // channels slice resolves the org's own default recipient
  const rows = await ctx.db.execute(sql`
    select 1 from memberships m join users u on u.id = m.user_id
    where m.org_id = ${ctx.run.orgId} and lower(u.email) = lower(${to}) limit 1`);
  return rows.rows.length > 0;
}

export const sendMessage = defineTool({
  name: "send_message",
  description:
    "Send a message through a channel (email, sms, slack, portal). Without `to`, it goes to the client's own team. Messages to outside recipients may require human approval first.",
  schema: z.object({
    channel: z.enum(["email", "sms", "slack", "portal"]),
    to: z.string().max(320).optional(),
    subject: z.string().max(200).optional(),
    text: z.string().min(1).max(20_000),
  }),
  /**
   * Sends back to the person in this run's conversation are gated only when that person is outside the business.
   * Sends anywhere else are gated (send_external_<channel>; see requiresApproval), except a `to`-less send to the
   * org's own default recipient and, on runs without a conversation, email to a member of the org.
   */
  async approvalAction(input, ctx) {
    if (mentionsPaymentDetails(`${input.subject ?? ""}\n${input.text}`)) return "change_payment_details";
    if (input.channel === "portal") return null;
    const action = `send_external_${input.channel}`;
    const p = ctx.trust.participant;
    if (p && isConversationTarget(input, p)) return p.internal ? null : action;
    if (!input.to) return null;
    if (ctx.run.conversationId) return action;
    if (input.channel === "email" && (await isInternalRecipient(ctx, input.to))) return null;
    return action;
  },
  describe: (i) => `Send ${i.channel}${i.to ? ` to ${i.to}` : ""}${i.subject ? `: “${truncate(i.subject, 80)}”` : ""} — ${truncate(i.text, 160)}`,
  async run(input, ctx) {
    if (ctx.state.messagesSent >= 10) return toolError("Message limit for this run reached");
    const { db, run, agent } = ctx;
    const dedupeKey = sha256(`${run.id}|${input.channel}|${input.to ?? ""}|${input.subject ?? ""}|${input.text}`).slice(0, 32);
    const existing = await db.execute(sql`
      select id from messages where org_id = ${run.orgId} and run_id = ${run.id} and meta->>'dedupeKey' = ${dedupeKey} limit 1`);
    if (existing.rows[0]) return ok({ sent: true, duplicate: true });

    // Continue the run's conversation when the channel matches; otherwise open a new outbound thread.
    let conversationId: string | null = null;
    if (run.conversationId) {
      const conv = (
        await db
          .select({ id: schema.conversations.id, channel: schema.conversations.channel })
          .from(schema.conversations)
          .where(and(eq(schema.conversations.id, run.conversationId), eq(schema.conversations.orgId, run.orgId)))
          .limit(1)
      )[0];
      if (conv && conv.channel === input.channel && !input.to) conversationId = conv.id;
    }
    if (!conversationId) {
      const [conv] = await db
        .insert(schema.conversations)
        .values({ orgId: run.orgId, agentId: agent.id, channel: input.channel, subject: input.subject ?? null, externalThreadId: null })
        .returning({ id: schema.conversations.id });
      conversationId = conv!.id;
    }
    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: run.orgId,
        conversationId,
        direction: "outbound",
        author: "agent",
        body: input.text,
        meta: { dedupeKey, to: input.to ?? null, subject: input.subject ?? null },
        deliveryStatus: input.channel === "portal" ? "delivered" : "pending",
        runId: run.id,
      })
      .returning({ id: schema.messages.id });
    await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conversationId));
    if (input.channel !== "portal") {
      await enqueue(
        db,
        "channel.deliver",
        {
          orgId: run.orgId,
          agentId: agent.id,
          channel: input.channel,
          messageId: msg!.id,
          conversationId,
          ...(input.to ? { to: input.to } : {}),
          ...(input.subject ? { subject: input.subject } : {}),
          ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
          text: input.text,
        },
        { orgId: run.orgId, idempotencyKey: `msg:${msg!.id}` },
      );
    }
    ctx.state.messagesSent++;
    return ok({ sent: true, messageId: msg!.id, channel: input.channel });
  },
});

/** Explicit approval request. The runtime pauses the run; on approval the model is told and continues. */
export const requestApproval = defineTool({
  name: "request_approval",
  description:
    "Ask a human to approve a risky action before you take it (spending money, changing records in a client system, anything irreversible). The run pauses until they decide.",
  schema: z.object({
    action: z.string().min(2).max(80),
    description: z.string().min(5).max(1000),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  approvalAction: (input) => `request:${input.action}`,
  describe: (i) => i.description,
  async run(input) {
    // Only reached after a human approved (the runtime gates every call to this tool).
    return ok({ approved: true, action: input.action });
  },
});

export const scheduleFollowup = defineTool({
  name: "schedule_followup",
  description: "Schedule yourself to do a task later (e.g. check for a reply in 2 days). Provide an ISO-8601 time or a delay in hours.",
  schema: z.object({
    task: z.string().min(5).max(2000),
    at: z.string().datetime({ offset: true }).optional(),
    inHours: z.number().min(0.25).max(24 * 30).optional(),
  }),
  async run(input, ctx) {
    if (ctx.state.followups >= 3) return toolError("At most 3 follow-ups per run");
    const when = input.at ? new Date(input.at) : new Date(Date.now() + (input.inHours ?? 24) * 3600_000);
    const max = Date.now() + 30 * 24 * 3600_000;
    if (!(when.getTime() > Date.now()) || when.getTime() > max) return toolError("Follow-up time must be in the next 30 days");
    // Idempotent per tool call (a resumed run must not schedule the same follow-up twice).
    const prior = (
      await ctx.db.execute(sql`
        select id, input->>'at' as at from runs where org_id = ${ctx.run.orgId} and input->>'parentRunId' = ${ctx.run.id} and input->>'parentToolUseId' = ${ctx.toolUseId} limit 1`)
    ).rows[0] as { id: string; at: string | null } | undefined;
    if (prior) return ok({ scheduled: true, runId: prior.id, at: prior.at ?? when.toISOString(), duplicate: true });
    const runId = randomUUID();
    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.runs).values({
        id: runId,
        orgId: ctx.run.orgId,
        agentId: ctx.agent.id,
        workflowId: ctx.run.workflowId,
        conversationId: ctx.run.conversationId,
        trigger: "schedule",
        status: "queued",
        input: { kind: "followup", task: input.task, parentRunId: ctx.run.id, parentToolUseId: ctx.toolUseId, at: when.toISOString() },
      });
      await enqueue(tx, "agent.run", { orgId: ctx.run.orgId, runId }, { orgId: ctx.run.orgId, runAt: when, idempotencyKey: `followup:${ctx.run.id}:${ctx.toolUseId}` });
    });
    ctx.state.followups++;
    return ok({ scheduled: true, runId, at: when.toISOString() });
  },
});
