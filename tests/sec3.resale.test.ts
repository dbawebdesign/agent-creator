/** Security critique r3 M3 (ported proof): a resold copy never carries the reseller's own instruction sections. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { db, schema } from "@/server/db/client";
import { hireAgent, resellAgent } from "@/server/services/engine";
import { makeCustomer, makeOrgs } from "./engine.helpers";

const PODCAST = readFileSync(path.join(__dirname, "fixtures", "podcast-ai-employees.md"), "utf8");

describe("resale", () => {
  it("rebuilds the customer's instructions from the role, voice and workflows only", async () => {
    const orgs = await makeOrgs({ clientName: "BrightPath Commercial Cleaning", industry: "Commercial cleaning" });
    const spec = heuristicSpec({ transcript: PODCAST, orgName: orgs.client.name });
    const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "user", userId: orgs.user.id } });
    // The agency later edits the instructions in Studio (Agent settings) with business specifics.
    await db()
      .update(schema.agents)
      .set({ instructions: sql`${schema.agents.instructions} || ${"\n\n## Pricing\n- Our floor is $41/hr; Westshore Plaza pays $58/hr (62% margin). Never quote below floor.\n"}` })
      .where(eq(schema.agents.id, agentId));
    const customer = await makeCustomer(orgs.client.id, orgs.agency.id);
    const { agentId: copyId } = await resellAgent({ orgId: orgs.client.id, agentId, customerOrgId: customer.id, actor: { type: "user", userId: orgs.user.id } });
    const [copy] = await db().select().from(schema.agents).where(eq(schema.agents.id, copyId));
    const wfs = await db().select({ i: schema.workflows.instructions }).from(schema.workflows).where(eq(schema.workflows.agentId, copyId));
    const all = `${copy!.instructions}\n${wfs.map((w) => w.i).join("\n")}`;
    expect(all).not.toMatch(/62% margin|\$41|\$58|Westshore|## Pricing/);
    expect(copy!.instructions).toContain(`You work for ${customer.name}.`);
    expect(copy!.instructions).toMatch(/## Your responsibilities/);
  });
});
