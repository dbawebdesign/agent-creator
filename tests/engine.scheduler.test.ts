import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db/client";
import { nextCronRun, nextLocalTime, schedulerTick } from "@/server/jobs/scheduler";
import { makeOrgs, resetDb } from "./engine.helpers";

describe("cron in the org timezone", () => {
  it("computes the next weekday 6 AM in New York (after DST ended)", () => {
    // 2026-11-02T04:05Z is Sunday Nov 1, 23:05 EST → next weekday 06:00 EST = 11:00Z Monday.
    expect(nextCronRun("0 6 * * 1-5", "America/New_York", new Date("2026-11-02T04:05:00Z")).toISOString()).toBe("2026-11-02T11:00:00.000Z");
  });
  it("handles the spring-forward DST jump", () => {
    // DST starts 2026-03-08 in the US: 06:00 local is EDT (UTC-4) that morning.
    expect(nextCronRun("0 6 * * *", "America/New_York", new Date("2026-03-07T12:00:00Z")).toISOString()).toBe("2026-03-08T10:00:00.000Z");
  });
  it("uses each org's own timezone", () => {
    const after = new Date("2026-11-02T04:05:00Z");
    expect(nextLocalTime("Asia/Tokyo", 6, 0, after).toISOString()).toBe("2026-11-02T21:00:00.000Z");
    expect(nextLocalTime("Europe/London", 6, 0, after).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });
});

describe("schedulerTick", () => {
  beforeEach(resetDb);

  async function dueWorkflow(status: "active" | "paused" = "active") {
    const { client } = await makeOrgs({ timezone: "America/Los_Angeles" });
    const [agent] = await db()
      .insert(schema.agents)
      .values({ orgId: client.id, name: "Maya", role: "Analyst", instructions: "Do the weekly report for the owner.", status })
      .returning();
    const [wf] = await db()
      .insert(schema.workflows)
      .values({
        orgId: client.id,
        agentId: agent!.id,
        name: "Weekly report",
        instructions: "1. Write the report.",
        trigger: { type: "schedule", cron: "0 6 * * 1", timezone: "America/Los_Angeles" },
        nextRunAt: new Date(Date.now() - 60_000),
      })
      .returning();
    return { client, agent: agent!, wf: wf! };
  }

  it("enqueues exactly one run per slot even when ticks race, then advances next_run_at in the org timezone", async () => {
    const { wf } = await dueWorkflow();
    const results = await Promise.all(Array.from({ length: 6 }, () => schedulerTick(db())));
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await db().$count(schema.runs, eq(schema.runs.workflowId, wf.id))).toBe(1);
    const jobs = (await db().execute(sql`select idempotency_key from jobs where type = 'agent.run'`)).rows as Array<{ idempotency_key: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotency_key).toMatch(new RegExp(`^wf:${wf.id}:`));
    const [after] = await db().select().from(schema.workflows).where(eq(schema.workflows.id, wf.id));
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(after!.nextRunAt!);
    expect(local).toBe("Mon 06:00");
    // A second pass finds nothing due.
    expect(await schedulerTick(db())).toBe(0);
  });

  it("skips paused agents and disabled workflows", async () => {
    const { wf } = await dueWorkflow("paused");
    expect(await schedulerTick(db())).toBe(0);
    const { wf: wf2 } = await dueWorkflow();
    await db().update(schema.workflows).set({ enabled: false }).where(eq(schema.workflows.id, wf2.id));
    expect(await schedulerTick(db())).toBe(0);
    expect(await db().$count(schema.runs, eq(schema.runs.workflowId, wf.id))).toBe(0);
  });
});
