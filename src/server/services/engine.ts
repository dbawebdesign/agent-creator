/**
 * Engine service contract — the ONLY entry points UI/API code should call for agent work.
 * Owner: engine slice. UI slices import from here; do not reach into engine internals.
 *
 * All functions take an explicit `orgId` (already authorized by the caller via requireOrg/requireOrgById
 * or API-key auth) and must scope every query by it. Missing/foreign rows raise `EngineNotFoundError`
 * (callers map it to a 404 so existence never leaks).
 */
import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { architect, finalizeSpec } from "@/server/agents/architect";
import { executeRun } from "@/server/agents/runtime";
import { agentSpec, DEFAULT_APPROVALS, normalizeApprovals, type AgentSpec } from "@/server/agents/spec";
import { computerProvider } from "@/server/computer";
import { db, schema, type DB } from "@/server/db/client";
import type { AgentConfig, ChannelKind, WorkflowTrigger } from "@/server/db/schema";
import { env } from "@/server/env";
import { enqueue } from "@/server/jobs/queue";
import { firstDeliverableSchedule, isValidCron, nextRunForTrigger } from "@/server/jobs/scheduler";
import { indexText } from "@/server/knowledge";
import { logger } from "@/server/lib/logger";
import { costMicros, LlmError } from "@/server/llm";
import { slugify, truncate } from "@/server/llm/text";
import { audit } from "@/server/security/audit";

export type Actor = { type: "user"; userId: string } | { type: "api_key"; keyId: string } | { type: "system" };

export class EngineNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "EngineNotFoundError";
  }
}
export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineInputError";
  }
}

const uuid = z.string().uuid();
const actorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: uuid }),
  z.object({ type: z.literal("api_key"), keyId: z.string().min(1) }),
  z.object({ type: z.literal("system") }),
]);

function parse<T extends z.ZodType>(s: T, v: unknown): z.infer<T> {
  const r = s.safeParse(v);
  if (!r.success) throw new EngineInputError(z.prettifyError(r.error));
  return r.data;
}

const actorAudit = (a: Actor) => ({
  actorType: a.type === "api_key" ? ("api_key" as const) : a.type === "user" ? ("user" as const) : ("system" as const),
  actorId: a.type === "user" ? a.userId : a.type === "api_key" ? a.keyId : null,
});
const actorUserId = (a: Actor) => (a.type === "user" ? a.userId : null);

async function getOrg(database: DB, orgId: string) {
  const org = (
    await database
      .select()
      .from(schema.organizations)
      .where(and(eq(schema.organizations.id, orgId), isNull(schema.organizations.deletedAt)))
      .limit(1)
  )[0];
  if (!org) throw new EngineNotFoundError("Organization");
  return org;
}

async function getAgent(database: DB, orgId: string, agentId: string) {
  const agent = (await database.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId))).limit(1))[0];
  if (!agent) throw new EngineNotFoundError("Agent");
  return agent;
}

/** Create a run row and enqueue its job atomically. */
async function queueRun(
  database: DB,
  values: { orgId: string; agentId: string; workflowId?: string | null; conversationId?: string | null; trigger: (typeof schema.runs.$inferInsert)["trigger"]; input: Record<string, unknown> },
  opts: { runAt?: Date; priority?: number } = {},
): Promise<string> {
  const runId = randomUUID();
  await database.transaction(async (tx) => {
    await tx.insert(schema.runs).values({ id: runId, status: "queued", ...values });
    await enqueue(tx, "agent.run", { orgId: values.orgId, runId }, { orgId: values.orgId, runAt: opts.runAt, priority: opts.priority, idempotencyKey: `run:${runId}` });
  });
  return runId;
}

// ───────────────────────────────────────────── discovery → proposal ─────────────────────────────────────────────

/** Create a discovery from a call transcript and queue the Architect. Returns the discovery id. */
export async function createDiscovery(input: {
  orgId: string; // the CLIENT org the agent will work for
  title: string;
  transcript: string;
  actor: Actor;
}): Promise<{ discoveryId: string }> {
  const i = parse(
    z.object({ orgId: uuid, title: z.string().trim().min(1).max(200), transcript: z.string().min(40).max(500_000), actor: actorSchema }),
    input,
  );
  const database = db();
  await getOrg(database, i.orgId);
  const discoveryId = randomUUID();
  await database.transaction(async (tx) => {
    await tx.insert(schema.discoveries).values({ id: discoveryId, orgId: i.orgId, title: i.title, transcript: i.transcript, status: "pending", createdBy: actorUserId(i.actor) });
    await enqueue(tx, "discovery.analyze", { orgId: i.orgId, discoveryId }, { orgId: i.orgId, idempotencyKey: `discovery:${discoveryId}`, priority: 5 });
  });
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: "discovery.created", targetType: "discovery", targetId: discoveryId });
  return { discoveryId };
}

/** Run the Architect synchronously (used by the worker job and by tests). Stores the proposal. */
export async function analyzeDiscovery(discoveryId: string): Promise<AgentSpec> {
  parse(uuid, discoveryId);
  const database = db();
  const d = (await database.select().from(schema.discoveries).where(eq(schema.discoveries.id, discoveryId)).limit(1))[0];
  if (!d) throw new EngineNotFoundError("Discovery");
  const org = await getOrg(database, d.orgId);
  await database.update(schema.discoveries).set({ status: "analyzing", error: null }).where(and(eq(schema.discoveries.id, d.id), eq(schema.discoveries.orgId, d.orgId)));
  try {
    const { spec, model, usage } = await architect({ transcript: d.transcript, orgName: org.name, industry: org.industry });
    await database
      .update(schema.discoveries)
      .set({ status: d.status === "hired" ? "hired" : "ready", proposal: spec as unknown as Record<string, unknown>, error: null })
      .where(and(eq(schema.discoveries.id, d.id), eq(schema.discoveries.orgId, d.orgId)));
    if (usage.inputTokens || usage.outputTokens) {
      await database.insert(schema.usageEvents).values({
        orgId: d.orgId,
        agencyId: org.agencyId,
        kind: "llm",
        model,
        inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        costMicros: costMicros(model, usage),
      });
    }
    return spec;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await database
      .update(schema.discoveries)
      .set({ status: "failed", error: truncate(message, 1000) })
      .where(and(eq(schema.discoveries.id, d.id), eq(schema.discoveries.orgId, d.orgId)));
    throw err;
  }
}

// ───────────────────────────────────────────── hire ─────────────────────────────────────────────

const DEFAULT_MONTHLY_BUDGET_CENTS = 50_000; // $500 internal guardrail per agent

async function uniqueEmailHandle(database: DB, name: string): Promise<string> {
  const base = slugify(name, 24);
  const taken = await database.select({ h: schema.agents.emailHandle }).from(schema.agents).where(eq(schema.agents.emailHandle, base)).limit(1);
  if (!taken[0]) return base;
  for (let i = 0; i < 8; i++) {
    const candidate = `${base}-${randomBytes(3).toString("hex").slice(0, 4)}`;
    const t = await database.select({ h: schema.agents.emailHandle }).from(schema.agents).where(eq(schema.agents.emailHandle, candidate)).limit(1);
    if (!t[0]) return candidate;
  }
  return `${base}-${randomBytes(6).toString("hex")}`;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = e?.code ?? e?.cause?.code;
  const c = e?.constraint ?? e?.cause?.constraint;
  return code === "23505" && (!constraint || c === constraint);
}

/** Provision a live agent from a (possibly edited) proposal: agent, workflows, memories, KB, inbox, first deliverable. */
export async function hireAgent(input: {
  orgId: string;
  spec: AgentSpec;
  discoveryId?: string;
  blueprintId?: string;
  actor: Actor;
  /** Internal (resale): the agent this one is cloned from. */
  sourceAgentId?: string;
  /** Override the internal monthly cost guardrail (cents). */
  monthlyBudgetCents?: number;
}): Promise<{ agentId: string }> {
  const i = parse(
    z.object({
      orgId: uuid,
      spec: z.unknown(),
      discoveryId: uuid.optional(),
      blueprintId: uuid.optional(),
      actor: actorSchema,
      sourceAgentId: uuid.optional(),
      monthlyBudgetCents: z.number().int().min(0).max(100_000_000).optional(),
    }),
    input,
  );
  const spec = finalizeSpec(parse(agentSpec, i.spec));
  for (const w of spec.workflows) if (w.trigger.type === "schedule" && !isValidCron(w.trigger.cron)) throw new EngineInputError(`Invalid schedule for “${w.name}”: ${w.trigger.cron}`);
  const database = db();
  const org = await getOrg(database, i.orgId);
  const discovery = i.discoveryId
    ? (await database.select().from(schema.discoveries).where(and(eq(schema.discoveries.id, i.discoveryId), eq(schema.discoveries.orgId, i.orgId))).limit(1))[0]
    : undefined;
  if (i.discoveryId && !discovery) throw new EngineNotFoundError("Discovery");
  if (discovery?.status === "hired" && discovery.agentId) return { agentId: discovery.agentId }; // idempotent re-hire
  if (i.blueprintId) {
    const bp = (await database.select({ id: schema.blueprints.id }).from(schema.blueprints).where(and(eq(schema.blueprints.id, i.blueprintId), eq(schema.blueprints.orgId, org.agencyId ?? org.id))).limit(1))[0];
    if (!bp) throw new EngineNotFoundError("Blueprint");
  }

  const now = new Date();
  const computer = computerProvider();
  const approvals = normalizeApprovals(spec.requireApprovalFor);
  const deliveryChannels = spec.channels.filter((c): c is ChannelKind => c === "portal" || c === "email" || c === "slack" || c === "sms");
  const config: AgentConfig = {
    modelTier: "smart",
    tools: spec.tools,
    // Only actions the tools actually emit (plus the defaults) — anything else would never be enforced.
    requireApprovalFor: approvals.actions,
    defaultDelivery: deliveryChannels.length ? deliveryChannels : ["portal"],
    voice: spec.voice,
    monthlyBudgetCents: i.monthlyBudgetCents ?? DEFAULT_MONTHLY_BUDGET_CENTS,
  };

  let agentId = "";
  let sourceId: string | null = null;
  let firstRunId = "";
  let handle = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    handle = await uniqueEmailHandle(database, spec.name);
    agentId = randomUUID();
    firstRunId = randomUUID();
    try {
      await database.transaction(async (tx) => {
        await tx.insert(schema.agents).values({
          id: agentId,
          orgId: org.id,
          blueprintId: i.blueprintId ?? null,
          sourceAgentId: i.sourceAgentId ?? null,
          name: spec.name,
          role: spec.role,
          avatarSeed: `${spec.name}-${agentId.slice(0, 8)}`,
          summary: spec.summary,
          instructions: spec.instructions,
          status: "provisioning",
          emailHandle: handle,
          config,
          computerStatus: computer.configured ? "starting" : "none",
          createdBy: actorUserId(i.actor),
        });
        for (const w of spec.workflows) {
          const trigger: WorkflowTrigger =
            w.trigger.type === "schedule" ? { type: "schedule", cron: w.trigger.cron, timezone: org.timezone } : w.trigger.type === "event" ? { type: "event", event: w.trigger.event } : { type: "manual" };
          await tx.insert(schema.workflows).values({
            orgId: org.id,
            agentId,
            name: w.name,
            instructions: w.problem ? `${w.instructions}\n\nWhy this matters: ${w.problem}` : w.instructions,
            trigger,
            outputKind: w.outputKind,
            deliverTo: w.deliverTo,
            hoursSavedPerRun: w.hoursSavedPerRun,
            nextRunAt: nextRunForTrigger(trigger, org.timezone, now),
          });
        }
        if (spec.seedMemories.length) {
          await tx.insert(schema.memories).values(
            spec.seedMemories.map((content) => ({
              orgId: org.id,
              agentId,
              kind: /^preference\b/i.test(content) ? ("preference" as const) : /^person\b/i.test(content) ? ("person" as const) : ("fact" as const),
              content,
              importance: 4,
              source: discovery ? `discovery:${discovery.id}` : "spec",
            })),
          );
        }
        if (discovery) {
          const [src] = await tx
            .insert(schema.knowledgeSources)
            .values({ orgId: org.id, agentId, title: `Discovery call: ${truncate(discovery.title, 100)}`, kind: "transcript", status: "pending" })
            .returning({ id: schema.knowledgeSources.id });
          sourceId = src!.id;
          await tx.update(schema.discoveries).set({ status: "hired", agentId }).where(and(eq(schema.discoveries.id, discovery.id), eq(schema.discoveries.orgId, org.id)));
        }
        const address = `${handle}@${env().EMAIL_DOMAIN}`;
        await tx.insert(schema.channelConnections).values([
          { orgId: org.id, agentId, kind: "portal", externalId: `portal:${agentId}`, status: "connected", config: {} },
          { orgId: org.id, agentId, kind: "email", externalId: address, status: "connected", config: { address } },
        ]);
        // The overnight wow: worked on from ~1:00 AM, handed over at 6:00 AM in the client's timezone.
        const first = firstDeliverableSchedule(org.timezone, now);
        await tx.insert(schema.runs).values({
          id: firstRunId,
          orgId: org.id,
          agentId,
          trigger: "setup",
          status: "queued",
          input: {
            kind: "first_deliverable",
            title: spec.firstDeliverable.title,
            description: spec.firstDeliverable.description,
            instructions: spec.firstDeliverable.instructions,
            outputKind: "document",
            deliverTo: deliveryChannels.filter((c) => c !== "sms"),
            hoursSaved: Math.max(1, Math.round((spec.weeklyHoursSaved / 5) * 10) / 10),
            ...(first.releaseAt ? { releaseAt: first.releaseAt.toISOString() } : {}),
          },
        });
        await enqueue(tx, "agent.run", { orgId: org.id, runId: firstRunId }, { orgId: org.id, runAt: first.runAt, idempotencyKey: `run:${firstRunId}` });
        if (computer.configured) await enqueue(tx, "agent.provision", { orgId: org.id, agentId }, { orgId: org.id, idempotencyKey: `provision:${agentId}` });
        await tx.update(schema.agents).set({ status: "active", activatedAt: new Date() }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, org.id)));
      });
      break;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 2) continue; // email handle race: pick another
      throw err;
    }
  }

  // Transcript → knowledge base (inline so the overnight run can use it; job retry if it fails).
  if (discovery && sourceId) {
    try {
      await indexText(database, { orgId: org.id, sourceId, text: discovery.transcript });
    } catch (err) {
      logger.warn({ err: (err as Error).message, agentId }, "inline transcript indexing failed; queueing retry");
      await enqueue(database, "knowledge.index", { orgId: org.id, sourceId, text: discovery.transcript }, { orgId: org.id, idempotencyKey: `kindex:${sourceId}` });
    }
  }
  await audit({ orgId: org.id, ...actorAudit(i.actor), action: "agent.hired", targetType: "agent", targetId: agentId, metadata: { name: spec.name, discoveryId: i.discoveryId ?? null, handle, ...(approvals.unenforceable.length ? { unenforceableApprovals: approvals.unenforceable } : {}) } });
  return { agentId };
}

/** Job: agent.provision — attach a cloud computer when a provider is configured. */
export async function provisionAgentComputer(payload: Record<string, unknown>, database: DB = db()): Promise<void> {
  const p = parse(z.object({ orgId: uuid, agentId: uuid, polls: z.number().int().min(0).optional() }), payload);
  const agent = await getAgent(database, p.orgId, p.agentId);
  const provider = computerProvider();
  if (!provider.configured) {
    await database.update(schema.agents).set({ computerStatus: "none" }).where(and(eq(schema.agents.id, agent.id), eq(schema.agents.orgId, p.orgId)));
    return;
  }
  if (!agent.computerId) {
    const r = await provider.provision({ name: `${agent.name}-${agent.id.slice(0, 8)}` });
    await database.update(schema.agents).set({ computerId: r.computerId, computerStatus: r.status }).where(and(eq(schema.agents.id, agent.id), eq(schema.agents.orgId, p.orgId)));
    if (r.status === "ready") return;
  } else if (agent.computerStatus === "ready") return;
  const id = agent.computerId ?? (await getAgent(database, p.orgId, p.agentId)).computerId!;
  const status = await provider.status(id);
  await database.update(schema.agents).set({ computerStatus: status }).where(and(eq(schema.agents.id, agent.id), eq(schema.agents.orgId, p.orgId)));
  if (status === "starting" && (p.polls ?? 0) < 20) {
    await enqueue(database, "agent.provision", { ...p, polls: (p.polls ?? 0) + 1 }, { orgId: p.orgId, runAt: new Date(Date.now() + 30_000), idempotencyKey: `provision:${agent.id}:${(p.polls ?? 0) + 1}` });
  }
}

// ───────────────────────────────────────────── runs & messages ─────────────────────────────────────────────

/** Queue a workflow run now. */
export async function runWorkflowNow(input: { orgId: string; workflowId: string; actor: Actor }): Promise<{ runId: string }> {
  const i = parse(z.object({ orgId: uuid, workflowId: uuid, actor: actorSchema }), input);
  const database = db();
  const wf = (await database.select().from(schema.workflows).where(and(eq(schema.workflows.id, i.workflowId), eq(schema.workflows.orgId, i.orgId))).limit(1))[0];
  if (!wf) throw new EngineNotFoundError("Workflow");
  const agent = await getAgent(database, i.orgId, wf.agentId);
  if (agent.status !== "active") throw new EngineInputError(`${agent.name} is ${agent.status}`);
  const runId = await queueRun(database, { orgId: i.orgId, agentId: agent.id, workflowId: wf.id, trigger: "manual", input: { kind: "workflow" } }, { priority: 10 });
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: "workflow.run", targetType: "workflow", targetId: wf.id, metadata: { runId } });
  return { runId };
}

const INLINE_DEADLINE_MS = 60_000;

/**
 * Send a message/request to an agent from the portal, API or MCP. Creates/continues a conversation and
 * queues a run. With `wait`, executes inline (bounded) and returns the reply — used by API/MCP sync calls.
 */
export async function messageAgent(input: {
  orgId: string;
  agentId: string;
  text: string;
  conversationId?: string;
  channel: "portal" | "api" | "mcp";
  actor: Actor;
  wait?: boolean;
}): Promise<{ conversationId: string; runId: string; reply?: string }> {
  const i = parse(
    z.object({
      orgId: uuid,
      agentId: uuid,
      text: z.string().trim().min(1).max(20_000),
      conversationId: uuid.optional(),
      channel: z.enum(["portal", "api", "mcp"]),
      actor: actorSchema,
      wait: z.boolean().optional(),
    }),
    input,
  );
  const database = db();
  const agent = await getAgent(database, i.orgId, i.agentId);
  if (agent.status !== "active") throw new EngineInputError(`${agent.name} is ${agent.status}`);
  let conversationId = i.conversationId;
  if (conversationId) {
    const conv = (
      await database
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, i.orgId), eq(schema.conversations.agentId, agent.id)))
        .limit(1)
    )[0];
    if (!conv) throw new EngineNotFoundError("Conversation");
  } else {
    const [conv] = await database
      .insert(schema.conversations)
      .values({ orgId: i.orgId, agentId: agent.id, channel: i.channel, userId: actorUserId(i.actor), subject: truncate(i.text.split("\n")[0] ?? "", 80) })
      .returning({ id: schema.conversations.id });
    conversationId = conv!.id;
  }
  const [msg] = await database
    .insert(schema.messages)
    .values({
      orgId: i.orgId,
      conversationId,
      direction: "inbound",
      author: i.actor.type === "user" ? "user" : i.actor.type === "api_key" ? "contact" : "system",
      body: i.text,
      deliveryStatus: "received",
      // Who sent it: the runtime derives sender trust from this (see agents/trust.ts).
      meta: { channel: i.channel, ...(i.actor.type === "api_key" ? { apiKeyId: i.actor.keyId } : {}), ...(i.actor.type === "user" ? { userId: i.actor.userId } : {}) },
    })
    .returning({ id: schema.messages.id });
  await database.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conversationId));

  const runInput = { kind: "message", messageId: msg!.id, text: i.text, channel: i.channel };
  if (!i.wait) {
    const runId = await queueRun(database, { orgId: i.orgId, agentId: agent.id, conversationId, trigger: i.channel === "portal" ? "message" : "api", input: runInput }, { priority: 20 });
    return { conversationId, runId };
  }
  // Inline: create the run plus a delayed safety-net job (a no-op if the inline run finishes).
  const runId = await queueRun(
    database,
    { orgId: i.orgId, agentId: agent.id, conversationId, trigger: i.channel === "portal" ? "message" : "api", input: runInput },
    { runAt: new Date(Date.now() + INLINE_DEADLINE_MS + 30_000), priority: 20 },
  );
  const outcome = await executeRun(database, runId, { orgId: i.orgId, limits: { deadlineMs: INLINE_DEADLINE_MS } });
  return { conversationId, runId, reply: outcome.reply };
}

/**
 * For the channels slice: an inbound message (email/SMS/Slack) was stored in `conversationId` — queue the reply run.
 * The reply is posted to the conversation and sent back out on the same channel via channel.deliver.
 */
export async function startConversationRun(input: { orgId: string; agentId: string; conversationId: string; messageId: string }): Promise<{ runId: string }> {
  const i = parse(z.object({ orgId: uuid, agentId: uuid, conversationId: uuid, messageId: uuid }), input);
  const database = db();
  const agent = await getAgent(database, i.orgId, i.agentId);
  const msg = (
    await database
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.id, i.messageId), eq(schema.messages.orgId, i.orgId), eq(schema.messages.conversationId, i.conversationId)))
      .limit(1)
  )[0];
  if (!msg) throw new EngineNotFoundError("Message");
  const findPrior = async () =>
    (
      await database
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(and(eq(schema.runs.orgId, i.orgId), eq(schema.runs.conversationId, i.conversationId), sql`${schema.runs.input}->>'messageId' = ${msg.id}`))
        .limit(1)
    )[0];
  // Durable dedupe: a webhook redelivered after the first reply run finished must not trigger a second reply.
  const already = await findPrior();
  if (already) return { runId: already.id };
  // One run per inbound message: when an event workflow handles this channel's messages, it replaces the generic
  // reply run (the channels slice's own triggerEvent call afterwards is deduped by message id).
  const priorEvent = await findEventRun(database, i.orgId, agent.id, msg.id);
  if (priorEvent) return { runId: priorEvent };
  const conv = (
    await database
      .select({ channel: schema.conversations.channel })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, i.conversationId), eq(schema.conversations.orgId, i.orgId)))
      .limit(1)
  )[0];
  // Spend guard: cap inbound-message runs per agent per hour. Over the cap the message stays stored for the team and a
  // canceled run records why (no model call, no cost).
  const cap = Math.max(1, agent.config.inboundRunsPerHour ?? 60);
  const recent = await database.execute(sql`
    select count(*)::int as n from runs where org_id = ${i.orgId} and agent_id = ${agent.id} and created_at > now() - interval '1 hour'
      and (trigger = 'message' or (trigger = 'event' and input->'eventPayload' ? 'messageId'))`);
  if (Number((recent.rows[0] as { n: number } | undefined)?.n ?? 0) >= cap) {
    const runId = randomUUID();
    await database.insert(schema.runs).values({
      id: runId,
      orgId: i.orgId,
      agentId: agent.id,
      conversationId: i.conversationId,
      trigger: "message",
      status: "canceled",
      input: { kind: "message", messageId: msg.id, text: msg.body },
      error: `Inbound limit reached (${cap} messages/hour); the message is stored but was not answered automatically`,
      finishedAt: new Date(),
    });
    logger.warn({ agentId: agent.id, cap }, "inbound run cap reached");
    return { runId };
  }
  const event = conv ? EVENT_FOR_CHANNEL[conv.channel] : undefined;
  if (event && agent.status === "active" && (await hasEventWorkflow(database, i.orgId, agent.id, event))) {
    const { runIds } = await triggerEvent({ orgId: i.orgId, agentId: agent.id, event, payload: { conversationId: i.conversationId, messageId: msg.id }, dedupeKey: msg.id });
    const handled = runIds[0] ?? (await findEventRun(database, i.orgId, agent.id, msg.id));
    if (handled) return { runId: handled };
  }
  const runId = randomUUID();
  const existing = await database.transaction(async (tx) => {
    await tx.insert(schema.runs).values({
      id: runId,
      orgId: i.orgId,
      agentId: agent.id,
      conversationId: i.conversationId,
      trigger: "message",
      status: "queued",
      input: { kind: "message", messageId: msg.id, text: msg.body },
    });
    // One reply run per inbound message, even if the webhook is delivered twice.
    const job = await enqueue(tx, "agent.run", { orgId: i.orgId, runId }, { orgId: i.orgId, priority: 20, idempotencyKey: `inbound:${msg.id}` });
    if (!job) throw new DuplicateRun();
    return null as string | null;
  }).catch(async (err) => {
    if (!(err instanceof DuplicateRun)) throw err;
    const prior = await findPrior();
    if (prior) return prior.id;
    throw err;
  });
  return { runId: existing ?? runId };
}
class DuplicateRun extends Error {}

const EVENT_FOR_CHANNEL: Record<string, "email.received" | "sms.received" | "slack.message" | undefined> = {
  email: "email.received",
  sms: "sms.received",
  slack: "slack.message",
};

async function hasEventWorkflow(database: DB, orgId: string, agentId: string, event: string): Promise<boolean> {
  const r = await database
    .select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.orgId, orgId),
        eq(schema.workflows.agentId, agentId),
        eq(schema.workflows.enabled, true),
        sql`${schema.workflows.trigger}->>'type' = 'event' and ${schema.workflows.trigger}->>'event' = ${event}`,
      ),
    )
    .limit(1);
  return r.length > 0;
}

async function findEventRun(database: DB, orgId: string, agentId: string, messageId: string): Promise<string | null> {
  const r = await database
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(and(eq(schema.runs.orgId, orgId), eq(schema.runs.agentId, agentId), eq(schema.runs.trigger, "event"), sql`${schema.runs.input}->'eventPayload'->>'messageId' = ${messageId}`))
    .limit(1);
  return r[0]?.id ?? null;
}

/** For the channels slice/webhooks: fire event-triggered workflows (e.g. "email.received"). Returns run ids. */
export async function triggerEvent(input: {
  orgId: string;
  agentId: string;
  event: "email.received" | "sms.received" | "slack.message" | "webhook" | "deliverable.approved";
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<{ runIds: string[] }> {
  const i = parse(
    z.object({
      orgId: uuid,
      agentId: uuid,
      event: z.enum(["email.received", "sms.received", "slack.message", "webhook", "deliverable.approved"]),
      payload: z.record(z.string(), z.unknown()).optional(),
      dedupeKey: z.string().max(200).optional(),
    }),
    input,
  );
  const database = db();
  const agent = await getAgent(database, i.orgId, i.agentId);
  if (agent.status !== "active") return { runIds: [] };
  const wfs = await database
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.orgId, i.orgId), eq(schema.workflows.agentId, agent.id), eq(schema.workflows.enabled, true), sql`${schema.workflows.trigger}->>'type' = 'event' and ${schema.workflows.trigger}->>'event' = ${i.event}`));
  // An inbound-message event threads the run into that conversation (validated against the org).
  const convId = typeof i.payload?.conversationId === "string" && /^[0-9a-f-]{36}$/i.test(i.payload.conversationId) ? i.payload.conversationId : null;
  const conversationId = convId
    ? ((
        await database
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(and(eq(schema.conversations.id, convId), eq(schema.conversations.orgId, i.orgId), eq(schema.conversations.agentId, agent.id)))
          .limit(1)
      )[0]?.id ?? null)
    : null;
  const runIds: string[] = [];
  for (const wf of wfs) {
    if (i.dedupeKey) {
      // Durable dedupe (the queue key only covers jobs still queued/running).
      const prior = await database
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(and(eq(schema.runs.orgId, i.orgId), eq(schema.runs.workflowId, wf.id), sql`${schema.runs.input}->>'dedupeKey' = ${i.dedupeKey}`))
        .limit(1);
      if (prior[0]) continue;
    }
    const runId = randomUUID();
    const queued = await database.transaction(async (tx) => {
      const job = await enqueue(tx, "agent.run", { orgId: i.orgId, runId }, { orgId: i.orgId, idempotencyKey: i.dedupeKey ? `event:${wf.id}:${i.dedupeKey}` : `run:${runId}` });
      if (!job) return false;
      await tx.insert(schema.runs).values({
        id: runId,
        orgId: i.orgId,
        agentId: agent.id,
        workflowId: wf.id,
        conversationId,
        trigger: "event",
        status: "queued",
        input: { kind: "workflow", event: i.event, eventPayload: i.payload ?? {}, ...(i.dedupeKey ? { dedupeKey: i.dedupeKey } : {}) },
      });
      return true;
    });
    if (queued) runIds.push(runId);
  }
  return { runIds };
}

// ───────────────────────────────────────────── approvals & review ─────────────────────────────────────────────

/** Approve or reject a pending approval; approved actions are executed by the worker. */
export async function decideApproval(input: { orgId: string; approvalId: string; decision: "approved" | "rejected"; actor: Actor }): Promise<void> {
  const i = parse(z.object({ orgId: uuid, approvalId: uuid, decision: z.enum(["approved", "rejected"]), actor: actorSchema }), input);
  const database = db();
  const updated = (
    await database
      .update(schema.approvals)
      .set({ status: i.decision, decidedBy: actorUserId(i.actor), decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, i.approvalId), eq(schema.approvals.orgId, i.orgId), eq(schema.approvals.status, "pending")))
      .returning()
  )[0];
  if (!updated) {
    const exists = (await database.select({ id: schema.approvals.id }).from(schema.approvals).where(and(eq(schema.approvals.id, i.approvalId), eq(schema.approvals.orgId, i.orgId))).limit(1))[0];
    if (!exists) throw new EngineNotFoundError("Approval");
    throw new EngineInputError("This approval was already decided");
  }
  if (updated.runId) {
    await enqueue(database, "agent.run", { orgId: i.orgId, runId: updated.runId }, { orgId: i.orgId, priority: 30, idempotencyKey: `approval:${updated.id}` });
  }
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: `approval.${i.decision}`, targetType: "approval", targetId: updated.id, metadata: { action: updated.action } });
}

/** Mark a deliverable seen/approved/changes requested (feedback is written to agent memory). */
export async function reviewDeliverable(input: {
  orgId: string;
  deliverableId: string;
  action: "seen" | "approve" | "request_changes" | "archive";
  feedback?: string;
  actor: Actor;
}): Promise<void> {
  const i = parse(
    z.object({ orgId: uuid, deliverableId: uuid, action: z.enum(["seen", "approve", "request_changes", "archive"]), feedback: z.string().trim().max(5000).optional(), actor: actorSchema }),
    input,
  );
  const database = db();
  const d = (await database.select().from(schema.deliverables).where(and(eq(schema.deliverables.id, i.deliverableId), eq(schema.deliverables.orgId, i.orgId))).limit(1))[0];
  if (!d) throw new EngineNotFoundError("Deliverable");
  const scope = and(eq(schema.deliverables.id, d.id), eq(schema.deliverables.orgId, i.orgId));
  switch (i.action) {
    case "seen":
      if (d.status === "new") await database.update(schema.deliverables).set({ status: "seen", seenAt: new Date() }).where(scope);
      else if (!d.seenAt) await database.update(schema.deliverables).set({ seenAt: new Date() }).where(scope);
      return;
    case "archive":
      await database.update(schema.deliverables).set({ status: "archived" }).where(scope);
      break;
    case "approve":
      await database.update(schema.deliverables).set({ status: "approved", needsReview: false, seenAt: d.seenAt ?? new Date(), feedback: i.feedback ?? d.feedback }).where(scope);
      await triggerEvent({ orgId: i.orgId, agentId: d.agentId, event: "deliverable.approved", payload: { deliverableId: d.id }, dedupeKey: `approved:${d.id}` });
      break;
    case "request_changes": {
      if (!i.feedback) throw new EngineInputError("Feedback is required to request changes");
      await database.update(schema.deliverables).set({ status: "changes_requested", feedback: i.feedback, seenAt: d.seenAt ?? new Date() }).where(scope);
      await database.insert(schema.memories).values({
        orgId: i.orgId,
        agentId: d.agentId,
        kind: "preference",
        content: truncate(`Feedback on “${truncate(d.title, 80)}”: ${i.feedback}`, 500),
        importance: 5,
        source: `deliverable:${d.id}`,
      });
      const agent = await getAgent(database, i.orgId, d.agentId);
      if (agent.status === "active") {
        await queueRun(database, { orgId: i.orgId, agentId: d.agentId, workflowId: d.workflowId, trigger: "manual", input: { kind: "revision", deliverableId: d.id, feedback: i.feedback } }, { priority: 15 });
      }
      break;
    }
  }
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: `deliverable.${i.action}`, targetType: "deliverable", targetId: d.id });
}

// ───────────────────────────────────────────── knowledge & lifecycle ─────────────────────────────────────────────

/** Add a knowledge source (text or URL) and queue indexing. */
export async function addKnowledge(input: {
  orgId: string;
  agentId?: string | null;
  title: string;
  kind: "text" | "url";
  content?: string;
  url?: string;
  actor: Actor;
}): Promise<{ sourceId: string }> {
  const i = parse(
    z
      .object({
        orgId: uuid,
        agentId: uuid.nullish(),
        title: z.string().trim().min(1).max(200),
        kind: z.enum(["text", "url"]),
        content: z.string().max(2_000_000).optional(),
        url: z.string().url().max(2048).optional(),
        actor: actorSchema,
      })
      .refine((v) => (v.kind === "text" ? Boolean(v.content?.trim()) : Boolean(v.url && v.url.startsWith("https://"))), {
        message: "Text sources need content; URL sources need an https URL",
      }),
    input,
  );
  const database = db();
  await getOrg(database, i.orgId);
  if (i.agentId) await getAgent(database, i.orgId, i.agentId);
  const sourceId = randomUUID();
  await database.transaction(async (tx) => {
    await tx.insert(schema.knowledgeSources).values({ id: sourceId, orgId: i.orgId, agentId: i.agentId ?? null, title: i.title, kind: i.kind, uri: i.kind === "url" ? i.url! : null, status: "pending" });
    await enqueue(tx, "knowledge.index", { orgId: i.orgId, sourceId, ...(i.kind === "text" ? { text: i.content } : { url: i.url }) }, { orgId: i.orgId, idempotencyKey: `kindex:${sourceId}`, priority: 5 });
  });
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: "knowledge.added", targetType: "knowledge_source", targetId: sourceId, metadata: { kind: i.kind } });
  return { sourceId };
}

/** Pause/resume/archive an agent. */
export async function setAgentStatus(input: { orgId: string; agentId: string; status: "active" | "paused" | "archived"; actor: Actor }): Promise<void> {
  const i = parse(z.object({ orgId: uuid, agentId: uuid, status: z.enum(["active", "paused", "archived"]), actor: actorSchema }), input);
  const database = db();
  const agent = await getAgent(database, i.orgId, i.agentId);
  if (agent.status === "archived" && i.status !== "archived") throw new EngineInputError("Archived agents cannot be reactivated");
  await database.update(schema.agents).set({ status: i.status }).where(and(eq(schema.agents.id, agent.id), eq(schema.agents.orgId, i.orgId)));
  if (i.status === "active") {
    // Resume schedules from now (no burst of missed runs).
    const org = await getOrg(database, i.orgId);
    const wfs = await database.select().from(schema.workflows).where(and(eq(schema.workflows.agentId, agent.id), eq(schema.workflows.orgId, i.orgId)));
    for (const w of wfs) await database.update(schema.workflows).set({ nextRunAt: nextRunForTrigger(w.trigger, org.timezone) }).where(eq(schema.workflows.id, w.id));
  }
  if (i.status === "archived") {
    await database
      .update(schema.runs)
      .set({ status: "canceled", finishedAt: new Date(), error: "Agent archived" })
      .where(and(eq(schema.runs.agentId, agent.id), eq(schema.runs.orgId, i.orgId), inArray(schema.runs.status, ["queued", "waiting_approval"])));
  }
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: `agent.${i.status}`, targetType: "agent", targetId: agent.id });
}

/** Rebuild an AgentSpec from a live agent (for blueprints and resale). */
async function specFromAgent(database: DB, orgId: string, agentId: string): Promise<AgentSpec> {
  const agent = await getAgent(database, orgId, agentId);
  const wfs = await database.select().from(schema.workflows).where(and(eq(schema.workflows.agentId, agent.id), eq(schema.workflows.orgId, orgId)));
  const setup = (
    await database
      .select({ input: schema.runs.input })
      .from(schema.runs)
      .where(and(eq(schema.runs.agentId, agent.id), eq(schema.runs.orgId, orgId), eq(schema.runs.trigger, "setup")))
      .limit(1)
  )[0]?.input;
  const blueprintVertical = agent.blueprintId
    ? (await database.select({ v: schema.blueprints.vertical }).from(schema.blueprints).where(eq(schema.blueprints.id, agent.blueprintId)).limit(1))[0]?.v
    : null;
  return finalizeSpec(
    agentSpec.parse({
      name: agent.name,
      role: agent.role,
      summary: truncate(agent.summary ?? `${agent.name}, ${agent.role}`, 280),
      vertical: blueprintVertical ?? "",
      instructions: agent.instructions,
      voice: agent.config.voice,
      workflows: wfs.slice(0, 12).map((w) => ({
        name: truncate(w.name, 80),
        problem: "",
        instructions: truncate(w.instructions.replace(/\n\nWhy this matters: [\s\S]*$/, ""), 6000),
        trigger: w.trigger.type === "schedule" ? { type: "schedule", cron: w.trigger.cron } : w.trigger.type === "event" ? { type: "event", event: w.trigger.event } : { type: "manual" },
        outputKind: (["report", "document", "table", "email_draft", "message", "action"] as const).find((k) => k === w.outputKind) ?? "report",
        deliverTo: w.deliverTo.length ? w.deliverTo : ["portal"],
        hoursSavedPerRun: w.hoursSavedPerRun,
        tools: [],
      })),
      seedMemories: [],
      channels: agent.config.defaultDelivery?.length ? agent.config.defaultDelivery : ["portal", "email"],
      tools: agent.config.tools ?? [],
      requireApprovalFor: agent.config.requireApprovalFor ?? [...DEFAULT_APPROVALS],
      firstDeliverable: {
        title: truncate(String(setup?.title ?? `Welcome brief from ${agent.name}`), 120),
        description: truncate(String(setup?.description ?? `A first overnight deliverable from ${agent.name}.`), 600),
        instructions: truncate(String(setup?.instructions ?? "Using the knowledge base, deliver a one-page brief of what you will do each week and the first piece of finished work."), 4000),
      },
    }),
  );
}

/** Save an agent as a reusable blueprint at the agency level. */
export async function saveBlueprint(input: { agencyId: string; agentId: string; name?: string; actor: Actor }): Promise<{ blueprintId: string }> {
  const i = parse(z.object({ agencyId: uuid, agentId: uuid, name: z.string().trim().min(1).max(120).optional(), actor: actorSchema }), input);
  const database = db();
  const agency = await getOrg(database, i.agencyId);
  if (agency.kind !== "agency") throw new EngineNotFoundError("Agency");
  // The agent must live in an org under this agency.
  const row = (
    await database
      .select({ agent: schema.agents })
      .from(schema.agents)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.agents.orgId))
      .where(and(eq(schema.agents.id, i.agentId), sql`(${schema.organizations.agencyId} = ${agency.id} or ${schema.organizations.id} = ${agency.id})`))
      .limit(1)
  )[0];
  if (!row) throw new EngineNotFoundError("Agent");
  const spec = await specFromAgent(database, row.agent.orgId, row.agent.id);
  const [bp] = await database
    .insert(schema.blueprints)
    .values({ orgId: agency.id, name: i.name ?? `${spec.role} (${spec.name})`, vertical: spec.vertical || null, summary: spec.summary, spec: spec as unknown as Record<string, unknown>, createdBy: actorUserId(i.actor) })
    .returning({ id: schema.blueprints.id });
  await audit({ orgId: agency.id, ...actorAudit(i.actor), action: "blueprint.saved", targetType: "blueprint", targetId: bp!.id, metadata: { agentId: row.agent.id } });
  return { blueprintId: bp!.id };
}

/**
 * B2B2B: clone an agent from a client org into one of its customer orgs (resale).
 * Copies spec, workflows and shared knowledge; memories and conversations are NOT copied.
 */
export async function resellAgent(input: { orgId: string; agentId: string; customerOrgId: string; actor: Actor }): Promise<{ agentId: string }> {
  const i = parse(z.object({ orgId: uuid, agentId: uuid, customerOrgId: uuid, actor: actorSchema }), input);
  const database = db();
  const source = await getAgent(database, i.orgId, i.agentId);
  const customer = await getOrg(database, i.customerOrgId);
  if (customer.parentId !== i.orgId || customer.kind !== "customer") throw new EngineNotFoundError("Customer organization");
  const spec = await specFromAgent(database, i.orgId, source.id);
  const { agentId } = await hireAgent({ orgId: customer.id, spec, actor: i.actor, sourceAgentId: source.id, monthlyBudgetCents: source.config.monthlyBudgetCents });

  // Shared knowledge: the source agent's non-transcript sources (discovery calls stay private to the client).
  const sources = await database
    .select()
    .from(schema.knowledgeSources)
    .where(and(eq(schema.knowledgeSources.orgId, i.orgId), eq(schema.knowledgeSources.agentId, source.id), ne(schema.knowledgeSources.kind, "transcript"), eq(schema.knowledgeSources.status, "ready")));
  for (const s of sources) {
    await database.transaction(async (tx) => {
      const [copy] = await tx
        .insert(schema.knowledgeSources)
        .values({ orgId: customer.id, agentId, title: s.title, kind: s.kind, uri: s.uri, status: "ready", chunkCount: s.chunkCount })
        .returning({ id: schema.knowledgeSources.id });
      await tx.execute(sql`
        insert into knowledge_chunks (org_id, source_id, agent_id, seq, content, embedding)
        select ${customer.id}, ${copy!.id}, ${agentId}, seq, content, embedding
        from knowledge_chunks where source_id = ${s.id} and org_id = ${i.orgId}`);
    });
  }
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: "agent.resold", targetType: "agent", targetId: source.id, metadata: { customerOrgId: customer.id, newAgentId: agentId } });
  return { agentId };
}

export { LlmError };
