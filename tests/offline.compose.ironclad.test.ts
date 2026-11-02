/**
 * Critic r6 (roofing, 20-row estimates.csv): "every estimate over $10,000 sitting unsigned for more than 7 days,
 * biggest first, a follow-up email to each homeowner" is 8 drafts; the Hendersons on Maple Court are never contacted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compose, type Snip } from "@/server/llm/offline/compose";
import { collectTables, exclusionsFrom, planRows } from "@/server/llm/offline/tablework";

const F = join(__dirname, "fixtures/ironclad");
const knowledge = JSON.parse(readFileSync(join(F, "knowledge.json"), "utf8")) as Snip[];
const memories = JSON.parse(readFileSync(join(F, "memories.json"), "utf8")) as Snip[];
const first = JSON.parse(readFileSync(join(F, "first-deliverable-input.json"), "utf8")) as Record<string, string>;
const system = "You are Rex, Estimator at Ironclad Roofing & Exteriors.\n";
const now = new Date("2026-11-02T08:00:00Z");
const RULE = "Never contact the Hendersons on Maple Court; Rick Alvarez handles them personally, nobody else talks to them.";
const EIGHT = ["Novak residence", "Kowalski residence", "O'Brien residence", "Patel residence", "Lindqvist residence", "Whitfield residence", "Ito residence", "Albright residence"];
const drafted = (body: string) => [...body.matchAll(/^#### (.+?) — /gm)].map((m) => m[1]!);
const run = (kind: string, title: string, output: string, body: string) => compose({ kind, title, output, body, system, knowledge, memories, now });

describe("never-contact rules match plural names and the address", () => {
  it("“the Hendersons on Maple Court” → Henderson / Maple Court, not the person who handles them", () => {
    const [ex] = exclusionsFrom("", [RULE]);
    expect(ex!.names).toEqual(expect.arrayContaining(["Henderson", "Maple Court"]));
    expect(ex!.names).not.toContain("Rick Alvarez");
  });
  it("the first deliverable lists Henderson with the note and never drafts to him", () => {
    const d = run("first_deliverable", first.title!, first.outputKind!, `${first.instructions}\n\nWhy: ${first.description}`);
    expect(d.body).toMatch(/\| Henderson residence \|[^\n]*Do not contact \(your rule\) \|/);
    expect(drafted(d.body)).toEqual(EIGHT);
    expect(d.body).not.toMatch(/^#### Henderson|^\*\*To:\*\* Mark|Hi Mark/m);
  });
  it("a workflow run and a revision never draft to Henderson either", () => {
    const wf = run("workflow", "Estimate follow-up", "email_draft", "Use estimates.csv. Every estimate over $10,000 still at status sent, sent more than 7 days ago, biggest first. Draft a follow-up email to each homeowner by first name.");
    expect(drafted(wf.body)).toEqual(EIGHT);
    const rev = run("revision", "Estimate follow-up (revised)", "table", `Revise the deliverable below. Feedback: Leave out Tank.\n\nOriginal (“Estimate follow-up”):\n${wf.body}`);
    expect(rev.body).not.toMatch(/^#### Henderson/m);
  });
});

describe("status words and age filters", () => {
  const [t] = collectTables(knowledge);
  it("“unsigned for more than 7 days” → not signed / declined, sent_date more than 7 days ago", () => {
    const p = planRows(t!, "every estimate over $10,000 that's been sitting unsigned for more than 7 days, biggest dollar amount first", [], now);
    expect(p.applied).toEqual(["status is not signed or declined", "amount > $10000", "sent date more than 7 days ago"]);
    expect(p.rows.map((r) => r[1])).toEqual([...EIGHT.slice(0, 3), "Henderson residence", ...EIGHT.slice(3)]);
  });
  it("“hasn't signed” and “not signed” read the same", () => {
    for (const ask of ["estimates the homeowner hasn't signed, over $10,000", "estimates not signed, over $10,000"]) {
      expect(planRows(t!, ask, [], now).rows.every((r) => r[9] === "sent")).toBe(true);
    }
  });
  it("a follow-up never goes to an already-signed row, and is an estimate follow-up, not a booking", () => {
    const d = run("workflow", "Follow-ups", "table", "Use estimates.csv. List every estimate over $20,000. Draft a follow-up email to each homeowner.");
    expect(d.body).not.toMatch(/^#### Brooks residence/m);
    expect(d.body).toMatch(/No draft for Brooks residence \(Tanya Brooks\) \(status: signed\)/);
    expect(d.body).not.toMatch(/get it booked|coming up/);
    expect(d.body).toMatch(/> I wanted to follow up on the metal roof estimate we sent you on Oct 3\./);
  });
});

describe("revision: leave out by status value", () => {
  it("“Leave out the signed and declined estimates” removes those rows", () => {
    const v1 = run("workflow", "Big estimates", "table", "Use estimates.csv. List every estimate over $10,000, biggest first.");
    expect(v1.body).toMatch(/\| Brooks residence \|/);
    const r = run("revision", "Big estimates (revised)", "table", `Revise the deliverable below. Feedback: Leave out the signed and declined estimates.\n\nOriginal (“Big estimates”):\n${v1.body}`);
    expect(r.body).not.toMatch(/\| (?:Brooks|Harper|Fischer) residence \|/);
    expect(r.body).not.toMatch(/Nothing changed/);
    expect(/^## What changed\n\n([^\n]+)/.exec(r.body)?.[1]).toMatch(/15 → 12 rows/);
  });
});

describe("client-facing wording is industry-neutral and has no engine text", () => {
  it("no insurance phrases, batch counts or addressing instructions", () => {
    const d = run("message", "Follow-ups", "email_draft", "Write a follow-up email to every homeowner with an estimate over $10,000");
    expect(d.body).not.toMatch(/policy or account|per run|Name one person|run this as a workflow|I draft the first/);
  });
});
