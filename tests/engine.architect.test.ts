import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { architect, heuristicSpec } from "@/server/agents/architect";
import { agentSpec } from "@/server/agents/spec";
import { db, schema } from "@/server/db/client";
import { runJobsOnce } from "@/server/jobs/handlers";
import { analyzeDiscovery, createDiscovery } from "@/server/services/engine";
import { makeOrgs, resetDb } from "./engine.helpers";

const fixture = (f: string) => readFileSync(path.join(__dirname, "fixtures", f), "utf8");
const PODCAST = fixture("podcast-ai-employees.md");

describe("Architect (offline heuristic)", () => {
  it("turns the real podcast transcript into a specific promo-products quoting agent", async () => {
    const { spec, model } = await architect({ transcript: PODCAST, orgName: "Summit Promo Co", industry: "Promotional products distribution" });
    expect(model).toBe("roster-offline-1");
    expect(() => agentSpec.parse(spec)).not.toThrow();
    expect(spec.role).toBe("Quoting Specialist");
    expect(spec.vertical).toBe("Promotional products distribution");
    const names = spec.workflows.map((w) => w.name);
    expect(names[0]).toMatch(/quote/i);
    expect(names.join(" ")).toMatch(/catalog/i); // "scrape all these products, categories, and catalogs"
    expect(names.join(" ")).toMatch(/invoice/i); // "...and create invoices"
    expect(names.join(" ")).not.toMatch(/migration/i); // that itch belongs to the insurance example on the call
    // The itch is quoted with the owner's number.
    expect(spec.workflows[0]!.problem).toMatch(/20 hours a week/);
    expect(spec.workflows.find((w) => /catalog/i.test(w.name))!.trigger).toMatchObject({ type: "schedule" });
    expect(spec.seedMemories.join("\n")).toMatch(/20 hours/);
    expect(spec.firstDeliverable.title).toMatch(/quote/i);
    expect(spec.firstDeliverable.instructions).toMatch(/GFM table/);
    expect(spec.resaleIdea).toMatch(/quote desk/i);
    expect(spec.weeklyHoursSaved).toBeGreaterThanOrEqual(20);
    expect(spec.requireApprovalFor).toContain("send_external_email");
    // Other businesses discussed on the podcast must not leak into this client's agent.
    const all = JSON.stringify(spec);
    expect(all).not.toMatch(/Carson|Brandlord|Four Corners|insurance|law firm|\$10,000|pulling records/i);
    expect(spec.openQuestions.length).toBeGreaterThan(2);
  });

  it("finds the insurance data-migration itch when the client is the insurance software company", () => {
    const spec = heuristicSpec({ transcript: PODCAST, orgName: "Policyline", industry: "Insurance agency management software" });
    expect(spec.role).toBe("Data Migration Specialist");
    expect(spec.workflows[0]!.name).toMatch(/migration/i);
    expect(spec.workflows[0]!.instructions).toMatch(/policy number/i);
    expect(spec.workflows.map((w) => w.name).join(" ")).not.toMatch(/catalog|quote/i);
    expect(spec.seedMemories.join("\n")).toMatch(/\$10,000/);
    expect(spec.resaleIdea).toMatch(/migration in a night/i);
    expect(spec.requireApprovalFor).toContain("write_client_system");
    expect(spec.tools).toEqual(expect.arrayContaining(["computer_click", "computer_type"]));
  });

  it("designs a dispatch-first agent for a synthetic HVAC discovery call", () => {
    const spec = heuristicSpec({ transcript: fixture("discovery-hvac.md"), orgName: "Ridgeline Heating & Air", industry: "HVAC contractor" });
    expect(spec.role).toBe("Dispatch Coordinator");
    expect(spec.workflows[0]).toMatchObject({ name: "Morning dispatch board", trigger: { type: "schedule", cron: "30 5 * * 1-6" } });
    expect(spec.workflows.map((w) => w.name)).toContain("Estimate follow-up");
    expect(spec.seedMemories.join("\n")).toMatch(/7\.5 hours\/week/); // "an hour and a half" every morning
    expect(spec.seedMemories.join("\n")).toMatch(/Linda \(office manager\)/);
    expect(spec.seedMemories.join("\n")).toMatch(/ServiceTitan/);
    expect(spec.seedMemories.join("\n")).toMatch(/always text customers/);
    expect(spec.channels).toContain("sms");
    expect(spec.firstDeliverable.title).toMatch(/dispatch/i);
  });

  it("designs a bookkeeping agent with receipts chasing and Monday cash reports", () => {
    const spec = heuristicSpec({ transcript: fixture("discovery-bookkeeping.md"), orgName: "Ledgerwise Bookkeeping", industry: "Bookkeeping" });
    const names = spec.workflows.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(["Missing receipts & documents follow-up", "Monday client cash reports", "Invoice prep & payment follow-up"]));
    const cash = spec.workflows.find((w) => w.name === "Monday client cash reports")!;
    expect(cash.trigger).toEqual({ type: "schedule", cron: "0 6 * * 1", label: "Mondays at 6:00 AM" });
    expect(cash.hoursSavedPerRun).toBe(5);
    expect(spec.seedMemories.join("\n")).toMatch(/Sam \(partner\)/);
    expect(spec.seedMemories.join("\n")).toMatch(/Xero/);
    expect(spec.resaleIdea).toMatch(/sell the Monday cash report/);
    expect(spec.requireApprovalFor).toEqual(expect.arrayContaining(["send_external_email", "send_invoice"]));
  });

  it("rejects transcripts that are too short", async () => {
    await expect(architect({ transcript: "hi" })).rejects.toThrow(/too short/);
  });
});

describe("discovery → proposal", () => {
  beforeEach(resetDb);

  it("createDiscovery queues the Architect; the job stores a valid proposal", async () => {
    const { client, user } = await makeOrgs({ clientName: "Summit Promo Co", industry: "Promotional products distribution" });
    const { discoveryId } = await createDiscovery({ orgId: client.id, title: "Kickoff call", transcript: PODCAST, actor: { type: "user", userId: user.id } });
    expect(await runJobsOnce({ types: ["discovery.analyze"] })).toBe(1);
    const [d] = await db().select().from(schema.discoveries).where(eq(schema.discoveries.id, discoveryId));
    expect(d!.status).toBe("ready");
    expect(agentSpec.parse(d!.proposal).role).toBe("Quoting Specialist");
    // Running it again is safe (idempotent overwrite).
    await analyzeDiscovery(discoveryId);
  });
});
