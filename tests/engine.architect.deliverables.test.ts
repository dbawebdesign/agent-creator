/** Offline work products (no DB): kind-specific output built from the brief, knowledge (incl. CSV) and memories. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { titleFromRequest } from "@/server/llm/offline";
import { compose, emailFromInstruction, tablesIn } from "@/server/llm/offline/compose";

const fixture = (f: string) => readFileSync(path.join(__dirname, "fixtures", f), "utf8");
const NOW = new Date("2026-11-02T12:00:00Z");
const CSV = {
  title: "claims-tracker.csv",
  text:
    "Claim #,Homeowner,Carrier,Adjuster,Adjuster email,Status,Last contact,Amount pending\n" +
    "SF-44821,Dana Ruiz,State Farm,Kyle Benson,kbenson@statefarm.example,Supplement sent,2026-10-21,$8400\n" +
    "AL-1209,Mo Patel,Allstate,Jen Ortiz,jortiz@allstate.example,Waiting on adjuster,2026-10-30,$3100\n" +
    "SF-45002,Lee Chan,State Farm,Kyle Benson,kbenson@statefarm.example,Inspection scheduled,2026-10-15,$12650",
};

function roofer() {
  const tr = fixture("discovery-roofing-claims.md");
  const spec = heuristicSpec({ transcript: tr, orgName: "Summit Peak Roofing" });
  const system = `You are ${spec.name}, ${spec.role} at Summit Peak Roofing. ${spec.summary}\n\n## About Summit Peak Roofing\n`;
  const chunks = tr.split(/\n\s*\n/).filter((c) => c.trim().length > 40).map((text) => ({ title: "Discovery call", text }));
  const memories = spec.seedMemories.map((text) => ({ title: "memory", text, kind: /^Preference/.test(text) ? "preference" : "fact" }));
  return { spec, system, chunks, memories };
}

/** Senior-SE bar for any offline deliverable. */
function looksLikeWork(body: string, preview: string) {
  expect(body).not.toMatch(/Drafted from your materials|steps? done|grounded in your materials|Feedback:|Using the discovery call/);
  expect(preview).not.toMatch(/\d+ steps? done|grounded/);
  expect(preview.split(/(?<=[.!?])\s+/).filter(Boolean)).toHaveLength(1);
}

describe("offline deliverables", () => {
  it("parses CSV knowledge into a table with aggregates", () => {
    const [t] = tablesIn([CSV]);
    expect(t!.headers).toContain("Adjuster email");
    expect(t!.rows).toHaveLength(3);
  });

  it("answers 'draft a follow-up email to the State Farm adjuster, #SF-44821' with a real email built from the claims CSV", () => {
    const { system, chunks, memories } = roofer();
    const d = compose({ kind: "message", title: titleFromRequest("Draft a follow-up email to the State Farm adjuster, #SF-44821"), output: "email_draft", body: "Draft a follow-up email to the State Farm adjuster, #SF-44821", system, knowledge: [CSV, ...chunks.slice(0, 2)], memories, now: NOW });
    expect(d.body).toMatch(/\*\*To:\*\* Kyle Benson <kbenson@statefarm\.example>/);
    expect(d.body).toMatch(/\*\*Subject:\*\* Claim SF-44821/);
    expect(d.body).toMatch(/> Hi Kyle,/);
    expect(d.body).toMatch(/12 days since we last heard back/);
    expect(d.body).toMatch(/> Milo\n> Summit Peak Roofing/);
    expect(d.body).not.toMatch(/AL-1209|SF-45002/); // only the claim asked about
    expect(d.body).toMatch(/## Needs your decision[\s\S]*deductibles/);
    expect(d.title.length).toBeLessThanOrEqual(60);
    looksLikeWork(d.body, d.preview);
  });

  it("runs the stalled-claims workflow from the CSV: queue table, days since contact, one email per adjuster", () => {
    const { spec, system, chunks, memories } = roofer();
    const w = spec.workflows[0]!;
    const d = compose({ kind: "workflow", title: w.name, output: w.outputKind, body: w.instructions, system, knowledge: [CSV, ...chunks.slice(0, 3)], memories, now: NOW });
    expect(d.body).toMatch(/## Queue/);
    expect(d.body).toMatch(/\| SF-45002 \|[^\n]*\| 18 \|/);
    expect(d.body).toMatch(/2 with no activity in 5\+ days/);
    expect(d.body.match(/\*\*To:\*\* Kyle Benson/g)).toHaveLength(1); // both of Kyle's claims in one email
    expect(d.body).not.toMatch(/\*\*To:\*\* Jen Ortiz/); // contacted 3 days ago: not stale
    looksLikeWork(d.body, d.preview);
  });

  it("first overnight deliverable for the dental practice: sheet format, checklist, patient texts, decisions", () => {
    const tr = fixture("discovery-dental.md");
    const spec = heuristicSpec({ transcript: tr, orgName: "Bright Harbor Family Dental" });
    const system = `You are ${spec.name}, ${spec.role} at Bright Harbor Family Dental.\n`;
    const d = compose({
      kind: "first_deliverable",
      title: spec.firstDeliverable.title,
      output: "document",
      body: `${spec.firstDeliverable.instructions}\n\nWhy: ${spec.firstDeliverable.description}`,
      system,
      knowledge: tr.split(/\n\s*\n/).map((text) => ({ title: "Discovery call", text })),
      memories: spec.seedMemories.map((text) => ({ title: "m", text, kind: /^Preference/.test(text) ? "preference" : "fact" })),
      now: NOW,
    });
    expect(d.body).toMatch(/## Summary[\s\S]*15 hours a week/);
    expect(d.body).toMatch(/\| Patient \| Appointment time \| Carrier \|/);
    expect(d.body).toMatch(/Patient who should reschedule \(text\)/);
    expect(d.body).toMatch(/## Needs your decision/);
    expect(d.body).toMatch(/## What I need from you/);
    looksLikeWork(d.body, d.preview);
  });

  it("revisions apply the feedback to the draft and say what changed", () => {
    const { system, chunks, memories } = roofer();
    const original = "## Summary\n\nQuote options below.\n\n## Options\n\n| Option | Price |\n|---|---|\n| Classic tote | $4.10 |\n| Premium tote | $6.90 |\n\n- Lead time 10 days\n- Minimum 100 units";
    const d = compose({
      kind: "revision",
      title: "Spring tote quote (revised)",
      output: "document",
      body: `Revise the deliverable below. Feedback: Use our navy and gold brand colors and show price breaks at 100/250/500 units. Change Classic tote to Everyday tote.\n\nOriginal (“Spring tote quote”):\n${original}`,
      system,
      knowledge: chunks.slice(0, 2),
      memories,
      now: NOW,
    });
    expect(d.body).toMatch(/^## What changed/);
    expect(d.body).toMatch(/navy and gold/);
    expect(d.body).toMatch(/\| Item \| 100 units \| 250 units \| 500 units \|/);
    expect(d.body).toMatch(/\| Everyday tote \|/);
    expect(d.body).not.toMatch(/\| Classic tote \|/);
    expect(d.body).toMatch(/Replaced “Classic tote” with “Everyday tote”/);
    looksLikeWork(d.body, d.preview);
  });

  it("an owner's 'email X: …' becomes a real email, not the instruction echoed", () => {
    const e = emailFromInstruction("Email the owner at dan@keystone.example: the 4B leak repair is done.", { agent: "Nora", role: "Maintenance Coordinator", org: "Keystone Residential" }, "dan@keystone.example", "Update");
    expect(e.body).toMatch(/^Hi Dan,/);
    expect(e.body).toMatch(/the 4B leak repair is done\./i);
    expect(e.body).not.toMatch(/Email the owner/);
    expect(e.body).toMatch(/Best,\nNora\nKeystone Residential$/);
    expect(e.subject).toMatch(/4B leak repair is done/i);
  });

  it("titles a portal request cleanly", () => {
    expect(titleFromRequest("can you pull together a quick moodboard direction for Kindred Bakery's spring launch?")).toBe("Kindred Bakery — spring launch moodboard direction");
    expect(titleFromRequest("Please draft a follow-up email to the State Farm adjuster, #SF-44821").length).toBeLessThanOrEqual(60);
  });
});
