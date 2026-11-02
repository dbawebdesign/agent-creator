/** Regression tests for product critique r1: resell re-targeting, honest hours saved, change-request alerts, API deliverables. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { db, schema } from "@/server/db/client";
import { runJobsOnce } from "@/server/jobs/handlers";
import { hireAgent, messageAgent, resellAgent, reviewDeliverable, runWorkflowNow } from "@/server/services/engine";
import { makeCustomer, makeJobsDue, makeOrgs, resetDb, tzAtLocalHour } from "./engine.helpers";

const PODCAST = readFileSync(path.join(__dirname, "fixtures", "podcast-ai-employees.md"), "utf8");

async function hire() {
  const orgs = await makeOrgs({ clientName: "Summit Promo Co", industry: "Promotional products distribution", timezone: tzAtLocalHour(12) });
  const spec = heuristicSpec({ transcript: PODCAST, orgName: orgs.client.name, industry: orgs.client.industry });
  const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "user", userId: orgs.user.id } });
  return { ...orgs, agentId, spec };
}

describe("resellAgent", () => {
  beforeEach(resetDb);

  it("re-targets the clone at the customer, credits the reseller, and schedules the customer's work", async () => {
    const { agency, client, user, agentId } = await hire();
    const customer = await makeCustomer(client.id, agency.id);
    await db().update(schema.organizations).set({ timezone: "Asia/Tokyo" }).where(eq(schema.organizations.id, customer.id));
    const { agentId: cloneId } = await resellAgent({ orgId: client.id, agentId, customerOrgId: customer.id, actor: { type: "user", userId: user.id } });
    const [clone] = await db().select().from(schema.agents).where(eq(schema.agents.id, cloneId));
    expect(clone!.orgId).toBe(customer.id);
    const strip = (t: string) => t.replace(/Provided to .*? by Summit Promo Co\./g, "");
    expect(strip(clone!.instructions)).not.toMatch(/Summit Promo Co/);
    expect(strip(clone!.summary ?? "")).not.toMatch(/Summit Promo Co/);
    expect(clone!.instructions).toContain(`You work for ${customer.name}.`);
    expect(clone!.summary).toContain(`Provided to ${customer.name} by Summit Promo Co.`);

    const wfs = await db().select().from(schema.workflows).where(eq(schema.workflows.agentId, cloneId));
    expect(wfs.length).toBeGreaterThan(0);
    for (const w of wfs) {
      expect(strip(w.instructions)).not.toMatch(/Summit Promo Co/);
      if (w.trigger.type === "schedule") expect(w.nextRunAt).toBeInstanceOf(Date);
    }
    const [setup] = await db().select().from(schema.runs).where(and(eq(schema.runs.agentId, cloneId), eq(schema.runs.trigger, "setup")));
    expect(setup!.status).toBe("queued");
    expect(String(setup!.input.title)).not.toMatch(/Summit Promo Co/);
    const jobs = await db().execute(sql`select 1 from jobs where type = 'agent.run' and payload->>'runId' = ${setup!.id}`);
    expect(jobs.rows).toHaveLength(1);
  });
});

describe("hours saved", () => {
  beforeEach(resetDb);

  it("counts hours once per new scheduled deliverable; manual re-runs and revisions add 0", async () => {
    const { client, user, agentId } = await hire();
    await db().execute(sql`delete from jobs where org_id = ${client.id}`);
    const [wf] = await db().select().from(schema.workflows).where(and(eq(schema.workflows.agentId, agentId), sql`${schema.workflows.trigger}->>'type' = 'schedule'`));
    expect(wf!.hoursSavedPerRun).toBeGreaterThan(0);

    // A manual "Run now".
    const manual = await runWorkflowNow({ orgId: client.id, workflowId: wf!.id, actor: { type: "user", userId: user.id } });
    await runJobsOnce({ types: ["agent.run"] });
    // A scheduled run (what the scheduler creates).
    await db().update(schema.workflows).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schema.workflows.id, wf!.id));
    const { schedulerTick } = await import("@/server/jobs/scheduler");
    expect(await schedulerTick(db())).toBeGreaterThan(0);
    await makeJobsDue();
    await runJobsOnce({ types: ["agent.run"] });

    const ds = await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId));
    const byRun = new Map(ds.map((d) => [d.runId, d]));
    expect(byRun.get(manual.runId)!.hoursSaved).toBe(0);
    const scheduled = ds.find((d) => d.runId !== manual.runId)!;
    expect(scheduled.hoursSaved).toBe(wf!.hoursSavedPerRun);

    await reviewDeliverable({ orgId: client.id, deliverableId: scheduled.id, action: "request_changes", feedback: "Shorter, please.", actor: { type: "user", userId: user.id } });
    await runJobsOnce({ types: ["agent.run"] });
    const revised = (await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId))).filter((d) => !byRun.has(d.runId));
    expect(revised).toHaveLength(1);
    expect(revised[0]!.hoursSaved).toBe(0);
  });
});

describe("change requests reach the agency", () => {
  beforeEach(resetDb);

  it("notifies agency owners/admins with the feedback, audits it, and resolves it when the revision is approved", async () => {
    const { agency, client, user, agentId } = await hire();
    const [boss] = await db().insert(schema.users).values({ email: `boss-${Date.now()}@agency.example`, name: "Boss" }).returning();
    const [admin] = await db().insert(schema.users).values({ email: `admin-${Date.now()}@agency.example`, name: "Admin" }).returning();
    const [viewer] = await db().insert(schema.users).values({ email: `viewer-${Date.now()}@agency.example`, name: "Viewer" }).returning();
    await db()
      .insert(schema.memberships)
      .values([
        { userId: boss!.id, orgId: agency.id, role: "owner" },
        { userId: admin!.id, orgId: agency.id, role: "admin" },
        { userId: viewer!.id, orgId: agency.id, role: "member" },
      ]);
    await makeJobsDue();
    await runJobsOnce({ types: ["knowledge.index", "agent.run"], max: 5 });
    const [d] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId));
    expect(d).toBeTruthy();

    await reviewDeliverable({ orgId: client.id, deliverableId: d!.id, action: "request_changes", feedback: "This is too generic — use our real tote bag prices.", actor: { type: "user", userId: user.id } });
    const notes = await db().select().from(schema.notifications).where(and(eq(schema.notifications.orgId, agency.id), eq(schema.notifications.kind, "deliverable.changes_requested")));
    expect(notes.map((n) => n.userId).sort()).toEqual([boss!.id, admin!.id].sort());
    expect(notes[0]!.body).toContain("real tote bag prices");
    expect(notes[0]!.href).toContain(d!.id);
    const logs = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, agency.id), eq(schema.auditLogs.action, "client.changes_requested")));
    expect(logs).toHaveLength(1);
    // The client never sees agency alerts.
    expect(await db().select().from(schema.notifications).where(and(eq(schema.notifications.orgId, client.id), eq(schema.notifications.kind, "deliverable.changes_requested")))).toHaveLength(0);

    await runJobsOnce({ types: ["agent.run"] });
    const revised = (await db().select().from(schema.deliverables).where(eq(schema.deliverables.agentId, agentId))).find((x) => x.id !== d!.id)!;
    await reviewDeliverable({ orgId: client.id, deliverableId: revised.id, action: "approve", actor: { type: "user", userId: user.id } });
    const open = await db()
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, agency.id), eq(schema.notifications.kind, "deliverable.changes_requested"), isNull(schema.notifications.readAt)));
    expect(open).toHaveLength(0);
    expect(await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, agency.id), eq(schema.auditLogs.action, "client.changes_resolved")))).toHaveLength(1);
  });
});

describe("messageAgent", () => {
  beforeEach(resetDb);

  it("returns the deliverables created during a synchronous run", async () => {
    const { client, user, agentId } = await hire();
    const r = await messageAgent({ orgId: client.id, agentId, channel: "api", text: "Write a short report on how we build quotes today.", actor: { type: "user", userId: user.id }, wait: true });
    expect(r.deliverables).toHaveLength(1);
    expect(r.deliverables[0]).toMatchObject({ id: expect.any(String), title: expect.any(String) });
    const [d] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.id, r.deliverables[0]!.id));
    expect(d!.orgId).toBe(client.id);
  });
});
