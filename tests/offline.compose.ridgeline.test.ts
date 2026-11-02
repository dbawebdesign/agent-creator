/**
 * Critic r5 (insurance agency, 18-row renewals.csv) regressions: the ask "every policy renewing in the next 30 days
 * that hasn't been quoted yet, soonest first, a renewal email to each client" is 10 rows (9 without Castillo).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerQuestion, compose, type Snip } from "@/server/llm/offline/compose";
import { collectTables, planRows } from "@/server/llm/offline/tablework";

const F = join(__dirname, "fixtures/ridgeline");
const knowledge = JSON.parse(readFileSync(join(F, "knowledge.json"), "utf8")) as Snip[];
const memories = JSON.parse(readFileSync(join(F, "memories.json"), "utf8")) as Snip[];
const [wf] = JSON.parse(readFileSync(join(F, "workflows.json"), "utf8")) as Array<{ name: string; outputKind: string; instructions: string }>;
const first = JSON.parse(readFileSync(join(F, "first-deliverable-input.json"), "utf8")) as Record<string, string>;
const system = "You are Felix, Adjuster Follow-up Coordinator at Ridgeline Insurance Group.\n";
const now = new Date("2026-11-02T08:00:00Z");
const NINE = ["Summit Roofing", "Evergreen Landscaping", "Harlow Bakery", "Tri-County Electric", "Okoro Family Dental", "Brightwater Marina", "Northside Plumbing", "Oak Hollow Vineyard", "Delgado Auto Repair"];
const rowsOf = (body: string) => [...body.matchAll(/^\| (\d+) \| ([^|]+) \|/gm)].map((m) => m[2]!.trim());
const DEBUG = /Couldn't apply|no column called that|\(columns:|sort by “”|-\d+ days/;
const run = (kind: string, title: string, output: string, body: string) => compose({ kind, title, output, body, system, knowledge, memories, now });

describe("C-2 planRows reads plain asks", () => {
  const [t] = collectTables(knowledge);
  it("the file has 18 rows", () => expect(t!.rows).toHaveLength(18));
  it("“next 30 days” beats the hypothetical “if I woke up tomorrow”; “hasn't been quoted” stays negative; soonest first", () => {
    const p = planRows(t!, first.description!, [], now);
    expect(p.applied).toEqual(["status is not quoted", "renewal date in the next 30 days"]);
    expect(p.sortedBy).toBe("renewal date, soonest first");
    expect(p.unmapped).toEqual([]);
    expect(p.rows.map((r) => r[0])).toEqual(["Summit Roofing", "Evergreen Landscaping", "Harlow Bakery", "Castillo Builders", ...NINE.slice(3)]);
  });
  it("“not yet quoted”, “without a quote”, “most urgent first”", () => {
    for (const ask of ["policies renewing within 30 days not yet quoted, most urgent first", "renewals in the next 30 days without a quote, earliest first"]) {
      const p = planRows(t!, ask, [], now);
      expect(p.rows).toHaveLength(10);
      expect(p.rows[0]![0]).toBe("Summit Roofing");
    }
  });
});

describe("C-1 Run now on the email_draft workflow applies its own procedure", () => {
  const d = run("workflow", wf!.name, wf!.outputKind, wf!.instructions);
  it("9 rows, soonest first, Castillo skipped, one renewal email per contact", () => {
    expect(rowsOf(d.body)).toEqual(NINE);
    expect(d.body).toMatch(/^\| # \| client_name \| contact_name \| policy_type \| carrier \| renewal_date \| When \|$/m);
    expect(d.body.match(/^\*\*To:\*\* /gm)).toHaveLength(9);
    expect(d.body).toMatch(/\*\*To:\*\* Ben Carter <ben@summitroofing\.example\.com>/);
    expect(d.body).not.toMatch(/Castillo Builders —|marco@|Blue Heron|owen@|days since we last heard/);
    expect(d.body).not.toMatch(DEBUG);
    expect(d.body).not.toMatch(/\$?\b(?:22100|22,100)\b[^|]*$/m); // no premium in the drafts
  });
  it("addresses Dr. Okoro as Dr. Okoro", () => {
    expect(d.body).toMatch(/> Hi Dr\. Okoro,/);
  });
  it("never chases a lapsed client in the old follow-up path either", () => {
    const old = run("workflow", "Follow-up", "email_draft", "Email each client with no reply in 5+ days and ask where things stand.");
    expect(old.body).not.toMatch(/^\*\*To:\*\*.*owen@|^#### Blue Heron/m);
  });
});

describe("first deliverable (the ask, held overnight)", () => {
  const d = run("first_deliverable", first.title!, first.outputKind!, `${first.instructions}\n\nWhy: ${first.description}`);
  it("lists the 10, Castillo listed but never drafted, no debug text", () => {
    expect(rowsOf(d.body)).toHaveLength(10);
    expect(d.body).toMatch(/\| Castillo Builders \|[^\n]*Do not contact \(your rule\)/);
    expect(d.body).toMatch(/9 emails drafted/);
    expect(d.body).not.toMatch(DEBUG);
  });
});

describe("H-1 / H-3 / H-5", () => {
  it("an unmappable sort is said once in plain words", () => {
    const d = run("workflow", "Renewals", "table", "Use renewals.csv. List every policy that is not quoted, sorted by broker.");
    expect(d.body).toMatch(/_Note: I couldn't tell which column “broker” means, so the rows keep the file's order\._/);
    expect(d.body).not.toMatch(DEBUG);
  });
  it("a revision that cannot sort says so instead of claiming it re-sorted", () => {
    const v1 = run("workflow", wf!.name, "table", wf!.instructions).body;
    const r = run("revision", `${wf!.name} (revised)`, "table", `Revise the deliverable below. Feedback: Sort it by broker, top first.\n\nOriginal (“${wf!.name}”):\n${v1}`);
    expect(r.body).not.toMatch(/re-sorted as asked/);
  });
  it("a draft about Erin Walsh goes to Erin, by first name, about the renewal", () => {
    const d = run("message", "Renewal", "email_draft", "Draft a renewal email to Erin Walsh about her general liability renewal");
    expect(d.body).toMatch(/\*\*To:\*\* Erin Walsh <erin@mapleleafdaycare\.example\.com>/);
    expect(d.body).toMatch(/> Hi Erin,\n>\n> Your general liability policy with Philadelphia for Maple Leaf Daycare renews on Dec 1\./);
    expect(d.body).not.toMatch(/Hi Maple|booked|7400|annual_premium/);
  });
  it("MCP/REST answer: same filters and sort, the full list, no negative days", () => {
    const [a] = answerQuestion("Which policies renew in the next 30 days and are still not quoted, soonest first?", knowledge, now);
    expect(a).toMatch(/^10 policies in renewals\.csv/);
    expect(a).toMatch(/Summit Roofing — Nov 3 \(in 1 day\)/);
    expect(a).toMatch(/Delgado Auto Repair — Nov 28 \(in 26 days\)/);
    expect(a).not.toMatch(/-\d+ days|and \d+ more|Pine Street|Blue Heron/);
    expect(a!.indexOf("Summit")).toBeLessThan(a!.indexOf("Delgado"));
  });
});
