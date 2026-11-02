/** Security critique r3 M3 (ported proof): a resold copy never carries the reseller's own instruction sections. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { agentSpec } from "@/server/agents/spec";
import { db, schema } from "@/server/db/client";
import { hireAgent, resellAgent } from "@/server/services/engine";
import { roleForCustomer, scrubProcedure } from "@/server/services/resale";
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

  // Product critique r4 H-4: the resold copy carried the reseller's private names and its industry's role.
  it("scrubs the reseller's people, accounts, patients and rules from workflows, and re-derives the role for the customer", async () => {
    const orgs = await makeOrgs({ clientName: "Harborview Animal Hospital", industry: "Veterinary clinic" });
    const spec = agentSpec.parse({
      name: "Sage",
      role: "Patient Care Coordinator (veterinary clinic)",
      summary: "Sage handles recalls for Harborview Animal Hospital.",
      instructions: "You are Sage, Patient Care Coordinator at Harborview Animal Hospital (veterinary clinic).",
      workflows: [
        {
          name: "Vaccine recalls",
          instructions:
            "Read overdue_patients.csv. List every patient overdue for rabies or DHPP, sorted by days overdue (most overdue first). For each owner draft a short reminder text using the pet's name and the booking link from the reminder policy. Skip Biscuit and the Whitfield family entirely. Anything for Elm St. Rescue waits for Kayla's sign-off. Post the list in Slack.",
          trigger: { type: "schedule", cron: "0 7 * * 1-5" },
          outputKind: "table",
        },
        {
          name: "Elm St. Rescue billing",
          instructions: "1. Start with Hazel's owner, then the rest.\n2. Draft each invoice from the price list.\n3. Never contact the Whitfield family about Biscuit.\n4. Request approval from the team before anything is sent.",
          trigger: { type: "manual" },
          outputKind: "document",
        },
      ],
      firstDeliverable: { title: "Recalls for Kayla", description: "x", instructions: "x" },
    });
    const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "user", userId: orgs.user.id } });
    await db()
      .insert(schema.memories)
      .values([
        { orgId: orgs.client.id, agentId, kind: "fact", content: "Hard rule from the call: “Never contact the Whitfield family about Biscuit.”" },
        { orgId: orgs.client.id, agentId, kind: "fact", content: "Approval rule from the call: “Also, anything going to the Elm St. Rescue account needs Kayla's sign-off first.”" },
        { orgId: orgs.client.id, agentId, kind: "person", content: "Person: Kayla (owner, on the call)." },
        { orgId: orgs.client.id, agentId, kind: "fact", content: "Systems and tools mentioned: Slack." },
      ]);
    const [csv] = await db().insert(schema.knowledgeSources).values({ orgId: orgs.client.id, agentId, title: "overdue_patients.csv", kind: "file", status: "ready", chunkCount: 1 }).returning();
    await db().insert(schema.knowledgeChunks).values({ orgId: orgs.client.id, sourceId: csv!.id, agentId, seq: 0, content: "pet,owner,species,due\nHazel,Ana Ruiz,Dog,2026-06-01\nJuniper,Tomás Herrera,Cat,2026-06-20" });
    const [policy] = await db().insert(schema.knowledgeSources).values({ orgId: orgs.client.id, agentId, title: "reminder_policy.docx", kind: "file", status: "ready", chunkCount: 1 }).returning();
    await db().insert(schema.knowledgeChunks).values({ orgId: orgs.client.id, sourceId: policy!.id, agentId, seq: 0, content: "Reminders go out 30 days before due. Booking link: https://book.example/harborview" });

    const customer = await makeCustomer(orgs.client.id, orgs.agency.id);
    await db().update(schema.organizations).set({ name: "Lakeside Pet Grooming", industry: "Pet grooming" }).where(eq(schema.organizations.id, customer.id));
    const { agentId: copyId } = await resellAgent({ orgId: orgs.client.id, agentId, customerOrgId: customer.id, actor: { type: "user", userId: orgs.user.id }, shareKnowledgeSourceIds: [policy!.id] });
    const [copy] = await db().select().from(schema.agents).where(eq(schema.agents.id, copyId));
    const wfs = await db().select({ name: schema.workflows.name, i: schema.workflows.instructions }).from(schema.workflows).where(eq(schema.workflows.agentId, copyId));
    const all = `${copy!.role}\n${copy!.summary}\n${copy!.instructions}\n${wfs.map((w) => `${w.name}\n${w.i}`).join("\n")}`;
    expect(all).not.toMatch(/Biscuit|Whitfield|Elm St|Rescue|Kayla|Hazel|overdue_patients\.csv|veterinary|Patient/i);
    expect(copy!.role).toBe("Client Care Coordinator");
    expect(copy!.instructions).toMatch(/^You are Sage, Client Care Coordinator at Lakeside Pet Grooming\./);
    const recalls = wfs.find((w) => w.name === "Vaccine recalls")!;
    expect(recalls.i).toContain("List every client overdue for rabies or DHPP");
    expect(recalls.i).toContain("the booking link from the reminder policy.");
    expect(recalls.i).toContain("Post the list in Slack.");
    expect(recalls.i).toMatch(/^Read the team's file/);
    const billing = wfs.find((w) => w.name === "Billing")!;
    expect(billing.i).toBe("1. Draft each invoice from the price list.\n2. Request approval from the team before anything is sent.");
  });

  it("keeps the role when the customer is in the same line of work", () => {
    expect(roleForCustomer("Patient Care Coordinator (dental practice)", { customerName: "Bright Smiles", resellerName: "Bayview Dental", customerIndustry: "Dental practice", resellerIndustry: "Dental practice" })).toBe(
      "Patient Care Coordinator",
    );
    expect(roleForCustomer("Crew Scheduling Coordinator", { customerName: "Sparkle Janitorial", resellerName: "BrightPath", customerIndustry: "Commercial cleaning", resellerIndustry: "Commercial cleaning" })).toBe(
      "Crew Scheduling Coordinator",
    );
    expect(scrubProcedure("Call Dr. Okafor first. Then St. Luke's. Done.", ["Okafor"], [])).toBe("Then St. Luke's. Done.");
  });
});
