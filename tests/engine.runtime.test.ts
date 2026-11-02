import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { executeRun } from "@/server/agents/runtime";
import { db, schema } from "@/server/db/client";
import { runJobsOnce } from "@/server/jobs/handlers";
import { searchKnowledge } from "@/server/knowledge";
import { setHttpFetchLookupForTests } from "@/server/agents/tools/web-computer";
import { setLlmProviderForTests, type LlmProvider } from "@/server/llm";
import {
  decideApproval,
  EngineNotFoundError,
  hireAgent,
  messageAgent,
  resellAgent,
  reviewDeliverable,
  runWorkflowNow,
  setAgentStatus,
} from "@/server/services/engine";
import { firstDeliverableSchedule } from "@/server/jobs/scheduler";
import { makeCustomer, makeJobsDue, makeOrgs, resetDb, tzAtLocalHour } from "./engine.helpers";

const PODCAST = readFileSync(path.join(__dirname, "fixtures", "podcast-ai-employees.md"), "utf8");

// Midday local time by default: the first deliverable runs now and is handed over as soon as it is done.
async function hireFromTranscript(timezone = tzAtLocalHour(12)) {
  const orgs = await makeOrgs({ clientName: "Summit Promo Co", industry: "Promotional products distribution", timezone });
  const [disc] = await db()
    .insert(schema.discoveries)
    .values({ orgId: orgs.client.id, title: "Kickoff", transcript: PODCAST, status: "ready" })
    .returning();
  const spec = heuristicSpec({ transcript: PODCAST, orgName: orgs.client.name, industry: orgs.client.industry });
  const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, discoveryId: disc!.id, actor: { type: "user", userId: orgs.user.id } });
  return { ...orgs, spec, agentId, discoveryId: disc!.id };
}

const jobsOf = async (type: string) =>
  (await db().execute(sql`select id, payload, run_at, status, idempotency_key from jobs where type = ${type} order by created_at`)).rows as Array<{
    id: string;
    payload: Record<string, unknown>;
    run_at: Date;
    status: string;
    idempotency_key: string | null;
  }>;

describe("hireAgent", () => {
  beforeEach(resetDb);

  it("provisions the full stack and schedules the first deliverable (work ~1 AM, hand over at 6 AM local)", async () => {
    const before = new Date();
    const { client, agentId, spec, discoveryId } = await hireFromTranscript("America/Chicago");
    const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(agent).toMatchObject({ status: "active", orgId: client.id, name: spec.name, role: "Quoting Specialist" });
    expect(agent!.emailHandle).toBe(spec.name.toLowerCase());
    expect(agent!.activatedAt).toBeInstanceOf(Date);
    expect(agent!.config.requireApprovalFor).toContain("send_external_email");
    expect(agent!.config.monthlyBudgetCents).toBeGreaterThan(0);

    const wfs = await db().select().from(schema.workflows).where(eq(schema.workflows.agentId, agentId));
    expect(wfs).toHaveLength(spec.workflows.length);
    for (const w of wfs) {
      if (w.trigger.type === "schedule") {
        expect(w.trigger.timezone).toBe("America/Chicago");
        expect(w.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      } else expect(w.nextRunAt).toBeNull();
    }
    const mems = await db().select().from(schema.memories).where(eq(schema.memories.agentId, agentId));
    expect(mems.length).toBe(spec.seedMemories.length);

    const [src] = await db().select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.agentId, agentId));
    expect(src).toMatchObject({ kind: "transcript", status: "ready" });
    expect(src!.chunkCount).toBeGreaterThan(5);
    const hits = await searchKnowledge(db(), { orgId: client.id, agentId, query: "quotes presentation promotional products" });
    expect(hits[0]?.content).toMatch(/quote/i);

    const conns = await db().select().from(schema.channelConnections).where(eq(schema.channelConnections.agentId, agentId));
    expect(conns.map((c) => c.kind).sort()).toEqual(["email", "portal"]);
    expect(conns.find((c) => c.kind === "email")!.externalId).toMatch(new RegExp(`^${agent!.emailHandle}@`));

    const runs = await db().select().from(schema.runs).where(eq(schema.runs.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "setup", status: "queued" });
    expect(runs[0]!.input.title).toBe(spec.firstDeliverable.title);
    const [job] = await jobsOf("agent.run");
    expect(job!.payload).toMatchObject({ runId: runs[0]!.id, orgId: client.id });
    const expected = firstDeliverableSchedule("America/Chicago", before);
    expect(Math.abs(new Date(job!.run_at).getTime() - expected.runAt.getTime())).toBeLessThan(5_000);
    if (expected.releaseAt) expect(runs[0]!.input.releaseAt).toBe(expected.releaseAt.toISOString());
    else expect(runs[0]!.input.releaseAt).toBeUndefined();
    expect(new Date(job!.run_at).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);

    const [disc] = await db().select().from(schema.discoveries).where(eq(schema.discoveries.id, discoveryId));
    expect(disc).toMatchObject({ status: "hired", agentId });
    const logs = await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, agentId));
    expect(logs.map((l) => l.action)).toContain("agent.hired");
  });

  it("re-hiring the same discovery is idempotent and a second agent with the same name gets a unique handle", async () => {
    const { client, user, spec, agentId, discoveryId } = await hireFromTranscript();
    const again = await hireAgent({ orgId: client.id, spec, discoveryId, actor: { type: "user", userId: user.id } });
    expect(again.agentId).toBe(agentId);
    const other = await hireAgent({ orgId: client.id, spec, actor: { type: "user", userId: user.id } });
    const [a, b] = await Promise.all([agentId, other.agentId].map(async (id) => (await db().select().from(schema.agents).where(eq(schema.agents.id, id)))[0]!));
    expect(b!.emailHandle).toMatch(new RegExp(`^${a!.emailHandle}-[0-9a-f]{4}$`));
  });

  it("rejects invalid specs and foreign discoveries", async () => {
    const { client, user, spec } = await hireFromTranscript();
    const bad = { ...spec, workflows: [{ ...spec.workflows[0]!, trigger: { type: "schedule" as const, cron: "61 25 * * *" } }] };
    await expect(hireAgent({ orgId: client.id, spec: bad, actor: { type: "user", userId: user.id } })).rejects.toThrow(/Invalid schedule/);
    const other = await makeOrgs();
    const [foreign] = await db().insert(schema.discoveries).values({ orgId: other.client.id, title: "x", transcript: PODCAST }).returning();
    await expect(hireAgent({ orgId: client.id, spec, discoveryId: foreign!.id, actor: { type: "system" } })).rejects.toBeInstanceOf(EngineNotFoundError);
  });
});

describe("runtime (offline model)", () => {
  beforeEach(resetDb);
  afterEach(() => setLlmProviderForTests(null));

  it("runs the overnight deliverable: knowledge search → deliverable with a GFM table, steps, metering, delivery jobs", async () => {
    const { client, agentId } = await hireFromTranscript();
    await makeJobsDue();
    expect(await runJobsOnce({ types: ["agent.run"] })).toBe(1);
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.agentId, agentId));
    expect(run).toMatchObject({ status: "succeeded", error: null });
    expect(run!.inputTokens).toBeGreaterThan(0);
    expect(run!.finishedAt).toBeInstanceOf(Date);

    const steps = await db().select().from(schema.runSteps).where(eq(schema.runSteps.runId, run!.id)).orderBy(schema.runSteps.seq);
    const toolCalls = steps.filter((s) => s.kind === "tool_call").map((s) => s.name);
    expect(toolCalls).toEqual(expect.arrayContaining(["knowledge_search", "memory_recall", "create_deliverable"]));
    expect(toolCalls.indexOf("knowledge_search")).toBeLessThan(toolCalls.indexOf("create_deliverable"));
    expect(steps.filter((s) => s.kind === "message").length).toBeGreaterThanOrEqual(3);

    const [d] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId));
    expect(d!.title).toMatch(/quote kit/i);
    expect(d!.body).toMatch(/\| # \| Step \| Status \| Based on \|/);
    expect(d!.body).toMatch(/## The work/);
    expect(d!.body).toMatch(/20 hours a week/); // grounded in the transcript via knowledge_search
    expect(d!.needsReview).toBe(true);
    expect(d!.hoursSaved).toBeGreaterThan(0);

    const usage = await db().select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, run!.id));
    expect(usage.length).toBe(steps.filter((s) => s.kind === "message").length);
    expect(usage.every((u) => u.model === "roster-offline-1" && u.agencyId === client.agencyId)).toBe(true);

    const deliveries = await jobsOf("channel.deliver");
    expect(deliveries.map((j) => j.payload.channel)).toContain("email");
    expect(deliveries[0]!.payload).toMatchObject({ orgId: client.id, agentId, deliverableId: d!.id });
    const notes = await db().select().from(schema.notifications).where(eq(schema.notifications.orgId, client.id));
    expect(notes.some((n) => n.kind === "deliverable.created")).toBe(true);

    // Re-running a finished run is a no-op (idempotent retries).
    expect((await executeRun(db(), run!.id)).status).toBe("noop");
    expect(await db().$count(schema.deliverables, eq(schema.deliverables.agentId, agentId))).toBe(1);
  });

  it("two executors racing on the same run: exactly one executes it", async () => {
    const { agentId } = await hireFromTranscript();
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.agentId, agentId));
    const outcomes = await Promise.all([executeRun(db(), run!.id), executeRun(db(), run!.id), executeRun(db(), run!.id)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["noop", "noop", "succeeded"]);
    expect(await db().$count(schema.deliverables, eq(schema.deliverables.agentId, agentId))).toBe(1);
    const lease = await db().select().from(schema.runSteps).where(and(eq(schema.runSteps.runId, run!.id), eq(schema.runSteps.seq, -1)));
    expect(lease).toHaveLength(0); // released
  });

  it("http_fetch refuses internal targets the model asks for", async () => {
    const { client, user, agentId } = await hireFromTranscript();
    setHttpFetchLookupForTests(async () => [{ address: "169.254.169.254", family: 4 }]);
    let turn = 0;
    setLlmProviderForTests({
      id: "offline",
      async chat() {
        turn++;
        if (turn === 1)
          return {
            model: "roster-offline-1",
            stopReason: "tool_use",
            text: "",
            toolCalls: [{ id: "t1", name: "http_fetch", input: { url: "https://metadata.attacker.example/latest/meta-data/iam" } }],
            assistantContent: [{ type: "tool_use", id: "t1", name: "http_fetch", input: { url: "https://metadata.attacker.example/latest/meta-data/iam" } }],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        return { model: "roster-offline-1", stopReason: "end_turn", text: "Could not fetch it.", toolCalls: [], assistantContent: [{ type: "text", text: "Could not fetch it." }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    });
    try {
      const res = await messageAgent({ orgId: client.id, agentId, channel: "api", text: "Fetch that page", actor: { type: "user", userId: user.id }, wait: true });
      const [step] = await db().select().from(schema.runSteps).where(and(eq(schema.runSteps.runId, res.runId), eq(schema.runSteps.kind, "tool_result"), eq(schema.runSteps.name, "http_fetch")));
      expect(step!.data).toMatchObject({ isError: true });
      expect(String(step!.data.content)).toMatch(/Blocked: Host resolves to a non-public address/);
    } finally {
      setHttpFetchLookupForTests(undefined);
    }
  });

  it("messageAgent wait:true answers inline and saves what it is told to remember", async () => {
    const { client, user, agentId } = await hireFromTranscript();
    const res = await messageAgent({
      orgId: client.id,
      agentId,
      channel: "api",
      text: "Please remember that we always quote with a 35% margin on apparel.",
      actor: { type: "user", userId: user.id },
      wait: true,
    });
    expect(res.reply).toMatch(/remember/i);
    const msgs = await db().select().from(schema.messages).where(eq(schema.messages.conversationId, res.conversationId)).orderBy(schema.messages.createdAt);
    expect(msgs.map((m) => `${m.direction}:${m.author}`)).toEqual(["inbound:user", "outbound:agent"]);
    const mem = await db().select().from(schema.memories).where(and(eq(schema.memories.agentId, agentId), sql`content ilike '%35% margin%'`));
    expect(mem[0]?.kind).toBe("preference");
    // Follow-up question in the same conversation recalls it.
    const res2 = await messageAgent({ orgId: client.id, agentId, conversationId: res.conversationId, channel: "api", text: "What margin do we use on apparel?", actor: { type: "user", userId: user.id }, wait: true });
    expect(res2.reply).toMatch(/35% margin/);
  });

  it("external email pauses the run for approval; approving sends, rejecting does not", async () => {
    const { client, user, agentId } = await hireFromTranscript();
    const ask = (text: string) => messageAgent({ orgId: client.id, agentId, channel: "portal", text, actor: { type: "user", userId: user.id }, wait: true });

    const r1 = await ask("Send the spring tote bag quote to buyer@acme-corp.com and tell them we can hit their in-hands date.");
    const [run1] = await db().select().from(schema.runs).where(eq(schema.runs.id, r1.runId));
    expect(run1!.status).toBe("waiting_approval");
    const [ap] = await db().select().from(schema.approvals).where(eq(schema.approvals.runId, r1.runId));
    expect(ap).toMatchObject({ status: "pending", action: "send_external_email", orgId: client.id });
    expect(ap!.description).toMatch(/buyer@acme-corp\.com/);
    expect((await jobsOf("channel.deliver")).filter((j) => j.payload.to === "buyer@acme-corp.com")).toHaveLength(0);

    // Wrong org cannot decide it.
    const other = await makeOrgs();
    await expect(decideApproval({ orgId: other.client.id, approvalId: ap!.id, decision: "approved", actor: { type: "user", userId: other.user.id } })).rejects.toBeInstanceOf(EngineNotFoundError);

    await decideApproval({ orgId: client.id, approvalId: ap!.id, decision: "approved", actor: { type: "user", userId: user.id } });
    await expect(decideApproval({ orgId: client.id, approvalId: ap!.id, decision: "rejected", actor: { type: "user", userId: user.id } })).rejects.toThrow(/already decided/);
    await runJobsOnce({ types: ["agent.run"] });
    const [run1b] = await db().select().from(schema.runs).where(eq(schema.runs.id, r1.runId));
    expect(run1b!.status).toBe("succeeded");
    const sent = (await jobsOf("channel.deliver")).filter((j) => j.payload.to === "buyer@acme-corp.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ channel: "email", orgId: client.id, agentId });

    const r2 = await ask("Send the fleece quote to cfo@bigco.example and copy nobody.");
    const [ap2] = await db().select().from(schema.approvals).where(eq(schema.approvals.runId, r2.runId));
    await decideApproval({ orgId: client.id, approvalId: ap2!.id, decision: "rejected", actor: { type: "user", userId: user.id } });
    await runJobsOnce({ types: ["agent.run"] });
    const [run2] = await db().select().from(schema.runs).where(eq(schema.runs.id, r2.runId));
    expect(run2!.status).toBe("succeeded");
    expect((await jobsOf("channel.deliver")).filter((j) => j.payload.to === "cfo@bigco.example")).toHaveLength(0);
    const rejectedStep = await db().select().from(schema.runSteps).where(and(eq(schema.runSteps.runId, r2.runId), eq(schema.runSteps.kind, "tool_result"), eq(schema.runSteps.name, "send_message")));
    expect(rejectedStep[0]!.data).toMatchObject({ approved: false, status: "rejected" });
  });

  it("request_changes writes a preference memory and produces a revised deliverable", async () => {
    const { client, user, agentId } = await hireFromTranscript();
    await makeJobsDue();
    await runJobsOnce({ types: ["agent.run"] });
    const [d] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId));
    await reviewDeliverable({ orgId: client.id, deliverableId: d!.id, action: "request_changes", feedback: "Use our navy and gold brand colors and show price breaks at 100/250/500 units.", actor: { type: "user", userId: user.id } });
    const [updated] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.id, d!.id));
    expect(updated).toMatchObject({ status: "changes_requested" });
    const pref = await db().select().from(schema.memories).where(and(eq(schema.memories.agentId, agentId), eq(schema.memories.kind, "preference"), sql`content ilike '%navy and gold%'`));
    expect(pref[0]!.importance).toBe(5);
    await runJobsOnce({ types: ["agent.run"] });
    const all = await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId)).orderBy(schema.deliverables.createdAt);
    expect(all).toHaveLength(2);
    expect(all[1]!.title).toMatch(/revised/);
    expect(all[1]!.body).toMatch(/navy and gold/);
    // Foreign org cannot review it.
    const other = await makeOrgs();
    await expect(reviewDeliverable({ orgId: other.client.id, deliverableId: d!.id, action: "approve", actor: { type: "system" } })).rejects.toBeInstanceOf(EngineNotFoundError);
  });

  it("enforces the monthly budget before calling the model", async () => {
    const { client, user, agentId } = await hireFromTranscript();
    await db().update(schema.agents).set({ config: sql`config || '{"monthlyBudgetCents": 1}'::jsonb` }).where(eq(schema.agents.id, agentId));
    await db().insert(schema.usageEvents).values({ orgId: client.id, agentId, kind: "llm", model: "claude-opus-5-5", costMicros: 20_000 });
    let called = 0;
    setLlmProviderForTests({ id: "offline", chat: async () => { called++; throw new Error("should not be called"); } });
    const wf = (await db().select().from(schema.workflows).where(eq(schema.workflows.agentId, agentId)))[0]!;
    const { runId } = await runWorkflowNow({ orgId: client.id, workflowId: wf.id, actor: { type: "user", userId: user.id } });
    await runJobsOnce({ types: ["agent.run"] });
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run).toMatchObject({ status: "failed" });
    expect(run!.error).toMatch(/budget/i);
    expect(called).toBe(0);
  });

  it("stops a looping model at the step limit and records why", async () => {
    const { client, user, agentId } = await hireFromTranscript();
    let n = 0;
    const looping: LlmProvider = {
      id: "offline",
      async chat() {
        n++;
        const id = `toolu_loop_${n}`;
        return {
          model: "roster-offline-1",
          stopReason: "tool_use",
          text: "",
          toolCalls: [{ id, name: "memory_recall", input: { query: "again" } }],
          assistantContent: [{ type: "tool_use", id, name: "memory_recall", input: { query: "again" } }],
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    setLlmProviderForTests(looping);
    const wf = (await db().select().from(schema.workflows).where(eq(schema.workflows.agentId, agentId)))[0]!;
    const { runId } = await runWorkflowNow({ orgId: client.id, workflowId: wf.id, actor: { type: "user", userId: user.id } });
    const out = await executeRun(db(), runId, { orgId: client.id, limits: { maxSteps: 4 } });
    expect(out.status).toBe("failed");
    expect(n).toBe(4);
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run!.error).toMatch(/step limit/);
    const limitStep = await db().select().from(schema.runSteps).where(and(eq(schema.runSteps.runId, runId), eq(schema.runSteps.kind, "error")));
    expect(limitStep[0]!.data).toMatchObject({ reason: "max_steps" });
  });

  it("paused agents do not run; tenant scoping on runs, messages and knowledge", async () => {
    const a = await hireFromTranscript();
    const b = await makeOrgs();
    await expect(messageAgent({ orgId: b.client.id, agentId: a.agentId, channel: "api", text: "hi", actor: { type: "system" } })).rejects.toBeInstanceOf(EngineNotFoundError);
    const wf = (await db().select().from(schema.workflows).where(eq(schema.workflows.agentId, a.agentId)))[0]!;
    await expect(runWorkflowNow({ orgId: b.client.id, workflowId: wf.id, actor: { type: "system" } })).rejects.toBeInstanceOf(EngineNotFoundError);
    expect(await searchKnowledge(db(), { orgId: b.client.id, agentId: a.agentId, query: "quotes promotional products" })).toEqual([]);
    await expect(executeRun(db(), (await db().select().from(schema.runs).where(eq(schema.runs.agentId, a.agentId)))[0]!.id, { orgId: b.client.id })).rejects.toThrow(/not found/);

    await setAgentStatus({ orgId: a.client.id, agentId: a.agentId, status: "paused", actor: { type: "system" } });
    await makeJobsDue();
    await runJobsOnce({ types: ["agent.run"] });
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.agentId, a.agentId));
    expect(run).toMatchObject({ status: "canceled" });
    expect(await db().$count(schema.deliverables, eq(schema.deliverables.agentId, a.agentId))).toBe(0);
  });

  it("resellAgent clones into a child customer org without memories or the private transcript", async () => {
    const { client, agency, user, agentId, spec } = await hireFromTranscript();
    await db().insert(schema.knowledgeSources).values({ orgId: client.id, agentId, title: "Catalog", kind: "text", status: "ready", chunkCount: 1 }).returning().then(async ([s]) => {
      await db().insert(schema.knowledgeChunks).values({ orgId: client.id, sourceId: s!.id, agentId, seq: 0, content: "Port Authority tote bag, $4.20 at 250 units" });
    });
    const customer = await makeCustomer(client.id, agency.id);
    const { agentId: cloneId } = await resellAgent({ orgId: client.id, agentId, customerOrgId: customer.id, actor: { type: "user", userId: user.id } });
    const [clone] = await db().select().from(schema.agents).where(eq(schema.agents.id, cloneId));
    expect(clone).toMatchObject({ orgId: customer.id, sourceAgentId: agentId, status: "active", role: spec.role });
    expect(await db().$count(schema.workflows, eq(schema.workflows.agentId, cloneId))).toBe(spec.workflows.length);
    expect(await db().$count(schema.memories, eq(schema.memories.agentId, cloneId))).toBe(0);
    const srcs = await db().select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.agentId, cloneId));
    expect(srcs.map((s) => s.kind)).toEqual(["text"]);
    expect((await searchKnowledge(db(), { orgId: customer.id, agentId: cloneId, query: "tote bag" }))[0]?.content).toMatch(/tote/);
    // Not a child of this client → not found.
    const stranger = await makeOrgs();
    await expect(resellAgent({ orgId: client.id, agentId, customerOrgId: stranger.client.id, actor: { type: "system" } })).rejects.toBeInstanceOf(EngineNotFoundError);
  });
});
