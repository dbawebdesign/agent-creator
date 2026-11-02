/**
 * Regression tests for engine critique r1: H1 (enforceable approvals), H4 (crash-safe side effects), M1 (tool error
 * after approval), M2 (indexes), M3 (overnight schedule + release + failure alerts), M4 (spend guards, caching).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { normalizeApprovals } from "@/server/agents/spec";
import { TOOLS } from "@/server/agents/tools";
import { requiresApproval, type ToolContext } from "@/server/agents/tools/types";
import { executeRun } from "@/server/agents/runtime";
import { db, schema } from "@/server/db/client";
import { runJobsOnce } from "@/server/jobs/handlers";
import { firstDeliverableSchedule } from "@/server/jobs/scheduler";
import { setLlmProviderForTests, type LlmProvider, type LlmResponse } from "@/server/llm";
import { decideApproval, hireAgent, runWorkflowNow, startConversationRun } from "@/server/services/engine";
import { makeJobsDue, makeOrgs, resetDb, tzAtLocalHour } from "./engine.helpers";

const HVAC = readFileSync(path.join(__dirname, "fixtures", "discovery-hvac.md"), "utf8");

async function hire(opts: { timezone?: string; requireApprovalFor?: string[]; config?: Record<string, unknown> } = {}) {
  const orgs = await makeOrgs({ clientName: "Comfort HVAC", industry: "HVAC", timezone: opts.timezone ?? tzAtLocalHour(12) });
  const base = heuristicSpec({ transcript: HVAC, orgName: orgs.client.name, industry: "HVAC" });
  const spec = { ...base, requireApprovalFor: opts.requireApprovalFor ?? base.requireApprovalFor };
  const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "user", userId: orgs.user.id } });
  if (opts.config) {
    const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
    await db().update(schema.agents).set({ config: { ...a!.config, ...opts.config } }).where(eq(schema.agents.id, agentId));
  }
  const [wf] = await db().select().from(schema.workflows).where(eq(schema.workflows.agentId, agentId));
  return { ...orgs, agentId, workflowId: wf!.id };
}

const U = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
function reply(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>, text = ""): LlmResponse {
  return {
    model: "roster-offline-1",
    stopReason: calls.length ? "tool_use" : "end_turn",
    text,
    toolCalls: calls,
    assistantContent: [...(text ? [{ type: "text" as const, text }] : []), ...calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input }))],
    usage: U,
  };
}
/** Scripted model: first turn returns `first` (fresh ids per call, so a re-asked model would look different), then ends. */
function scripted(first: (n: number) => Array<{ name: string; input: Record<string, unknown> }>) {
  const calls = { firstTurn: 0, total: 0 };
  const provider: LlmProvider = {
    id: "offline",
    async chat(req) {
      calls.total++;
      const hasResults = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
      if (hasResults) return reply([], "Done.");
      calls.firstTurn++;
      return reply(first(calls.firstTurn).map((c, i) => ({ id: `toolu_${calls.firstTurn}_${i}`, ...c })));
    },
  };
  return { provider, calls };
}

const originalRun = { followup: TOOLS.schedule_followup!.run, send: TOOLS.send_message!.run };
afterEach(() => {
  setLlmProviderForTests(null);
  TOOLS.schedule_followup!.run = originalRun.followup;
  TOOLS.send_message!.run = originalRun.send;
});

describe("H1: approval rules are enforceable", () => {
  beforeEach(resetDb);

  it("normalizes requireApprovalFor to actions the tools emit, always including email + SMS", () => {
    const n = normalizeApprovals(["send_invoice", "computer_type", "send_external_email", "spend_money"]);
    expect(n.actions).toEqual(["send_external_email", "send_external_sms", "write_client_system"]);
    expect(n.unenforceable).toEqual(["send_invoice", "spend_money"]);
    expect(requiresApproval("computer_bash", new Set(["write_client_system"]))).toBe(true);
    expect(requiresApproval("send_external_slack", new Set(["send_external_email"]))).toBe(true);
    expect(requiresApproval("send_external_slack", new Set<string>())).toBe(false);
  });

  it("hireAgent stores only enforceable approvals and records the rest; computer writes are gated", async () => {
    const { agentId } = await hire({ requireApprovalFor: ["send_invoice", "computer_click"] });
    const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(agent!.config.requireApprovalFor).toEqual(["send_external_email", "send_external_sms", "write_client_system"]);
    const [log] = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.targetId, agentId), eq(schema.auditLogs.action, "agent.hired")));
    expect(log!.metadata).toMatchObject({ unenforceableApprovals: ["send_invoice"] });
    const ctx = {} as ToolContext;
    expect(await TOOLS.computer_type!.approvalAction!({ text: "x" }, ctx)).toBe("write_client_system");
    expect(await TOOLS.computer_click!.approvalAction!({ x: 1, y: 2 }, ctx)).toBe("write_client_system");
    expect(await TOOLS.computer_key!.approvalAction!({ key: "Enter" }, ctx)).toBe("write_client_system");
  });
});

describe("H4/M1: crash-safe tool calls", () => {
  beforeEach(resetDb);

  it("a crash mid-turn resumes the same tool calls: no re-asked model, no duplicate deliverable or follow-up", async () => {
    const { client, workflowId } = await hire();
    await db().execute(sql`delete from jobs where org_id = ${client.id}`);
    const { provider, calls } = scripted((n) => [
      { name: "create_deliverable", input: { title: `Dispatch board v${n}`, body: "| time | job |\n|---|---|\n| 8:00 | no-heat |" } },
      { name: "schedule_followup", input: { task: "Check the no-heat call got a tech", inHours: 2 } },
    ]);
    setLlmProviderForTests(provider);
    const { runId } = await runWorkflowNow({ orgId: client.id, workflowId, actor: { type: "system" } });

    // Executor 1 dies inside the second tool (after the deliverable was committed).
    let hung = false;
    TOOLS.schedule_followup!.run = () => {
      hung = true;
      return new Promise(() => undefined);
    };
    void executeRun(db(), runId, { orgId: client.id });
    for (let i = 0; i < 100 && !hung; i++) await new Promise((r) => setTimeout(r, 20));
    expect(hung).toBe(true);
    // Its lease runs out; executor 2 picks the run up.
    await db().execute(sql`update run_steps set data = jsonb_set(data, '{until}', '"2000-01-01T00:00:00.000Z"') where run_id = ${runId} and seq = -1`);
    TOOLS.schedule_followup!.run = originalRun.followup;
    const out = await executeRun(db(), runId, { orgId: client.id });
    expect(out.status).toBe("succeeded");

    expect(calls.firstTurn).toBe(1); // the model was not asked again for the same turn
    const ds = await db().select().from(schema.deliverables).where(eq(schema.deliverables.runId, runId));
    expect(ds.map((d) => d.title)).toEqual(["Dispatch board v1"]);
    const followups = await db().execute(sql`select id from runs where input->>'parentRunId' = ${runId}`);
    expect(followups.rows).toHaveLength(1);
    const results = await db().execute(sql`select data->>'toolUseId' as id from run_steps where run_id = ${runId} and kind = 'tool_result'`);
    expect((results.rows as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(["toolu_1_0", "toolu_1_1"]);
  });

  it("schedule_followup is idempotent per tool call", async () => {
    const { client, agentId, workflowId } = await hire();
    const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
    const { runId } = await runWorkflowNow({ orgId: client.id, workflowId, actor: { type: "system" } });
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, runId));
    const ctx = {
      db: db(),
      run: run!,
      agent: agent!,
      org: client,
      workflow: null,
      toolUseId: "toolu_same",
      trust: { trusted: true, reason: "t", sender: null, authenticated: true, participant: null },
      state: { deliverableIds: [], followups: 0, messagesSent: 0 },
    } as ToolContext;
    const a = JSON.parse((await TOOLS.schedule_followup!.run({ task: "Check again tomorrow", inHours: 24 }, ctx)).content) as { runId: string };
    const b = JSON.parse((await TOOLS.schedule_followup!.run({ task: "Check again tomorrow", inHours: 24 }, ctx)).content) as { runId: string; duplicate?: boolean };
    expect(b).toMatchObject({ runId: a.runId, duplicate: true });
    const jobs = await db().execute(sql`select id from jobs where idempotency_key = ${`followup:${runId}:toolu_same`}`);
    expect(jobs.rows).toHaveLength(1);
  });

  it("a tool that throws after approval is recorded as failed and never asks for approval again", async () => {
    const { client, user, workflowId } = await hire();
    await db().execute(sql`delete from jobs where org_id = ${client.id}`);
    const { provider } = scripted(() => [{ name: "send_message", input: { channel: "email", to: "customer@outside.example", subject: "Estimate", text: "Your estimate is ready." } }]);
    setLlmProviderForTests(provider);
    const { runId } = await runWorkflowNow({ orgId: client.id, workflowId, actor: { type: "system" } });
    await runJobsOnce({ types: ["agent.run"] });
    const [ap] = await db().select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
    expect(ap!.action).toBe("send_external_email");
    TOOLS.send_message!.run = async () => {
      throw new Error("provider exploded");
    };
    await decideApproval({ orgId: client.id, approvalId: ap!.id, decision: "approved", actor: { type: "user", userId: user.id } });
    await runJobsOnce({ types: ["agent.run"] });
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run!.status).toBe("succeeded");
    expect(await db().select().from(schema.approvals).where(eq(schema.approvals.runId, runId))).toHaveLength(1);
    const res = await db().execute(sql`select data from run_steps where run_id = ${runId} and kind = 'tool_result' and name = 'send_message'`);
    expect(JSON.stringify(res.rows[0])).toContain("Tool failed after approval");
  });
});

describe("M2: indexes", () => {
  it("has the engine indexes", async () => {
    const r = await db().execute(sql`select indexname from pg_indexes where indexname in
      ('runs_conversation_idx','messages_run_idx','deliverables_run_idx','approvals_pending_created_idx','run_steps_tool_result_uq')`);
    expect(r.rows).toHaveLength(5);
  });
});

describe("M3: overnight schedule, release, failure alerts", () => {
  beforeEach(resetDb);

  it("works from ~1 AM and hands over at 6 AM local", () => {
    const tz = "America/Chicago"; // CST (UTC-6) in early November 2026
    const at = (iso: string) => new Date(iso);
    expect(firstDeliverableSchedule(tz, at("2026-11-03T06:30:00Z"))).toEqual({ runAt: at("2026-11-03T07:00:00Z"), releaseAt: at("2026-11-03T12:00:00Z") }); // 00:30
    expect(firstDeliverableSchedule(tz, at("2026-11-03T09:00:00Z"))).toEqual({ runAt: at("2026-11-03T09:00:00Z"), releaseAt: at("2026-11-03T12:00:00Z") }); // 03:00
    expect(firstDeliverableSchedule(tz, at("2026-11-03T20:00:00Z"))).toEqual({ runAt: at("2026-11-03T20:00:00Z"), releaseAt: null }); // 14:00
  });

  it("a deliverable finished before 6 AM stays out of the portal until its release job runs", async () => {
    const { client, agentId } = await hire({ timezone: tzAtLocalHour(3) });
    const [run] = await db().select().from(schema.runs).where(and(eq(schema.runs.agentId, agentId), eq(schema.runs.trigger, "setup")));
    expect(typeof run!.input.releaseAt).toBe("string");
    await runJobsOnce({ types: ["knowledge.index", "agent.run"], max: 5 });
    const [done] = await db().select().from(schema.runs).where(eq(schema.runs.id, run!.id));
    expect(done!.status).toBe("succeeded");
    expect(await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId))).toHaveLength(0);
    const rel = await db().execute(sql`select run_at from jobs where type = 'deliverable.release' and org_id = ${client.id}`);
    expect(rel.rows).toHaveLength(1);
    expect(new Date((rel.rows[0] as { run_at: string }).run_at).toISOString()).toBe(run!.input.releaseAt);

    await makeJobsDue();
    await runJobsOnce({ types: ["deliverable.release"] });
    const ds = await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId));
    expect(ds).toHaveLength(1);
    const notes = await db().select().from(schema.notifications).where(and(eq(schema.notifications.orgId, client.id), eq(schema.notifications.kind, "deliverable.created")));
    expect(notes).toHaveLength(1);
  });

  it("a budget-stopped run alerts the agency (once)", async () => {
    const { agency, client, workflowId } = await hire({ config: { monthlyBudgetCents: 0 } });
    await db().execute(sql`delete from jobs where org_id = ${client.id}`);
    const { runId } = await runWorkflowNow({ orgId: client.id, workflowId, actor: { type: "system" } });
    await runJobsOnce({ types: ["agent.run"] });
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run!.status).toBe("failed");
    const notes = await db().select().from(schema.notifications).where(and(eq(schema.notifications.orgId, agency.id), eq(schema.notifications.kind, "run.failed")));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toMatch(/budget/i);
    expect(await db().select().from(schema.notifications).where(and(eq(schema.notifications.orgId, client.id), eq(schema.notifications.kind, "run.failed")))).toHaveLength(0);
  });
});

describe("M4: inbound spend guards", () => {
  beforeEach(resetDb);

  async function inbound(orgId: string, agentId: string, body: string) {
    const [conv] = await db().insert(schema.conversations).values({ orgId, agentId, channel: "portal", subject: "Hi" }).returning();
    const [msg] = await db().insert(schema.messages).values({ orgId, conversationId: conv!.id, author: "contact", direction: "inbound", body }).returning();
    return startConversationRun({ orgId, agentId, conversationId: conv!.id, messageId: msg!.id });
  }

  it("caps inbound runs per agent per hour (extra messages are stored, not run)", async () => {
    const { client, agentId } = await hire({ config: { inboundRunsPerHour: 1 } });
    await inbound(client.id, agentId, "first");
    const second = await inbound(client.id, agentId, "second");
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, second.runId));
    expect(run!.status).toBe("canceled");
    expect(run!.error).toMatch(/Inbound limit/);
  });

  it("inbound runs stop at their share of the monthly budget", async () => {
    const { client, agentId } = await hire({ config: { monthlyBudgetCents: 100, inboundBudgetShare: 0.1 } });
    await db().execute(sql`delete from jobs where org_id = ${client.id}`);
    const [old] = await db().insert(schema.runs).values({ orgId: client.id, agentId, trigger: "message", status: "succeeded", input: { kind: "message" } }).returning();
    await db().insert(schema.usageEvents).values({ orgId: client.id, agentId, runId: old!.id, kind: "llm", model: "claude-opus-5-5", costMicros: 200_000 }); // 20¢ > 10¢ share
    const { runId } = await inbound(client.id, agentId, "hello?");
    await runJobsOnce({ types: ["agent.run"] });
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run!.status).toBe("failed");
    expect(run!.error).toMatch(/inbound messages/);
  });
});
