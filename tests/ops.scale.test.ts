/** Ops/scale round 1: denormalized delivery stats, queue lease reclaim, scheduler drain, retention, API cursors. */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db/client";
import { pruneOnce, ensureMaintenanceScheduled, nextHourSlot } from "@/server/jobs/maintenance";
import { enqueue, reclaimExpired } from "@/server/jobs/queue";
import { schedulerDrain } from "@/server/jobs/scheduler";
import { claimTypes } from "@/server/jobs/worker";
import { makeOrgs, resetDb } from "./engine.helpers";

async function agentFor(orgId: string) {
  const [a] = await db()
    .insert(schema.agents)
    .values({ orgId, name: "Maya", role: "Analyst", instructions: "Do the weekly report for the owner.", status: "active" })
    .returning();
  return a!;
}

describe("deliverable triggers", () => {
  beforeEach(resetDb);

  it("sets agency_id and keeps agents.delivered_count / last_delivered_at current (multi-row insert)", async () => {
    const { agency, client } = await makeOrgs();
    const a = await agentFor(client.id);
    const b = await agentFor(client.id);
    const t1 = new Date("2026-10-01T10:00:00.123Z");
    const t2 = new Date("2026-10-02T10:00:00.456Z");
    await db()
      .insert(schema.deliverables)
      .values([
        { orgId: client.id, agentId: a.id, title: "One", body: "x", createdAt: t1 },
        { orgId: client.id, agentId: a.id, title: "Two", body: "x", createdAt: t2 },
        { orgId: client.id, agentId: b.id, title: "Three", body: "x", createdAt: t1 },
      ]);
    // An older deliverable inserted later must not move last_delivered_at backwards.
    await db().insert(schema.deliverables).values({ orgId: client.id, agentId: a.id, title: "Late", body: "x", createdAt: new Date("2026-09-01T00:00:00Z") });
    const rows = await db().select().from(schema.deliverables).where(eq(schema.deliverables.orgId, client.id));
    expect(rows.every((r) => r.agencyId === agency.id)).toBe(true);
    const [ra] = await db().select().from(schema.agents).where(eq(schema.agents.id, a.id));
    const [rb] = await db().select().from(schema.agents).where(eq(schema.agents.id, b.id));
    expect(ra).toMatchObject({ deliveredCount: 3, lastDeliveredAt: t2 });
    expect(rb).toMatchObject({ deliveredCount: 1, lastDeliveredAt: t1 });
  });
});

describe("queue lease reclaim", () => {
  beforeEach(resetDb);

  it("dead-letters a job whose worker keeps dying once its attempts are spent (no infinite retry)", async () => {
    const id = await enqueue(db(), "knowledge.index", {}, { maxAttempts: 2, queue: "poison" });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const [job] = await claimTypes(db(), `w${attempt}`, 1, null, 1, "poison");
      expect(job?.id).toBe(id);
      expect(job?.attempts).toBe(attempt);
      await new Promise((r) => setTimeout(r, 10)); // the worker "crashes": the 1ms lease expires
    }
    expect(await claimTypes(db(), "w3", 1, null, 1, "poison")).toHaveLength(0);
    const row = (await db().execute(sql`select status, attempts, finished_at, last_error from jobs where id = ${id}`)).rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({ status: "dead", attempts: 2 });
    expect(row.finished_at).not.toBeNull();
    expect(String(row.last_error)).toMatch(/^LeaseExpired/);
  });

  it("puts an expired lease with attempts left back in the queue", async () => {
    const id = await enqueue(db(), "knowledge.index", {}, { maxAttempts: 3, queue: "q2" });
    await claimTypes(db(), "w1", 1, null, 1, "q2");
    await new Promise((r) => setTimeout(r, 10));
    const back = await reclaimExpired(db(), "q2");
    expect(back).toEqual([expect.objectContaining({ id, status: "queued", attempts: 1 })]);
  });
});

describe("scheduler drain", () => {
  beforeEach(resetDb);

  it("enqueues every due workflow in one tick, in several batches", async () => {
    const { client } = await makeOrgs({ timezone: "UTC" });
    const agent = await agentFor(client.id);
    await db()
      .insert(schema.workflows)
      .values(
        Array.from({ length: 23 }, (_, i) => ({
          orgId: client.id,
          agentId: agent.id,
          name: `W${i}`,
          instructions: "1. Do it.",
          trigger: { type: "schedule" as const, cron: "0 6 * * *", timezone: "UTC" },
          nextRunAt: new Date(Date.now() - 60_000),
        })),
      );
    const r = await schedulerDrain(db(), { batch: 5 });
    expect(r).toMatchObject({ due: 23, enqueued: 23, batches: 5, more: false });
    const [{ n }] = (await db().execute(sql`select count(*)::int as n from jobs where type = 'agent.run'`)).rows as Array<{ n: number }>;
    expect(n).toBe(23);
  });
});

describe("maintenance.prune", () => {
  beforeEach(async () => {
    await resetDb();
    await db().execute(sql`delete from rate_limits`);
  });

  it("deletes only what is past retention", async () => {
    await db().execute(sql`
      insert into jobs (type, status, finished_at) values
        ('agent.run', 'succeeded', now() - interval '8 days'),
        ('agent.run', 'succeeded', now() - interval '1 day'),
        ('agent.run', 'dead', now() - interval '8 days'),
        ('agent.run', 'dead', now() - interval '31 days'),
        ('agent.run', 'queued', null)`);
    await db().execute(sql`
      insert into webhook_events (provider, external_id, payload, created_at) values
        ('resend', 'old', '{}', now() - interval '31 days'), ('resend', 'new', '{}', now())`);
    await db().execute(sql`insert into rate_limits (key, count, reset_at) values ('a', 1, now() - interval '1 minute'), ('b', 1, now() + interval '1 minute')`);
    const deleted = await pruneOnce(db(), { batch: 1 });
    expect(deleted).toMatchObject({ jobs: 2, webhook_events: 1, rate_limits: 1 });
    const left = (await db().execute(sql`select status from jobs order by status`)).rows.map((r) => (r as { status: string }).status);
    expect(left).toEqual(["dead", "queued", "succeeded"]);
  });

  it("schedules exactly one prune job per hour slot", async () => {
    const now = new Date("2026-11-02T06:20:00Z");
    expect(nextHourSlot(now).toISOString()).toBe("2026-11-02T07:00:00.000Z");
    expect(await ensureMaintenanceScheduled(db(), now)).toBeTruthy();
    expect(await ensureMaintenanceScheduled(db(), new Date("2026-11-02T06:59:59Z"))).toBeNull();
  });
});
