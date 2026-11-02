import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { architect, finalizeSpec, heuristicSpec, pickAgentName, runsPerWeek, tidyText } from "@/server/agents/architect";
import { agentSpec, type AgentSpec } from "@/server/agents/spec";
import { db, schema } from "@/server/db/client";
import { runJobsOnce } from "@/server/jobs/handlers";
import { isValidCron } from "@/server/jobs/scheduler";
import { analyzeDiscovery, createDiscovery, hireAgent } from "@/server/services/engine";
import { makeOrgs, resetDb } from "./engine.helpers";

const fixture = (f: string) => readFileSync(path.join(__dirname, "fixtures", f), "utf8");
const PODCAST = fixture("podcast-ai-employees.md");

/**
 * Rubric every offline proposal must pass, whatever the business:
 * the main pain is the first workflow and the first deliverable; nothing comes from words said in passing;
 * schedules are valid and hours come from the owner's numbers; outbound sends need approval; it says it is a draft.
 */
type Rubric = {
  file: string;
  org: string;
  industry?: string | null;
  main: RegExp;
  /** Other pains the owner described: each must be some workflow. */
  also?: RegExp[];
  /** Workflow names that would only come from incidental words. */
  never: RegExp;
  weekly: [number, number];
  role: RegExp;
  extra?: (spec: AgentSpec) => void;
};

function allText(spec: AgentSpec): string[] {
  return [
    spec.role,
    spec.summary,
    spec.instructions,
    spec.voice,
    spec.resaleIdea,
    ...spec.workflows.flatMap((w) => [w.name, w.problem, w.instructions]),
    ...spec.knowledgeNeeds.flatMap((k) => [k.title, k.why]),
    ...spec.seedMemories,
    spec.firstDeliverable.title,
    spec.firstDeliverable.description,
    spec.firstDeliverable.instructions,
    ...spec.openQuestions,
  ];
}

function checkRubric(r: Rubric): AgentSpec {
  const spec = heuristicSpec({ transcript: fixture(r.file), orgName: r.org, industry: r.industry ?? null });
  expect(() => agentSpec.parse(spec)).not.toThrow();
  const names = spec.workflows.map((w) => w.name);
  expect(spec.workflows.length).toBeGreaterThanOrEqual(1);
  expect(spec.workflows.length).toBeLessThanOrEqual(5);
  expect(`${names[0]} ${spec.workflows[0]!.instructions}`).toMatch(r.main);
  for (const a of r.also ?? []) expect(names.join(" | ")).toMatch(a);
  for (const n of names) expect(n).not.toMatch(r.never);
  expect(spec.role).toMatch(r.role);
  expect(spec.firstDeliverable.title).toMatch(r.main);
  expect(spec.weeklyHoursSaved).toBeGreaterThanOrEqual(r.weekly[0]);
  expect(spec.weeklyHoursSaved).toBeLessThanOrEqual(r.weekly[1]);
  for (const w of spec.workflows) {
    if (w.trigger.type === "schedule") expect(isValidCron(w.trigger.cron)).toBe(true);
    expect(w.hoursSavedPerRun).toBeGreaterThan(0);
    // No single run claims more than a couple of working days.
    expect(w.hoursSavedPerRun * Math.min(1, runsPerWeek(w.trigger))).toBeLessThanOrEqual(16);
    expect(w.instructions).not.toMatch(/undefined|null|\[object/);
  }
  expect(spec.requireApprovalFor).toEqual(expect.arrayContaining(["send_external_email", "send_external_sms"]));
  if (spec.tools.some((t) => t.startsWith("computer_"))) expect(spec.requireApprovalFor).toContain("write_client_system");
  // The "drafted offline" notice is for the agency's review only; open questions get copied to the client.
  expect(spec.draftNote).toMatch(/offline/i);
  expect(spec.openQuestions.join(" ")).not.toMatch(/offline|AI model|extractor/i);
  // Template wording is clean English ("The the weekly…", "a operations…" never reach the client).
  for (const text of allText(spec)) expect(tidyText(text)).toBe(text);
  r.extra?.(spec);
  return spec;
}

describe("Architect (offline) — held-out discovery calls", () => {
  it("dental: insurance verification first, unscheduled treatment second; no 'lead' workflow from 'front desk lead, Rosa'", () => {
    checkRubric({
      file: "discovery-dental.md",
      org: "Bright Harbor Family Dental",
      main: /insurance verification/i,
      also: [/unscheduled treatment/i],
      never: /\blead|estimate|quote|dispatch/i,
      weekly: [10, 25],
      role: /verification/i,
      extra: (spec) => {
        const v = spec.workflows[0]!;
        expect(v.trigger).toMatchObject({ type: "schedule", cron: "30 6 * * 1-5" }); // before Rosa's 7:15 start
        expect(v.instructions).toMatch(/Dentrix/);
        expect(v.instructions).toMatch(/Delta Dental portal/);
        expect(v.instructions).toMatch(/remaining annual max/);
        expect(spec.workflows.find((w) => /unscheduled/i.test(w.name))!.instructions).toMatch(/\$180,000/);
        expect(spec.channels).toContain("sms");
        expect(spec.openQuestions.join(" ")).toMatch(/HIPAA/);
        expect(spec.seedMemories.join("\n")).toMatch(/Rosa \(front desk lead\)/);
        expect(spec.seedMemories.join("\n")).toMatch(/Morning deliverables go to Rosa by email/);
        expect(spec.vertical).toMatch(/dental/i);
      },
    });
  });

  it("property manager: maintenance triage, monthly owner reports, after-hours and renewals; dollar thresholds kept", () => {
    checkRubric({
      file: "discovery-property.md",
      org: "Keystone Residential",
      main: /maintenance/i,
      also: [/owner reports/i, /after-hours/i, /lease renewal/i],
      never: /dispatch board|technician|estimate|quote|cooling/i,
      weekly: [10, 30],
      role: /maintenance/i,
      extra: (spec) => {
        const triage = spec.workflows[0]!;
        expect(triage.instructions).toMatch(/\$500/);
        expect(triage.instructions).toMatch(/\$250/);
        const reports = spec.workflows.find((w) => /owner reports/i.test(w.name))!;
        expect(reports.trigger).toMatchObject({ type: "schedule", cron: "0 6 6 * *" }); // drafts ahead of "by the 10th"
        expect(reports.instructions).toMatch(/rent collected/);
        expect(reports.instructions).toMatch(/AppFolio/);
        expect(spec.workflows.find((w) => /after-hours/i.test(w.name))!.trigger).toEqual({ type: "event", event: "sms.received" });
        expect(spec.workflows.find((w) => /renewal/i.test(w.name))!.instructions).toMatch(/60 days/);
        expect(spec.vertical).toBe("Property management");
      },
    });
  });

  it("roofing contractor: insurance claim packets and supplements; the $40K/month is the stake", () => {
    checkRubric({
      file: "discovery-roofing.md",
      org: "Summit Ridge Roofing",
      main: /claim/i,
      never: /quote|lead|dispatch|review/i,
      weekly: [8, 20],
      role: /claims/i,
      extra: (spec) => {
        expect(spec.workflows[0]!.instructions).toMatch(/drip edge/);
        expect(spec.workflows[0]!.problem).toMatch(/12 hours a week|\$40,000/);
        expect(spec.instructions).toMatch(/Nothing goes to an adjuster or a carrier without Tamara or me/);
        expect(spec.seedMemories.join("\n")).toMatch(/Tamara \(office manager\)/);
        expect(spec.vertical).toMatch(/roofing/i);
      },
    });
  });

  it("roofing call run by a named operator: client owner (not the operator), three asks, and the 'never' rules", () => {
    checkRubric({
      file: "discovery-roofing-claims.md",
      org: "Summit Peak Roofing",
      main: /claim/i,
      also: [/supplement/i, /homeowner update/i],
      never: /quote|lead|dispatch|review|insurance verification/i,
      weekly: [15, 35],
      role: /claims/i,
      extra: (spec) => {
        const all = JSON.stringify(spec);
        expect(all).not.toMatch(/Marco/); // the agency operator running the call
        expect(spec.seedMemories.join("\n")).toMatch(/Rick \(owner/);
        expect(spec.seedMemories.join("\n")).toMatch(/Tasha \(office manager\)/);
        expect(spec.vertical).toMatch(/roofing/i);
        expect(spec.vertical).not.toMatch(/insurance/i);
        expect(spec.instructions).toMatch(/Never promise a homeowner a dollar amount or a date/);
        expect(spec.instructions).toMatch(/never talk about deductibles/i);
        const update = spec.workflows.find((w) => /homeowner update/i.test(w.name))!;
        expect(update.instructions).toMatch(/deductibles/); // guardrails travel with outbound work
        expect(spec.workflows[0]!.trigger).toMatchObject({ type: "schedule", cron: "15 6 * * 1-5" }); // waiting at 7am
        expect(spec.workflows[0]!.instructions).toMatch(/Google Sheet/);
      },
    });
  });

  it("boutique accounting firm: month-end close first (60 h/month), W-9/1099 season second, guarded posting", () => {
    checkRubric({
      file: "discovery-accounting.md",
      org: "Hollis & Park CPAs",
      main: /close/i,
      also: [/1099/i],
      never: /cash report|invoice|quote|lead|review/i,
      weekly: [8, 25],
      role: /close/i,
      extra: (spec) => {
        const close = spec.workflows[0]!;
        expect(close.trigger).toMatchObject({ type: "schedule", cron: "0 7 1-8 * *" });
        expect(close.instructions).toMatch(/QuickBooks Online/);
        expect(close.instructions).toMatch(/Balance sheet/i);
        expect(spec.workflows.find((w) => /1099/.test(w.name))!.trigger).toMatchObject({ type: "schedule", cron: "0 7 * 1,12 1" });
        expect(spec.requireApprovalFor).toContain("write_client_system");
        expect(spec.openQuestions.join(" ")).toMatch(/PII/);
        expect(spec.seedMemories.join("\n")).toMatch(/Morning deliverables go to Marcus/);
      },
    });
  });

  it("HVAC: dispatch board, estimate follow-up, reviews; texts the owner before he's in the truck", () => {
    checkRubric({
      file: "discovery-hvac.md",
      org: "Ridgeline Heating & Air",
      industry: "HVAC contractor",
      main: /dispatch/i,
      also: [/estimate follow-up/i],
      never: /lead|invoice|quote builder/i,
      weekly: [8, 20],
      role: /dispatch/i,
      extra: (spec) => {
        expect(spec.workflows[0]!.trigger).toMatchObject({ type: "schedule", cron: "45 5 * * 1-5" }); // in the truck by 6:30
        expect(spec.seedMemories.join("\n")).toMatch(/7\.5 hours\/week/); // "an hour and a half" every morning
        expect(spec.seedMemories.join("\n")).toMatch(/Linda \(office manager\)/);
        expect(spec.seedMemories.join("\n")).toMatch(/ServiceTitan/);
        expect(spec.seedMemories.join("\n")).toMatch(/always text customers/);
        expect(spec.channels).toContain("sms");
      },
    });
  });

  it("bookkeeping: receipts chasing, Monday client cash reports, invoicing; partner reviews before sending", () => {
    checkRubric({
      file: "discovery-bookkeeping.md",
      org: "Ledgerwise Bookkeeping",
      industry: "Bookkeeping",
      main: /receipts/i,
      also: [/Monday client cash reports/, /invoice/i],
      never: /lead|quote|dispatch/i,
      weekly: [10, 20],
      role: /follow-up/i,
      extra: (spec) => {
        const cash = spec.workflows.find((w) => w.name === "Monday client cash reports")!;
        expect(cash.trigger).toEqual({ type: "schedule", cron: "0 7 * * 1", label: "Mondays at 7:00 AM" });
        expect(cash.hoursSavedPerRun).toBe(4); // 5 h/week stated, ~80% saved
        expect(cash.instructions).toMatch(/cash on hand/);
        expect(spec.seedMemories.join("\n")).toMatch(/Sam \(partner\)/);
        expect(spec.seedMemories.join("\n")).toMatch(/Xero/);
        expect(spec.resaleIdea).toMatch(/sell the Monday cash report/);
      },
    });
  });
});

describe("Architect (offline) — podcast transcript", () => {
  it("turns the real podcast transcript into a promo-products quoting agent without leaking other businesses", async () => {
    const { spec, model } = await architect({ transcript: PODCAST, orgName: "Summit Promo Co", industry: "Promotional products distribution" });
    expect(model).toBe("roster-offline-1");
    expect(() => agentSpec.parse(spec)).not.toThrow();
    expect(spec.role).toBe("Quoting Specialist");
    expect(spec.vertical).toBe("Promotional products distribution");
    const names = spec.workflows.map((w) => w.name);
    expect(names[0]).toMatch(/quote/i);
    expect(names.join(" ")).toMatch(/catalog/i); // "scrape all these products, categories, and catalogs"
    expect(names.join(" ")).not.toMatch(/migration/i); // that itch belongs to the insurance example on the call
    expect(spec.workflows[0]!.problem).toMatch(/20 hours a week/);
    expect(spec.workflows.find((w) => /catalog/i.test(w.name))!.trigger).toMatchObject({ type: "schedule" });
    expect(spec.seedMemories.join("\n")).toMatch(/20 hours/);
    expect(spec.firstDeliverable.title).toMatch(/quote kit/i);
    expect(spec.firstDeliverable.instructions).toMatch(/GFM table/);
    expect(spec.resaleIdea).toMatch(/quote desk/i);
    expect(spec.weeklyHoursSaved).toBeGreaterThanOrEqual(15);
    expect(spec.requireApprovalFor).toEqual(expect.arrayContaining(["send_external_email", "send_external_sms"]));
    const all = JSON.stringify(spec);
    expect(all).not.toMatch(/Carson|Brandlord|Four Corners|law firm|\$10,000|pulling records/i);
    expect(spec.draftNote).toMatch(/offline/i);
    expect(spec.openQuestions.join(" ")).not.toMatch(/offline/i);
  });

  it("finds the insurance data-migration itch when the client is the insurance software company", () => {
    const spec = heuristicSpec({ transcript: PODCAST, orgName: "Policyline", industry: "Insurance agency management software" });
    expect(spec.role).toBe("Data Migration Specialist");
    expect(spec.workflows[0]!.name).toMatch(/migration/i);
    expect(spec.workflows[0]!.trigger).toEqual({ type: "manual" });
    expect(spec.workflows[0]!.instructions).toMatch(/policy number/i);
    expect(spec.workflows.map((w) => w.name).join(" ")).not.toMatch(/catalog|quote/i);
    expect(spec.seedMemories.join("\n")).toMatch(/\$10,000/);
    expect(spec.resaleIdea).toMatch(/migration in a night/i);
    expect(spec.requireApprovalFor).toContain("write_client_system");
    expect(spec.tools).toEqual(expect.arrayContaining(["computer_click", "computer_type"]));
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

describe("Architect output polish (design critique r3 H4)", () => {
  beforeEach(resetDb);

  it("never reuses a name already taken in the agency, by a person on the call, or by a member; Lena is out of the pool", () => {
    const base = heuristicSpec({ transcript: PODCAST, orgName: "Summit Promo Co", industry: "Promotional products distribution" });
    const other = heuristicSpec({ transcript: PODCAST, orgName: "Summit Promo Co", industry: "Promotional products distribution", avoidNames: [base.name, "Rachel Kim"] });
    expect(other.name).not.toBe(base.name);
    expect(other.instructions).toContain(`You are ${other.name},`);
    expect(other.summary.startsWith(`${other.name} `)).toBe(true);
    for (let i = 0; i < 200; i++) expect(pickAgentName(`seed-${i}`, [])).not.toBe("Lena");
    expect(pickAgentName("x", ["quinn", "Dr. Maya Chen"])).not.toMatch(/^(?:Quinn|Maya)$/);
  });

  it("a model-designed agent whose name is taken is renamed where it names itself", () => {
    const base = heuristicSpec({ transcript: PODCAST, orgName: "Summit Promo Co" });
    const fromModel = { ...base, name: "Quinn", summary: `Quinn drafts quotes for Summit Promo Co.`, instructions: `You are Quinn, the quoting specialist. Ask Quinn Rivera in finance before discounts.` };
    const s = finalizeSpec(fromModel, { avoidNames: ["Quinn"] });
    expect(s.name).not.toBe("Quinn");
    expect(s.summary).toBe(`${s.name} drafts quotes for Summit Promo Co.`);
    expect(s.instructions).toBe(`You are ${s.name}, the quoting specialist. Ask Quinn Rivera in finance before discounts.`);
    expect(finalizeSpec(fromModel).name).toBe("Quinn");
  });

  it("analyzeDiscovery avoids names used by agents elsewhere in the agency and by the client's people", async () => {
    const { agency, client, user } = await makeOrgs({ clientName: "Summit Promo Co", industry: "Promotional products distribution" });
    const [sibling] = await db()
      .insert(schema.organizations)
      .values({ kind: "client", name: "Coastal Promo Co.", slug: `coastal-${Date.now()}`, parentId: agency.id, agencyId: agency.id })
      .returning();
    const taken = heuristicSpec({ transcript: PODCAST, orgName: "Summit Promo Co", industry: "Promotional products distribution" });
    await hireAgent({ orgId: sibling!.id, spec: taken, actor: { type: "system" } });
    const next = pickAgentName("Summit Promo Co:quote", [taken.name]);
    await db().update(schema.users).set({ name: `${next} Park` }).where(eq(schema.users.id, user.id));
    const { discoveryId } = await createDiscovery({ orgId: client.id, title: "Kickoff", transcript: PODCAST, actor: { type: "user", userId: user.id } });
    const spec = await analyzeDiscovery(discoveryId);
    expect(spec.name).not.toBe(taken.name);
    expect(spec.name).not.toBe(next);
    expect(spec.draftNote).toMatch(/offline/i);
    expect(spec.openQuestions.join(" ")).not.toMatch(/offline/i);
  });

  it("dedupes articles from templates: no “The the weekly operations summary”", () => {
    expect(tidyText("The the weekly operations summary process. Do the the a report for a operations team.")).toBe("The weekly operations summary process. Do the report for an operations team.");
    expect(tidyText("Plan A or B for the A team; quote “the the thing” exactly.")).toBe("Plan A or B for the A team; quote “the the thing” exactly.");
    const spec = heuristicSpec({ transcript: "We talked about the weather, the weekend, and how the kids are doing in school this year.", orgName: "Four Corners Coffee" });
    expect(spec.workflows[0]!.name).toBe("Weekly operations summary");
    for (const text of allText(spec)) {
      expect(text).not.toMatch(/\b(?:the|a|an) (?:the|a|an)\b/i);
      expect(tidyText(text)).toBe(text);
    }
  });
});
