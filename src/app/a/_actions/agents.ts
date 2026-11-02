"use server";

import { CronExpressionParser } from "cron-parser";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { agentSpec, channelKind, type AgentSpec } from "@/server/agents/spec";
import { db, schema } from "@/server/db/client";
import {
  addKnowledge,
  createDiscovery,
  hireAgent,
  runWorkflowNow,
  saveBlueprint,
  setAgentStatus,
} from "@/server/services/engine";
import { getDiscovery, provisioningStatus } from "@/server/queries/studio";
import { fail, insertClientOrg, studio, studioAgent, studioClient, type Result } from "./ctx";

const uuid = z.uuid();

const startInput = z.object({
  agency: z.string().min(1).max(64),
  clientId: uuid.optional(),
  newClient: z
    .object({ name: z.string().trim().min(2).max(80), industry: z.string().trim().max(80).optional(), website: z.string().trim().max(200).optional() })
    .optional(),
  title: z.string().trim().max(120).optional(),
  transcript: z.string().trim().min(200, "Paste the full call — at least a few paragraphs.").max(200_000, "That transcript is too long (200k characters max)."),
});

export async function startDiscovery(raw: z.input<typeof startInput>): Promise<Result<{ discoveryId: string; clientId: string }>> {
  const parsed = startInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  const { agency: slug, clientId, newClient, transcript } = parsed.data;
  try {
    const ctx = await studio(slug, "member");
    let orgId = clientId;
    let orgName = "";
    if (orgId) {
      const c = await studioClient(slug, orgId, "member");
      orgName = c.client.name;
    } else if (newClient) {
      const org = await insertClientOrg(ctx.agency.id, newClient);
      orgId = org.id;
      orgName = org.name;
    } else {
      return { ok: false, error: "Choose a client first." };
    }
    const title = parsed.data.title || `Discovery call — ${orgName}`;
    const { discoveryId } = await createDiscovery({ orgId, title, transcript, actor: ctx.actor });
    revalidatePath(`/a/${slug}`, "layout");
    return { ok: true, discoveryId, clientId: orgId };
  } catch (err) {
    return fail(err, "The Architect couldn’t start. Try again.");
  }
}

export async function pollDiscovery(slug: string, discoveryId: string) {
  const ctx = await studio(slug, "member");
  const row = await getDiscovery(ctx.agency.id, discoveryId);
  if (!row) return { status: "missing" as const };
  return {
    status: row.d.status,
    error: row.d.error,
    proposal: row.d.proposal as AgentSpec | null,
    agentId: row.d.agentId,
    clientId: row.d.orgId,
    clientName: row.orgName,
    title: row.d.title,
  };
}

const hireInput = z.object({
  agency: z.string().min(1).max(64),
  clientId: uuid,
  discoveryId: uuid.optional(),
  blueprintId: uuid.optional(),
  spec: z.unknown(),
});

export async function hire(raw: z.input<typeof hireInput>): Promise<Result<{ agentId: string }>> {
  const parsed = hireInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const spec = agentSpec.safeParse(parsed.data.spec);
  if (!spec.success) {
    const i = spec.error.issues[0];
    return { ok: false, error: i ? `${i.path.join(" › ") || "Proposal"}: ${i.message}` : "The proposal is incomplete." };
  }
  try {
    const ctx = await studioClient(parsed.data.agency, parsed.data.clientId, "member");
    if (parsed.data.blueprintId) {
      const bp = await db()
        .select({ id: schema.blueprints.id })
        .from(schema.blueprints)
        .where(and(eq(schema.blueprints.id, parsed.data.blueprintId), eq(schema.blueprints.orgId, ctx.agency.id)))
        .limit(1);
      if (!bp[0]) return { ok: false, error: "Blueprint not found" };
    }
    const { agentId } = await hireAgent({
      orgId: ctx.client.id,
      spec: spec.data,
      discoveryId: parsed.data.discoveryId,
      blueprintId: parsed.data.blueprintId,
      actor: ctx.actor,
    });
    revalidatePath(`/a/${parsed.data.agency}`, "layout");
    return { ok: true, agentId };
  } catch (err) {
    return fail(err, "Hiring failed. Your proposal is safe — try again.");
  }
}

export async function pollProvisioning(slug: string, agentId: string) {
  const ctx = await studio(slug, "viewer");
  return provisioningStatus(ctx.agency.id, agentId);
}

const updateAgentInput = z.object({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(2).max(80),
  summary: z.string().trim().max(280),
  instructions: z.string().trim().min(20, "Instructions need at least a few sentences.").max(12000),
  voice: z.string().trim().max(400),
  requireApprovalFor: z.array(z.string().max(60)).max(20),
});

export async function updateAgent(slug: string, agentId: string, raw: z.input<typeof updateAgentInput>): Promise<Result> {
  const parsed = updateAgentInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  try {
    const ctx = await studioAgent(slug, agentId, "member");
    const { voice, requireApprovalFor, ...rest } = parsed.data;
    await db()
      .update(schema.agents)
      .set({ ...rest, config: { ...ctx.agent.config, voice, requireApprovalFor } })
      .where(and(eq(schema.agents.id, ctx.agent.id), eq(schema.agents.orgId, ctx.agent.orgId)));
    revalidatePath(`/a/${slug}/agents/${agentId}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function changeAgentStatus(slug: string, agentId: string, status: "active" | "paused" | "archived"): Promise<Result> {
  if (!["active", "paused", "archived"].includes(status)) return { ok: false, error: "Invalid status" };
  try {
    const ctx = await studioAgent(slug, agentId, status === "archived" ? "admin" : "member");
    await setAgentStatus({ orgId: ctx.agent.orgId, agentId: ctx.agent.id, status, actor: ctx.actor });
    revalidatePath(`/a/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function saveAsBlueprint(slug: string, agentId: string, name: string): Promise<Result<{ blueprintId: string }>> {
  const n = z.string().trim().min(2).max(80).safeParse(name);
  if (!n.success) return { ok: false, error: "Give the blueprint a name" };
  try {
    const ctx = await studioAgent(slug, agentId, "member");
    const { blueprintId } = await saveBlueprint({ agencyId: ctx.agency.id, agentId: ctx.agent.id, name: n.data, actor: ctx.actor });
    revalidatePath(`/a/${slug}/blueprints`);
    return { ok: true, blueprintId };
  } catch (err) {
    return fail(err);
  }
}

export async function runNow(slug: string, agentId: string, workflowId: string): Promise<Result<{ runId: string }>> {
  if (!uuid.safeParse(workflowId).success) return { ok: false, error: "Invalid workflow" };
  try {
    const ctx = await studioAgent(slug, agentId, "member");
    const wf = await db()
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.agentId, ctx.agent.id), eq(schema.workflows.orgId, ctx.agent.orgId)))
      .limit(1);
    if (!wf[0]) return { ok: false, error: "Workflow not found" };
    const { runId } = await runWorkflowNow({ orgId: ctx.agent.orgId, workflowId, actor: ctx.actor });
    revalidatePath(`/a/${slug}/agents/${agentId}`, "layout");
    return { ok: true, runId };
  } catch (err) {
    return fail(err);
  }
}

function nextRun(cron: string, tz: string): Date | null {
  try {
    return CronExpressionParser.parse(cron, { tz }).next().toDate();
  } catch {
    return null;
  }
}

const workflowInput = z.object({
  name: z.string().trim().min(2).max(80),
  instructions: z.string().trim().min(10).max(6000),
  cron: z.string().trim().min(9).max(64).optional(),
  deliverTo: z.array(channelKind).min(1, "Pick at least one delivery channel"),
  hoursSavedPerRun: z.number().min(0).max(200),
  enabled: z.boolean(),
});

export async function updateWorkflow(slug: string, agentId: string, workflowId: string, raw: z.input<typeof workflowInput>): Promise<Result> {
  const parsed = workflowInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  try {
    const ctx = await studioAgent(slug, agentId, "member");
    const [wf] = await db()
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.agentId, ctx.agent.id), eq(schema.workflows.orgId, ctx.agent.orgId)))
      .limit(1);
    if (!wf) return { ok: false, error: "Workflow not found" };
    let trigger = wf.trigger;
    if (wf.trigger.type === "schedule" && parsed.data.cron) {
      if (!nextRun(parsed.data.cron, ctx.org.timezone)) return { ok: false, error: "That schedule isn’t valid" };
      trigger = { ...wf.trigger, cron: parsed.data.cron };
    }
    const next = trigger.type === "schedule" && parsed.data.enabled ? nextRun(trigger.cron, trigger.timezone ?? ctx.org.timezone) : null;
    await db()
      .update(schema.workflows)
      .set({
        name: parsed.data.name,
        instructions: parsed.data.instructions,
        deliverTo: parsed.data.deliverTo,
        hoursSavedPerRun: parsed.data.hoursSavedPerRun,
        enabled: parsed.data.enabled,
        trigger,
        nextRunAt: next,
      })
      .where(and(eq(schema.workflows.id, wf.id), eq(schema.workflows.orgId, ctx.agent.orgId)));
    revalidatePath(`/a/${slug}/agents/${agentId}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleWorkflow(slug: string, agentId: string, workflowId: string, enabled: boolean): Promise<Result> {
  try {
    const ctx = await studioAgent(slug, agentId, "member");
    const [wf] = await db()
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.agentId, ctx.agent.id), eq(schema.workflows.orgId, ctx.agent.orgId)))
      .limit(1);
    if (!wf) return { ok: false, error: "Workflow not found" };
    const next = enabled && wf.trigger.type === "schedule" ? nextRun(wf.trigger.cron, wf.trigger.timezone ?? ctx.org.timezone) : null;
    await db().update(schema.workflows).set({ enabled: !!enabled, nextRunAt: next }).where(and(eq(schema.workflows.id, wf.id), eq(schema.workflows.orgId, ctx.agent.orgId)));
    revalidatePath(`/a/${slug}/agents/${agentId}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

const knowledgeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), title: z.string().trim().min(2).max(120), content: z.string().trim().min(20, "Add a little more text").max(200_000) }),
  z.object({ kind: z.literal("url"), title: z.string().trim().max(120).optional(), url: z.url("Enter a full URL, like https://…").max(2000) }),
]);

export async function addKnowledgeSource(slug: string, agentId: string, raw: z.input<typeof knowledgeInput>): Promise<Result<{ sourceId: string }>> {
  const parsed = knowledgeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  try {
    const ctx = await studioAgent(slug, agentId, "member");
    const d = parsed.data;
    const { sourceId } =
      d.kind === "text"
        ? await addKnowledge({ orgId: ctx.agent.orgId, agentId: ctx.agent.id, title: d.title, kind: "text", content: d.content, actor: ctx.actor })
        : await addKnowledge({ orgId: ctx.agent.orgId, agentId: ctx.agent.id, title: d.title || new URL(d.url).hostname, kind: "url", url: d.url, actor: ctx.actor });
    revalidatePath(`/a/${slug}/agents/${agentId}/knowledge`);
    return { ok: true, sourceId };
  } catch (err) {
    return fail(err);
  }
}

export async function forgetMemory(slug: string, agentId: string, memoryId: string): Promise<Result> {
  if (!uuid.safeParse(memoryId).success) return { ok: false, error: "Invalid memory" };
  try {
    const ctx = await studioAgent(slug, agentId, "member");
    await db()
      .delete(schema.memories)
      .where(and(eq(schema.memories.id, memoryId), eq(schema.memories.agentId, ctx.agent.id), eq(schema.memories.orgId, ctx.agent.orgId)));
    revalidatePath(`/a/${slug}/agents/${agentId}/memory`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function decide(slug: string, approvalId: string, decision: "approved" | "rejected"): Promise<Result> {
  if (!uuid.safeParse(approvalId).success || !["approved", "rejected"].includes(decision)) return { ok: false, error: "Invalid request" };
  try {
    const ctx = await studio(slug, "member");
    const { agencyOrgIds } = await import("@/server/queries/studio");
    const ids = await agencyOrgIds(ctx.agency.id);
    const [row] = await db().select({ id: schema.approvals.id, orgId: schema.approvals.orgId }).from(schema.approvals).where(eq(schema.approvals.id, approvalId)).limit(1);
    if (!row || !ids.includes(row.orgId)) return { ok: false, error: "Approval not found" };
    const { decideApproval } = await import("@/server/services/engine");
    await decideApproval({ orgId: row.orgId, approvalId, decision, actor: ctx.actor });
    revalidatePath(`/a/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
