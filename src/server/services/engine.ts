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
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { architect, finalizeSpec } from "@/server/agents/architect";
import { draftsIn, internalNotes, recipientProblem, sharesNoteText } from "@/server/agents/tools/recipients";
import type { ToolContext } from "@/server/agents/tools/types";
import { runTrust } from "@/server/agents/trust";
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
import { genericForResale, resalePrivate, retargetSpec } from "@/server/services/resale";
import { audit } from "@/server/security/audit";
import { emailDomainFor } from "@/server/channels/domains";

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

/**
 * Names a new agent must not take: every agent in the agency's tree (so the agency never has two Quinns), and the
 * people at the client and the agency (members, contacts). Internal only: passed to the Architect, never returned.
 */
async function namesInUse(database: DB, org: { id: string; agencyId: string | null; parentId: string | null }): Promise<string[]> {
  const agencyId = org.agencyId ?? org.id;
  const memberOrgs = [...new Set([org.id, agencyId, ...(org.parentId ? [org.parentId] : [])])];
  const [agents, members, contacts] = await Promise.all([
    database
      .select({ name: schema.agents.name })
      .from(schema.agents)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.agents.orgId))
      .where(or(eq(schema.organizations.agencyId, agencyId), eq(schema.organizations.id, agencyId)))
      .limit(2000),
    database
      .select({ name: schema.users.name })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(inArray(schema.memberships.orgId, memberOrgs))
      .limit(2000),
    database.select({ name: schema.contacts.name }).from(schema.contacts).where(eq(schema.contacts.orgId, org.id)).limit(2000),
  ]);
  return [...agents, ...members, ...contacts].map((r) => r.name).filter((n): n is string => !!n);
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
    const avoidNames = await namesInUse(database, org);
    const { spec, model, usage } = await architect({ transcript: d.transcript, orgName: org.name, industry: org.industry, avoidNames });
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
        // White-label: the org's nearest verified email domain (customer → client → agency), else env EMAIL_DOMAIN.
        const address = `${handle}@${await emailDomainFor(org.id)}`;
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
            // Rebuilt from the spec as hired, so edits made on the proposal reach tonight's work.
            instructions: firstDeliverableInstructions(spec),
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
    // Compare-and-set: only one caller (a job, or "Retry setup" clicked twice) gets to provision a computer.
    const claimed = await database
      .update(schema.agents)
      .set({ computerStatus: "starting" })
      .where(and(eq(schema.agents.id, agent.id), eq(schema.agents.orgId, p.orgId), isNull(schema.agents.computerId), sql`(${schema.agents.computerStatus} <> 'starting' or ${schema.agents.updatedAt} < now() - interval '10 minutes')`))
      .returning({ id: schema.agents.id });
    if (!claimed[0]) return;
    let r;
    try {
      r = await provider.provision({ name: `${agent.name}-${agent.id.slice(0, 8)}` });
    } catch (err) {
      await database.update(schema.agents).set({ computerStatus: "error" }).where(and(eq(schema.agents.id, agent.id), eq(schema.agents.orgId, p.orgId), isNull(schema.agents.computerId)));
      throw err;
    }
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
}): Promise<{ conversationId: string; runId: string; reply?: string; deliverables: Array<{ id: string; title: string; preview: string | null }> }> {
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
    return { conversationId, runId, deliverables: [] };
  }
  // Inline: create the run plus a delayed safety-net job (a no-op if the inline run finishes).
  const runId = await queueRun(
    database,
    { orgId: i.orgId, agentId: agent.id, conversationId, trigger: i.channel === "portal" ? "message" : "api", input: runInput },
    { runAt: new Date(Date.now() + INLINE_DEADLINE_MS + 30_000), priority: 20 },
  );
  const outcome = await executeRun(database, runId, { orgId: i.orgId, limits: { deadlineMs: INLINE_DEADLINE_MS } });
  // Deliverables created during this run (for API / MCP callers that want the finished work, not just the reply).
  const deliverables = outcome.deliverableIds.length
    ? await database
        .select({ id: schema.deliverables.id, title: schema.deliverables.title, preview: schema.deliverables.preview })
        .from(schema.deliverables)
        .where(and(eq(schema.deliverables.orgId, i.orgId), inArray(schema.deliverables.id, outcome.deliverableIds)))
    : [];
  return { conversationId, runId, reply: outcome.reply, deliverables };
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

/**
 * Hand over a held deliverable now instead of at its release time (Studio "Release now"). Claims the queued
 * `deliverable.release` job atomically, so the worker can never release it a second time, then runs the same
 * release handler the worker uses.
 */
export async function releaseHeldDeliverable(input: { orgId: string; runId: string; actor: Actor }): Promise<{ deliverableId: string }> {
  const i = parse(z.object({ orgId: uuid, runId: uuid, actor: actorSchema }), input);
  const database = db();
  const [job] = await database
    .update(schema.jobs)
    .set({ status: "running", lockedBy: "release-now", lockedUntil: new Date(Date.now() + 60_000), attempts: sql`${schema.jobs.attempts} + 1` })
    .where(and(eq(schema.jobs.orgId, i.orgId), eq(schema.jobs.type, "deliverable.release"), eq(schema.jobs.status, "queued"), sql`${schema.jobs.payload}->>'runId' = ${i.runId}`))
    .returning();
  if (!job) throw new EngineNotFoundError("Held deliverable");
  const [{ releaseDeliverable }, { complete, fail }] = await Promise.all([import("@/server/agents/runtime"), import("@/server/jobs/queue")]);
  try {
    await releaseDeliverable(database, job.payload);
    await complete(database, job.id);
  } catch (err) {
    await fail(database, job, err);
    throw err;
  }
  const deliverableId = String((job.payload.deliverable as { id?: unknown } | undefined)?.id ?? "");
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: "deliverable.released_early", targetType: "deliverable", targetId: deliverableId || undefined, metadata: { runId: i.runId } });
  return { deliverableId };
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
    case "approve": {
      await database.update(schema.deliverables).set({ status: "approved", needsReview: false, seenAt: d.seenAt ?? new Date(), feedback: i.feedback ?? d.feedback }).where(scope);
      // Approving an email draft is the send decision: each addressed draft goes out through the email channel.
      if (d.kind === "email_draft" && d.status !== "approved") await sendApprovedDrafts(database, d);
      await creditApprovedWork(database, d);
      await triggerEvent({ orgId: i.orgId, agentId: d.agentId, event: "deliverable.approved", payload: { deliverableId: d.id }, dedupeKey: `approved:${d.id}` });
      // Approving a revision (or the reworked original) closes the agency's "client asked for changes" alert.
      const revisedFrom = d.runId
        ? ((await database.select({ input: schema.runs.input }).from(schema.runs).where(and(eq(schema.runs.id, d.runId), eq(schema.runs.orgId, i.orgId))).limit(1))[0]?.input ?? null)
        : null;
      const originals = [d.id, ...(revisedFrom?.kind === "revision" && typeof revisedFrom.deliverableId === "string" ? [revisedFrom.deliverableId] : [])];
      await resolveChangeRequests(database, i.orgId, originals, i.actor, d.id);
      break;
    }
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
      await notifyAgencyOfChangeRequest(database, i.orgId, agent, d, i.feedback, i.actor);
      break;
    }
  }
  await audit({ orgId: i.orgId, ...actorAudit(i.actor), action: `deliverable.${i.action}`, targetType: "deliverable", targetId: d.id });
}

/**
 * Tonight's brief, from the spec as hired (title, description and workflows may all have been edited on the
 * proposal): the workflow the first deliverable is about supplies the procedure; the Architect's original
 * instructions are kept only when no workflow matches.
 */
export function firstDeliverableInstructions(spec: AgentSpec): string {
  const fd = spec.firstDeliverable;
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !/^(?:with|from|that|this|your|first|draft|week|weekly|daily|report|reports)$/.test(w)));
  const want = words(`${fd.title} ${fd.description}`);
  const scored = spec.workflows
    .map((w) => ({ w, n: [...words(`${w.name} ${w.problem}`)].filter((x) => want.has(x)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const match = scored[0]?.w ?? null;
  const parts = [
    `Produce “${fd.title}” tonight${fd.description ? ` — ${fd.description.replace(/\.$/, "")}` : ""}.`,
    match ? `Follow the procedure of the “${match.name}” workflow, using only what is in the knowledge base and memory so far:\n${match.instructions}` : fd.instructions,
    spec.workflows.length ? `You were hired for: ${spec.workflows.map((w) => w.name).join("; ")}. Show this first piece of work in the format those workflows will use.` : null,
    "Deliver it as one document. Label any assumption, and list exactly what you still need from the team.",
  ].filter((x): x is string => !!x);
  return truncate(parts.join("\n\n"), 4000);
}

/**
 * Send what a human just approved. One outbound message per addressed draft, delivered by the channels slice (simulated
 * when no provider is configured, which it records truthfully per message). Idempotent: approving twice sends once.
 */
async function sendApprovedDrafts(database: DB, d: typeof schema.deliverables.$inferSelect): Promise<void> {
  const drafts = draftsIn(d.body).slice(0, 20);
  if (!drafts.length) return;
  // Internal rules and the client's private change-request notes never leave in an email body.
  const secrets = await internalNotes(database, d.orgId, d.agentId);
  const leaks = (body: string) => sharesNoteText(body, secrets);
  // Recipients are checked again at send time, against the run that wrote the draft (an untrusted run: sender only).
  const ctx = await draftContext(database, d);
  const sent: Array<{ to: string; messageId: string }> = [];
  const held: Array<{ to: string; reason: string }> = [];
  for (const [n, e] of drafts.entries()) {
    if (leaks(`${e.subject}\n${e.body}`)) {
      held.push({ to: e.to, reason: "quotes an internal rule or a private note" });
      logger.warn({ deliverableId: d.id }, "approved draft held: it quotes internal notes");
      continue;
    }
    const problem = ctx ? await recipientProblem(ctx, "email", e.to) : null;
    if (problem) {
      held.push({ to: e.to, reason: "not a recipient this agent may write to" });
      logger.warn({ deliverableId: d.id }, "approved draft held: recipient not grounded");
      continue;
    }
    const externalId = `approved:${d.id}:${n}`;
    const prior = (await database.select({ id: schema.messages.id }).from(schema.messages).where(and(eq(schema.messages.orgId, d.orgId), eq(schema.messages.externalId, externalId))).limit(1))[0];
    let messageId = prior?.id;
    if (!messageId) {
      const [conv] = await database
        .insert(schema.conversations)
        .values({ orgId: d.orgId, agentId: d.agentId, channel: "email", subject: e.subject, externalThreadId: null })
        .returning({ id: schema.conversations.id });
      const [msg] = await database
        .insert(schema.messages)
        .values({
          orgId: d.orgId,
          conversationId: conv!.id,
          direction: "outbound",
          author: "agent",
          body: e.body,
          externalId,
          meta: { to: e.to, subject: e.subject, approvedDeliverableId: d.id },
          deliveryStatus: "pending",
          runId: d.runId,
        })
        .returning({ id: schema.messages.id });
      messageId = msg!.id;
    }
    await enqueue(database, "channel.deliver", { orgId: d.orgId, agentId: d.agentId, channel: "email", messageId, to: e.to, subject: e.subject }, { orgId: d.orgId, idempotencyKey: `deliver:${externalId}` });
    sent.push({ to: e.to, messageId });
  }
  await database
    .update(schema.deliverables)
    .set({ data: { ...(d.data ?? {}), sentDrafts: sent, ...(held.length ? { heldDrafts: held } : {}), sentAt: new Date().toISOString() } })
    .where(and(eq(schema.deliverables.id, d.id), eq(schema.deliverables.orgId, d.orgId)));
}

/** The tool context of the run that wrote a deliverable, for re-checking its draft recipients (null: written by a person). */
async function draftContext(database: DB, d: typeof schema.deliverables.$inferSelect): Promise<ToolContext | null> {
  if (!d.runId) return null;
  const run = (await database.select().from(schema.runs).where(and(eq(schema.runs.id, d.runId), eq(schema.runs.orgId, d.orgId))).limit(1))[0];
  if (!run) return null;
  const agent = await getAgent(database, d.orgId, d.agentId);
  const workflow = run.workflowId ? ((await database.select().from(schema.workflows).where(and(eq(schema.workflows.id, run.workflowId), eq(schema.workflows.orgId, d.orgId))).limit(1))[0] ?? null) : null;
  const trust = await runTrust(database, run);
  return { db: database, run, agent, workflow, trust } as unknown as ToolContext;
}

/**
 * Approved work counts toward hours saved once: a scheduled/event deliverable already carries its credit; work asked
 * for in chat (or a draft that only now became real) is credited when approved — a modest per-draft estimate,
 * never for a revision whose original already counted.
 */
async function creditApprovedWork(database: DB, d: typeof schema.deliverables.$inferSelect): Promise<void> {
  if (d.hoursSaved > 0 || d.status === "approved") return;
  const chain = [typeof d.data?.revisionOf === "string" ? d.data.revisionOf : null, typeof d.data?.previousVersionId === "string" ? d.data.previousVersionId : null].filter(
    (x): x is string => !!x,
  );
  if (chain.length) {
    const credited = await database
      .select({ id: schema.deliverables.id })
      .from(schema.deliverables)
      .where(and(eq(schema.deliverables.orgId, d.orgId), inArray(schema.deliverables.id, chain), sql`${schema.deliverables.hoursSaved} > 0`))
      .limit(1);
    if (credited[0]) return;
  }
  let hours = 0;
  if (d.workflowId) {
    const wf = (await database.select({ h: schema.workflows.hoursSavedPerRun }).from(schema.workflows).where(and(eq(schema.workflows.id, d.workflowId), eq(schema.workflows.orgId, d.orgId))).limit(1))[0];
    const runCredited = d.runId
      ? (await database.select({ id: schema.deliverables.id }).from(schema.deliverables).where(and(eq(schema.deliverables.orgId, d.orgId), eq(schema.deliverables.runId, d.runId), sql`${schema.deliverables.hoursSaved} > 0`)).limit(1))[0]
      : undefined;
    if (wf && !runCredited) hours = wf.h;
  }
  if (!hours) hours = d.kind === "email_draft" ? Math.min(1.5, 0.25 * Math.max(1, draftsIn(d.body).length)) : 0.5;
  await database
    .update(schema.deliverables)
    .set({ hoursSaved: Math.round(hours * 100) / 100 })
    .where(and(eq(schema.deliverables.id, d.id), eq(schema.deliverables.orgId, d.orgId), sql`${schema.deliverables.hoursSaved} = 0`));
}

/** Agency owners/admins of the org that runs this client (falls back to an org-wide row when none are found). */
async function agencyRecipients(database: DB, clientOrgId: string): Promise<{ agencyId: string; userIds: Array<string | null> } | null> {
  const org = await getOrg(database, clientOrgId);
  const agencyId = org.agencyId && org.agencyId !== org.id ? org.agencyId : null;
  if (!agencyId) return null;
  const rows = await database
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, agencyId), sql`${schema.memberships.role} in ('owner', 'admin')`));
  return { agencyId, userIds: rows.length ? rows.map((r) => r.userId) : [null] };
}

const changesHref = (agentId: string, deliverableId: string) => `/agents/${agentId}/activity?deliverable=${deliverableId}`;

async function notifyAgencyOfChangeRequest(database: DB, orgId: string, agent: { id: string; name: string }, d: { id: string; title: string }, feedback: string, actor: Actor) {
  const to = await agencyRecipients(database, orgId);
  const client = await getOrg(database, orgId);
  if (to) {
    await database.insert(schema.notifications).values(
      to.userIds.map((userId) => ({
        orgId: to.agencyId,
        userId,
        kind: "deliverable.changes_requested",
        title: truncate(`${client.name} asked ${agent.name} for changes on “${truncate(d.title, 80)}”`, 200),
        body: truncate(feedback, 280),
        href: changesHref(agent.id, d.id),
      })),
    );
    await audit({ orgId: to.agencyId, ...actorAudit(actor), action: "client.changes_requested", targetType: "deliverable", targetId: d.id, metadata: { clientOrgId: orgId, agentId: agent.id, feedback: truncate(feedback, 1000) } });
  }
}

async function resolveChangeRequests(database: DB, orgId: string, deliverableIds: string[], actor: Actor, approvedId: string) {
  const to = await agencyRecipients(database, orgId);
  if (!to) return;
  const d = (await database.select({ agentId: schema.deliverables.agentId }).from(schema.deliverables).where(and(eq(schema.deliverables.id, approvedId), eq(schema.deliverables.orgId, orgId))).limit(1))[0];
  if (!d) return;
  const hrefs = deliverableIds.map((id) => changesHref(d.agentId, id));
  const resolved = await database
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.orgId, to.agencyId), eq(schema.notifications.kind, "deliverable.changes_requested"), isNull(schema.notifications.readAt), inArray(schema.notifications.href, hrefs)))
    .returning({ id: schema.notifications.id });
  if (resolved.length) {
    await audit({ orgId: to.agencyId, ...actorAudit(actor), action: "client.changes_resolved", targetType: "deliverable", targetId: approvedId, metadata: { clientOrgId: orgId, resolvedFor: deliverableIds } });
  }
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
export async function resellAgent(input: {
  orgId: string;
  agentId: string;
  customerOrgId: string;
  actor: Actor;
  /** Knowledge the reseller chose to share (theirs, for this agent or org-wide). Nothing is copied by default. */
  shareKnowledgeSourceIds?: string[];
}): Promise<{ agentId: string }> {
  const i = parse(
    z.object({ orgId: uuid, agentId: uuid, customerOrgId: uuid, actor: actorSchema, shareKnowledgeSourceIds: z.array(uuid).max(100).optional() }),
    input,
  );
  const database = db();
  const source = await getAgent(database, i.orgId, i.agentId);
  const customer = await getOrg(database, i.customerOrgId);
  if (customer.parentId !== i.orgId || customer.kind !== "customer") throw new EngineNotFoundError("Customer organization");
  const reseller = await getOrg(database, i.orgId);

  // Only sources the reseller ticked, and only ones that are theirs: this agent's or org-wide, never a discovery call.
  const shareIds = [...new Set(i.shareKnowledgeSourceIds ?? [])];
  const sources = shareIds.length
    ? await database
        .select()
        .from(schema.knowledgeSources)
        .where(
          and(
            eq(schema.knowledgeSources.orgId, i.orgId),
            inArray(schema.knowledgeSources.id, shareIds),
            or(eq(schema.knowledgeSources.agentId, source.id), isNull(schema.knowledgeSources.agentId)),
            ne(schema.knowledgeSources.kind, "transcript"),
          ),
        )
    : [];
  if (sources.length !== shareIds.length) throw new EngineNotFoundError("Knowledge source");

  // Re-target the clone at the customer: the role (for the customer's industry), voice, workflows and generic
  // procedure — not the reseller's people, accounts, rules, call quotes, memories or unshared files. The reseller is
  // credited as the provider.
  const retargeted = retargetSpec(await specFromAgent(database, i.orgId, source.id), reseller.name, customer.name);
  const scrub = await resalePrivate(database, { orgId: i.orgId, agentId: source.id, spec: retargeted, sharedSourceIds: sources.map((s) => s.id), customerName: customer.name });
  const spec = genericForResale(retargeted, scrub, source.name, {
    customerName: customer.name,
    resellerName: reseller.name,
    customerIndustry: customer.industry,
    resellerIndustry: reseller.industry,
  });
  const { agentId } = await hireAgent({ orgId: customer.id, spec, actor: i.actor, sourceAgentId: source.id, monthlyBudgetCents: source.config.monthlyBudgetCents });

  for (const s of sources.filter((x) => x.status === "ready")) {
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
  await audit({
    orgId: i.orgId,
    ...actorAudit(i.actor),
    action: "agent.resold",
    targetType: "agent",
    targetId: source.id,
    metadata: { customerOrgId: customer.id, newAgentId: agentId, sharedKnowledgeSourceIds: sources.map((x) => x.id) },
  });
  return { agentId };
}

export { LlmError, draftsIn, genericForResale, retargetSpec };
