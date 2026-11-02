/** sec r3: two concurrent approvals of the same email draft. */
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { applyTestEnv, cleanupOrgs, makeAgent, makeOrg } from "./channels.fixtures";
vi.hoisted(() => { Object.assign(process.env, { APP_URL: "https://app.roster.test", EMAIL_DOMAIN: "agents.roster.test", AUTH_SECRET: "x".repeat(40) }); delete process.env.RESEND_API_KEY; });
import { db, schema } from "@/server/db/client";
import { reviewDeliverable } from "@/server/services/engine";
import { runJobsOnce } from "@/server/jobs/handlers";
afterAll(async () => { await cleanupOrgs(); });
describe("double approve", () => {
  it("never sends twice", async () => {
    applyTestEnv();
    const c = await makeOrg({ kind: "client" });
    const a = await makeAgent(c.id);
    const [d] = await db().insert(schema.deliverables).values({ orgId: c.id, agentId: a.id, title: "Drafts", kind: "email_draft", body: "**To:** Lorna <lorna@bayside.example>\n**Subject:** Hi\n\n> Hello Lorna.\n" }).returning();
    const actor = { type: "system" as const };
    const r = await Promise.allSettled([1, 2, 3].map(() => reviewDeliverable({ orgId: c.id, deliverableId: d!.id, action: "approve", actor })));
    console.log(r.map((x) => x.status + (x.status === "rejected" ? `: ${String((x.reason as Error).message).slice(0, 90)}` : "")));
    await runJobsOnce({ max: 20 });
    const out = await db().execute(sql`select count(*)::int n from messages where org_id = ${c.id} and direction = 'outbound'`);
    const convs = await db().execute(sql`select count(*)::int n from conversations where org_id = ${c.id}`);
    console.log("outbound messages:", out.rows[0], "conversations:", convs.rows[0]);
    expect((out.rows[0] as { n: number }).n).toBe(1);
  });
});
