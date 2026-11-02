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
import { defineTool, ok, toolError, type ToolContext } from "./types";

const DELIVERABLE_KINDS = ["report", "document", "table", "email_draft", "message"] as const;

export const knowledgeSearch = defineTool({
  name: "knowledge_search",
  description:
    "Search this business's knowledge base (discovery call transcript, documents, catalogs, SOPs, URLs) and return the most relevant passages. Use it before writing anything factual.",
  schema: z.object({ query: z.string().min(2).max(500), limit: z.number().int().min(1).max(10).optional() }),
  async run(input, ctx) {
    const hits = await searchKnowledge(ctx.db, { orgId: ctx.run.orgId, agentId: ctx.agent.id, query: input.query, limit: input.limit ?? 5 });
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
        source: `run:${ctx.run.id}`,
      })
      .returning({ id: schema.memories.id });
    return ok({ saved: true, id: row?.id });
  },
});

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
    // Idempotent per run+title so a retried run never double-delivers.
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
    const hoursSaved = ctx.state.deliverableIds.length === 0 ? (ctx.workflow?.hoursSavedPerRun ?? Number(run.input?.hoursSaved ?? 0) ?? 0) : 0;
    const preview = input.preview ?? truncate(input.body.replace(/[#*_`|>-]/g, " ").replace(/\s+/g, " ").trim(), 200);
    const [row] = await db
      .insert(schema.deliverables)
      .values({
        orgId: run.orgId,
        agentId: agent.id,
        runId: run.id,
        workflowId: run.workflowId,
        title: input.title,
        kind,
        preview,
        body: input.body,
        data: input.data ?? null,
        needsReview: kind === "email_draft" || run.trigger === "setup",
        deliveredVia: ["portal"],
        hoursSaved: Number.isFinite(hoursSaved) ? hoursSaved : 0,
      })
      .returning({ id: schema.deliverables.id });
    if (!row) return toolError("Could not save the deliverable");
    ctx.state.deliverableIds.push(row.id);

    await db.insert(schema.notifications).values({
      orgId: run.orgId,
      kind: "deliverable.created",
      title: `${agent.name} delivered “${truncate(input.title, 80)}”`,
      body: preview,
      href: `/deliverables/${row.id}`,
    });

    const channels = (ctx.workflow?.deliverTo ?? agent.config.defaultDelivery ?? ["portal"]).filter((c) => c === "email" || c === "sms" || c === "slack");
    for (const channel of channels) {
      await enqueue(
        db,
        "channel.deliver",
        {
          orgId: run.orgId,
          agentId: agent.id,
          channel,
          deliverableId: row.id,
          subject: input.title,
          text: `${preview}\n\nOpen it in your portal.`,
        },
        { orgId: run.orgId, idempotencyKey: `deliver:${row.id}:${channel}` },
      );
    }
    return ok({ delivered: true, deliverableId: row.id, channels: ["portal", ...channels] });
  },
});

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
  async approvalAction(input, ctx) {
    if (input.channel === "email" && !(await isInternalRecipient(ctx, input.to))) return "send_external_email";
    if (input.channel === "sms" && input.to) return "send_external_sms";
    return null;
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
        input: { kind: "followup", task: input.task, parentRunId: ctx.run.id },
      });
      await enqueue(tx, "agent.run", { orgId: ctx.run.orgId, runId }, { orgId: ctx.run.orgId, runAt: when, idempotencyKey: `run:${runId}` });
    });
    ctx.state.followups++;
    return ok({ scheduled: true, runId, at: when.toISOString() });
  },
});
