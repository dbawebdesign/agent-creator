import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { claim, enqueue } from "@/server/jobs/queue";
import { claimTypes, processJob } from "@/server/jobs/worker";
import { resetDb } from "./engine.helpers";

describe("Postgres job queue", () => {
  beforeEach(resetDb);

  it("never double-claims across two concurrent claimers", async () => {
    const q = "claim-test";
    for (let i = 0; i < 60; i++) await enqueue(db(), "agent.run", { i }, { queue: q });
    const seen: Record<string, string[]> = { a: [], b: [] };
    const worker = async (name: "a" | "b") => {
      for (;;) {
        const rows = await claim(db(), `worker-${name}`, 4, 60_000, q);
        if (!rows.length) return;
        seen[name]!.push(...rows.map((r) => r.id));
      }
    };
    await Promise.all([worker("a"), worker("b"), worker("a"), worker("b")]);
    const all = [...seen.a!, ...seen.b!];
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    expect(seen.a!.length).toBeGreaterThan(0);
    expect(seen.b!.length).toBeGreaterThan(0);
  });

  it("dedupes by idempotency key while queued/running", async () => {
    const a = await enqueue(db(), "agent.run", {}, { idempotencyKey: "k1" });
    const b = await enqueue(db(), "agent.run", {}, { idempotencyKey: "k1" });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it("reclaims expired leases and only the lease holder completes; failures back off then dead-letter", async () => {
    await enqueue(db(), "knowledge.index", { x: 1 }, { maxAttempts: 2 });
    const [first] = await claimTypes(db(), "w1", 1, ["knowledge.index"], 1);
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    const [again] = await claimTypes(db(), "w2", 1, ["knowledge.index"]);
    expect(again!.id).toBe(first!.id); // lease expired → reclaimed
    // w1 finishing late must not mark w2's job succeeded.
    await processJob(db(), first!, { "knowledge.index": async () => {} }, "w1");
    let row = (await db().execute(sql`select status, locked_by from jobs where id = ${first!.id}`)).rows[0] as { status: string; locked_by: string };
    expect(row).toMatchObject({ status: "running", locked_by: "w2" });
    await processJob(db(), again!, { "knowledge.index": async () => { throw new Error("boom"); } }, "w2");
    row = (await db().execute(sql`select status, attempts, last_error from jobs where id = ${first!.id}`)).rows[0] as { status: string; locked_by: string };
    expect(row).toMatchObject({ status: "dead", attempts: 2, last_error: "Error: boom" });
  });
});
