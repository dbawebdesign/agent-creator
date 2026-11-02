/** Studio "Release now": a held (finished-early) deliverable is handed over once, on demand. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { heldDeliverables } from "@/server/queries/studio";
import { EngineNotFoundError, releaseHeldDeliverable } from "@/server/services/engine";
import { makeOrgs } from "./engine.helpers";

async function heldFixture() {
  const { agency, client, user } = await makeOrgs();
  const [agent] = await db()
    .insert(schema.agents)
    .values({ orgId: client.id, name: "Ezra", role: "Billing coordinator", instructions: "Prepare the receivables snapshot.", status: "active" })
    .returning();
  const [run] = await db()
    .insert(schema.runs)
    .values({ orgId: client.id, agentId: agent!.id, trigger: "setup", status: "succeeded", input: { kind: "first_deliverable", title: "Receivables snapshot" } })
    .returning();
  const draft = { id: randomUUID(), title: "Receivables snapshot", kind: "report", preview: "3 invoices overdue", body: "# Receivables\n\n3 invoices overdue.", needsReview: true, hoursSaved: 1 };
  const releaseAt = new Date(Date.now() + 6 * 3600_000);
  await enqueue(db(), "deliverable.release", { orgId: client.id, runId: run!.id, deliverable: draft }, { orgId: client.id, runAt: releaseAt, idempotencyKey: `release:${draft.id}` });
  return { agency, client, user, agent: agent!, run: run!, draft, releaseAt };
}

describe("held deliverables", () => {
  it("lists the held draft for its run with the release time", async () => {
    const f = await heldFixture();
    const held = await heldDeliverables(f.client.id, [f.run.id]);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ runId: f.run.id, id: f.draft.id, title: f.draft.title, body: f.draft.body });
    expect(Math.abs(held[0]!.releaseAt.getTime() - f.releaseAt.getTime())).toBeLessThan(1000);
    // Scoped by org: another org sees nothing.
    expect(await heldDeliverables(f.agency.id, [f.run.id])).toHaveLength(0);
  });

  it("releases now exactly once and the job is done", async () => {
    const f = await heldFixture();
    const actor = { type: "user" as const, userId: f.user.id };
    const out = await releaseHeldDeliverable({ orgId: f.client.id, runId: f.run.id, actor });
    expect(out.deliverableId).toBe(f.draft.id);
    const rows = await db().select().from(schema.deliverables).where(and(eq(schema.deliverables.orgId, f.client.id), eq(schema.deliverables.agentId, f.agent.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Receivables snapshot");
    expect(await heldDeliverables(f.client.id, [f.run.id])).toHaveLength(0);
    await expect(releaseHeldDeliverable({ orgId: f.client.id, runId: f.run.id, actor })).rejects.toBeInstanceOf(EngineNotFoundError);
    // Wrong org can't release another org's held deliverable.
    const g = await heldFixture();
    await expect(releaseHeldDeliverable({ orgId: f.client.id, runId: g.run.id, actor })).rejects.toBeInstanceOf(EngineNotFoundError);
  });
});
