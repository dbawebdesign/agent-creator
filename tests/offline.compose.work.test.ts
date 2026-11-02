/**
 * Offline deliverables do the work on the client's rows (critic r4, Harborview Animal Hospital fixtures copied from
 * the critic's run: overdue_patients.csv as the two chunks the indexer stored, reminder_policy.docx, call memories).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { db, schema } from "@/server/db/client";
import { extractText } from "@/server/files/extract";
import { runJobsOnce } from "@/server/jobs/handlers";
import { indexText } from "@/server/knowledge";
import { setLlmProviderForTests } from "@/server/llm";
import { answerQuestion, compose, stepsOf, type Snip } from "@/server/llm/offline/compose";
import { enqueue } from "@/server/jobs/queue";
import { hireAgent, messageAgent, releaseHeldDeliverable } from "@/server/services/engine";
import { makeOrgs, resetDb, tzAtLocalHour } from "./engine.helpers";
import { collectTables, planRows } from "@/server/llm/offline/tablework";
import { offlineProvider } from "@/server/llm/offline";

const F = join(__dirname, "fixtures/harborview");
const knowledge = JSON.parse(readFileSync(join(F, "knowledge.json"), "utf8")) as Snip[];
const memories = JSON.parse(readFileSync(join(F, "memories.json"), "utf8")) as Snip[];
const workflows = JSON.parse(readFileSync(join(F, "workflows.json"), "utf8")) as Array<{ name: string; outputKind: string; instructions: string }>;
const first = JSON.parse(readFileSync(join(F, "first-deliverable-input.json"), "utf8")) as Record<string, string>;
const oldRecalls = readFileSync(join(F, "old-vaccine-recalls.md"), "utf8");
const system = "You are Sage, Crew Scheduling Coordinator at Harborview Animal Hospital.\n";
const now = new Date("2026-11-02T07:00:00Z");
const recalls = workflows.find((w) => w.name === "Vaccine recalls")!;

const tableRows = (body: string) => [...body.matchAll(/^\| (\d+) \| ([^|]+) \|/gm)].map((m) => m[2]!.trim());
const JUNK = /\{[^}]*\}|checking in|one open item|Approve, edit or reject|Example A|\(example\)|done from the data/i;

function run(kind: string, title: string, output: string, body: string) {
  return compose({ kind, title, output, body, system, knowledge, memories, now });
}

describe("tables from chunks", () => {
  it("merges a file's blocks across chunks: 8 rows, the count the file states", () => {
    const [t] = collectTables(knowledge);
    expect(t!.title).toBe("overdue_patients.csv");
    expect(t!.rows).toHaveLength(8);
    expect(t!.total).toBe(8);
    expect(t!.rows.map((r) => r[0])).toContain("Tank");
  });

  it("parses thresholds, value filters, sort and top N against the headers", () => {
    const [t] = collectTables(knowledge);
    const p = planRows(t!, "every patient more than 90 days overdue for vaccines, sorted by days overdue", [], now);
    expect(p.rows.map((r) => r[0])).toEqual(["Hazel", "Juniper", "Biscuit"]);
    const top = planRows(t!, "top 2 most overdue patients", [], now);
    expect(top.rows.map((r) => r[0])).toEqual(["Hazel", "Juniper"]);
    const fv = planRows(t!, "which patients are overdue for FVRCP", [], now);
    expect(fv.rows.map((r) => r[0])).toEqual(["Pepper"]);
  });

  it("says which column it needs when the criteria don't map, and shows every row", () => {
    const csv: Snip = { title: "invoices.csv", text: "customer,invoice,amount\nAcme,INV-1,$400\nBolt,INV-2,$1200\nCrane,INV-3,$90" };
    const d = compose({ kind: "workflow", title: "Collections", output: "table", body: "Read invoices.csv. List every invoice past due, sorted by due date.", system, knowledge: [csv], memories: [], now });
    expect(d.body).toMatch(/Couldn't apply:.*(?:due-date|status) column/);
    expect(tableRows(d.body)).toHaveLength(3);
    expect(d.body).not.toMatch(JUNK);
  });

  it("date windows: appointments this week", () => {
    const csv: Snip = { title: "appointments.csv", text: "client,pet,appointment_date,service\nAna Ruiz,Bo,2026-11-03,Exam\nLi Wei,Kit,2026-11-12,Dental\nSam Ode,Rex,2026-11-06,Vaccine" };
    const [t] = collectTables([csv]);
    expect(planRows(t!, "list appointments this week", [], now).rows.map((r) => r[1])).toEqual(["Bo", "Rex"]);
  });
});

describe("Vaccine recalls workflow (table) with the CSV on file", () => {
  const d = run("workflow", recalls.name, recalls.outputKind, recalls.instructions);

  it("lists the actual rows: rabies or DHPP, most overdue first, Biscuit left out", () => {
    expect(tableRows(d.body)).toEqual(["Hazel", "Juniper", "Tank", "Mochi", "Rocket", "Waffles"]);
    expect(d.body).toMatch(/^6 patients .*most overdue first — from overdue_patients\.csv \(8 rows\)/m);
    expect(d.body).toMatch(/Hazel is the most overdue at 125 days/);
    expect(d.body).not.toMatch(/\| Biscuit \|/);
    expect(d.body).toMatch(/Left out: Biscuit \(Joan Whitfield\)/);
    expect(d.data).toMatchObject({ substantive: true, rows: 6 });
  });

  it("drafts one text per owner, to the owner, with the booking link; Elm St. Rescue waits for sign-off", () => {
    expect(d.body).toMatch(/Text to Nora Patel · 555-0168\n\n> Hi Nora, this is Harborview Animal Hospital\. Hazel's rabies vaccine is overdue \(it was due Jun 30\)\. You can book a time at harborviewvet\.example\.com\/book/);
    expect(d.body).not.toMatch(/Hi (?:Hazel|Mochi|Juniper|Tank)\b/);
    expect(d.body).not.toMatch(/Hi Joan|Whitfield ·/);
    expect(d.body.match(/^Text to /gm)).toHaveLength(6);
    expect(d.body).toMatch(/#### Tank — Elm St\. Rescue · waits for Kayla's sign-off/);
    expect(d.body).not.toMatch(JUNK);
    const drafts = d.body.split("## Reminder texts")[1]!.split("## Needs your decision")[0]!;
    expect(drafts).not.toMatch(/surgery|dental/i);
  });
});

describe("first deliverable (held overnight) with the CSV on file", () => {
  const d = run("first_deliverable", first.title!, first.outputKind!, `${first.instructions}\n\nWhy: ${first.description}`);
  it("is the list Kayla asked for, not a format with example rows", () => {
    // Biscuit is overdue (true), but the never-contact rule means no draft: listed with a note, never texted.
    expect(tableRows(d.body)).toEqual(["Hazel", "Juniper", "Biscuit", "Tank", "Mochi", "Rocket", "Waffles"]);
    expect(d.body).toMatch(/\| Biscuit \|[^\n]*Do not contact \(your rule\) \|/);
    expect(d.body).not.toMatch(/Text to Joan|Hi Joan/);
    expect(d.body.match(/^Text to /gm)).toHaveLength(6);
    expect(d.body).not.toMatch(JUNK);
    expect(d.body).not.toMatch(/about your surgery or dental work/);
    expect(d.data?.substantive).toBe(true);
  });
});

describe("questions answered from the rows (chat / REST / MCP ask_agent)", () => {
  it("“Which patients are >100 days overdue?” → Hazel 125, Juniper 105", () => {
    const [a] = answerQuestion("Which patients are >100 days overdue?", knowledge, now);
    expect(a).toMatch(/^2 patients in overdue_patients\.csv are more than 100 days overdue: Hazel — 125 days \(Nora Patel\); Juniper — 105 days \(Alicia Moreno\)/);
    expect(a).not.toMatch(/Biscuit|Mochi/);
  });
  it("counts with a threshold", () => {
    expect(answerQuestion("How many patients are more than 90 days overdue?", knowledge, now)[0]).toMatch(/^3 patients/);
  });
  it("the offline model fetches the rest of a table that came back in pieces before answering", async () => {
    const req = {
      tier: "smart" as const,
      system,
      messages: [
        { role: "user" as const, content: "# Message\nKind: message\n---\nWhich patients are >100 days overdue?" },
        { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "knowledge_search", input: { query: "overdue patients" } }, { type: "tool_use" as const, id: "t2", name: "memory_recall", input: {} }] },
        {
          role: "user" as const,
          content: [
            { type: "tool_result" as const, tool_use_id: "t1", content: JSON.stringify({ results: [{ title: "overdue_patients.csv", content: knowledge[0]!.text }] }) },
            { type: "tool_result" as const, tool_use_id: "t2", content: JSON.stringify({ results: [] }) },
          ],
        },
      ],
      tools: [
        { name: "knowledge_search", description: "", input_schema: { type: "object" as const } },
        { name: "memory_recall", description: "", input_schema: { type: "object" as const } },
        { name: "create_deliverable", description: "", input_schema: { type: "object" as const } },
      ],
      maxTokens: 1000,
    };
    const r = await offlineProvider.chat(req);
    expect(r.toolCalls[0]?.name).toBe("knowledge_search");
    expect(String((r.toolCalls[0]?.input as { query: string }).query)).toMatch(/patient.*overdue|overdue.*patient/);
  });
});

describe("bulk drafts from a chat request", () => {
  it("one email per matching row, to the owner by name, never addressed from a chat request (the send path would refuse it)", () => {
    const d = run("message", "Reminders", "email_draft", "Write a reminder email to every owner whose pet is more than 90 days overdue");
    expect(tableRows(d.body)).toEqual(["Hazel", "Juniper", "Biscuit"]);
    expect(d.body.match(/^\*\*To:\*\* /gm)).toHaveLength(2); // Biscuit: never contact
    expect(d.body).toMatch(/^\*\*To:\*\* Nora Patel {2}$/m);
    expect(d.body).not.toMatch(/^\*\*To:\*\*.*@/m);
    expect(d.body).toMatch(/> Hi Nora,\n>\n> Hazel's rabies vaccine is overdue/);
    expect(d.body).not.toMatch(JUNK);
  });
  it("a workflow over the same file addresses each email from its row", () => {
    const d = run("workflow", "Overdue emails", "table", "Read overdue_patients.csv. Draft a reminder email for each owner more than 100 days overdue.");
    expect(d.body).toMatch(/^\*\*To:\*\* Nora Patel <nora\.patel@example\.com> {2}$/m);
    expect(d.body).toMatch(/^\*\*Subject:\*\* Hazel's rabies vaccine is overdue$/m);
  });
});

describe("drafts to a named person from the rows", () => {
  it("“reminder text to Tomás Herrera about Mochi” is a text to Tomás, not “Hi Mochi”", () => {
    const d = run("message", "Reminder", "document", "Draft a reminder text to Tomás Herrera about Mochi's rabies booster");
    expect(d.body).toMatch(/Text to Tomás Herrera · 555-0141/);
    expect(d.body).toMatch(/> Hi Tomás, this is Harborview Animal Hospital\. Mochi's rabies vaccine is overdue \(it was due Sep 14\)/);
    expect(d.body).not.toMatch(/Hi Mochi|Thanks for your note|species:/);
  });
  it("never drafts to a family a rule says never to contact", () => {
    const d = run("message", "Reminder", "document", "Draft a reminder text to Joan Whitfield about Biscuit");
    expect(d.body).not.toMatch(/^Text to|\*\*To:\*\*/m);
    expect(d.body).toMatch(/Never contact the Whitfield family/);
    expect(d.data?.substantive).toBe(false);
  });
});

describe("change requests apply the note", () => {
  const v1 = run("workflow", recalls.name, recalls.outputKind, recalls.instructions).body;
  const revise = (feedback: string, original = v1) =>
    run("revision", "Vaccine recalls (revised)", "table", `Revise the deliverable below. Feedback: ${feedback}\n\nOriginal (“Vaccine recalls”):\n${original}`);
  const changed = (body: string) => /^## What changed\n\n([^\n]+)/.exec(body)?.[1] ?? "";

  it("the critic's note on the placeholder turns it into the real list, Biscuit out", () => {
    const d = revise("Please turn this into the actual list: one row per overdue pet, most overdue first, with the owner's name and a reminder text that uses the pet's name. Leave Biscuit out completely.", oldRecalls);
    expect(tableRows(d.body)).toEqual(["Hazel", "Juniper", "Tank", "Mochi", "Rocket", "Pepper", "Waffles"]);
    expect(d.body.match(/^Text to /gm)).toHaveLength(7);
    expect(changed(d.body)).toMatch(/list from overdue_patients\.csv \(7 rows\)/);
    expect(d.body).not.toMatch(/Worked in your note|From the discovery call/);
  });
  it("removes named rows", () => {
    const d = revise("Remove Tank.");
    expect(tableRows(d.body)).toEqual(["Hazel", "Juniper", "Mochi", "Rocket", "Waffles"]);
    expect(changed(d.body)).toMatch(/6 → 5 rows/);
  });
  it("narrows with a new filter", () => {
    expect(tableRows(revise("Only rabies, please.").body)).toEqual(["Hazel", "Juniper", "Mochi", "Waffles"]);
  });
  it("fixes a named fact", () => {
    const d = revise("The booking link should be harborviewvet.example.com/vaccines");
    expect(d.body.split("## Summary")[1]).not.toMatch(/example\.com\/book\b/);
    expect(changed(d.body)).toMatch(/Replaced “harborviewvet\.example\.com\/book” with “harborviewvet\.example\.com\/vaccines” \(6 places\)/);
  });
  it("changes tone", () => {
    const d = revise("Make the texts more formal.");
    expect(d.body).toMatch(/> Dear Nora,/);
    expect(changed(d.body)).toMatch(/More formal tone/);
  });
  it("is honest about a note it can't apply", () => {
    const d = revise("Hmm, not sure about this one.");
    expect(changed(d.body)).toMatch(/^Nothing changed: I couldn't apply/);
    expect(d.data?.substantive).toBe(false);
  });
});

describe("text hygiene", () => {
  it("step lists don't split on abbreviations", () => {
    expect(stepsOf("Skip Biscuit and the Whitfield family entirely. Anything for Elm St. Rescue waits for Kayla's sign-off. Text Dr. Okafor last.")).toEqual([
      "Skip Biscuit and the Whitfield family entirely.",
      "Anything for Elm St. Rescue waits for Kayla's sign-off.",
      "Text Dr. Okafor last.",
    ]);
  });
  it("a placeholder (no data on file) is flagged as not substantive and drafts nothing about a forbidden topic", () => {
    const d = compose({ kind: "first_deliverable", title: first.title!, output: "document", body: `${first.instructions}\n\nWhy: ${first.description}`, system, knowledge: [], memories, now });
    expect(d.data?.substantive).toBe(false);
    expect(d.body).not.toMatch(/surgery or dental work\.? Could you|about your surgery/i);
    expect(d.body).not.toMatch(/Approve, edit or reject|Elm St:\s*$/m);
  });
});

// ───────────────────────────── end to end (roster_test): runtime + offline model + release now ─────────────────────────────

describe("end to end with the uploaded CSV", () => {
  beforeEach(resetDb);
  afterEach(() => setLlmProviderForTests(null));

  async function hireVet(hour = 12) {
    const orgs = await makeOrgs({ clientName: "Harborview Animal Hospital", industry: "Veterinary clinic", timezone: tzAtLocalHour(hour) });
    const spec = heuristicSpec({ transcript: readFileSync(join(__dirname, "fixtures/discovery-vet-harborview.md"), "utf8"), orgName: orgs.client.name });
    const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "user", userId: orgs.user.id } });
    return { ...orgs, agentId };
  }
  async function addCsv(orgId: string, agentId: string) {
    const { text } = await extractText("csv", "overdue_patients.csv", readFileSync(join(F, "overdue_patients.csv")));
    const [src] = await db().insert(schema.knowledgeSources).values({ orgId, agentId, title: "overdue_patients.csv", kind: "text", status: "pending" }).returning();
    const n = await indexText(db(), { orgId, sourceId: src!.id, text });
    return { sourceId: src!.id, chunks: n };
  }

  it("a chat question is answered from every row, even when the file is split across chunks", async () => {
    const { client, user, agentId } = await hireVet();
    await db().execute(sql`delete from jobs where org_id = ${client.id}`);
    const { chunks } = await addCsv(client.id, agentId);
    expect(chunks).toBeGreaterThanOrEqual(2);
    const r = await messageAgent({ orgId: client.id, agentId, channel: "api", text: "Which patients are >100 days overdue?", actor: { type: "user", userId: user.id }, wait: true });
    expect(r.reply).toMatch(/2 patients .*Hazel — 125 days.*Juniper — 105 days/);
    expect(r.reply).not.toMatch(/Biscuit|Last quarter/);
  });

  it("Release now rewrites the held first deliverable from files uploaded after hire, and credits hours only for real work", async () => {
    // Hired at 3 AM local: the setup run writes the draft now (no files yet) and holds it for 6 AM.
    const { client, agentId } = await hireVet(3);
    await runJobsOnce({ types: ["knowledge.index", "agent.run"], max: 5 });
    const held = await db().execute(sql`select payload from jobs where org_id = ${client.id} and type = 'deliverable.release' and status = 'queued'`);
    expect(held.rows).toHaveLength(1);
    const payload = (held.rows[0] as { payload: { runId: string; deliverable: { body: string } } }).payload;
    expect(payload.deliverable.body).not.toMatch(/\| Hazel \|/);
    // The file lands: its knowledge.index job completes and refreshes the held draft. Then Release now.
    const { text } = await extractText("csv", "overdue_patients.csv", readFileSync(join(F, "overdue_patients.csv")));
    const [src] = await db().insert(schema.knowledgeSources).values({ orgId: client.id, agentId, title: "overdue_patients.csv", kind: "text", status: "pending" }).returning();
    await enqueue(db(), "knowledge.index", { orgId: client.id, sourceId: src!.id, text }, { orgId: client.id });
    await runJobsOnce({ types: ["knowledge.index"] });
    const after = await db().execute(sql`select payload from jobs where org_id = ${client.id} and type = 'deliverable.release' and status = 'queued'`);
    expect((after.rows[0] as { payload: { deliverable: { body: string } } }).payload.deliverable.body).toMatch(/\| 1 \| Hazel \|/);
    const { deliverableId } = await releaseHeldDeliverable({ orgId: client.id, runId: payload.runId, actor: { type: "system" } });
    const [d] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.id, deliverableId));
    expect(d!.body).toMatch(/\| 1 \| Hazel \|/);
    expect(d!.body).not.toMatch(/Example A|\(example\)/);
    expect(d!.data).toMatchObject({ substantive: true });
    expect(d!.hoursSaved).toBeGreaterThan(0);
  });

  it("a held placeholder (still no data at release) is released with no hours credited", async () => {
    const { client } = await hireVet(3);
    await runJobsOnce({ types: ["knowledge.index", "agent.run"], max: 5 });
    const held = await db().execute(sql`select payload from jobs where org_id = ${client.id} and type = 'deliverable.release' and status = 'queued'`);
    const payload = (held.rows[0] as { payload: { runId: string } }).payload;
    const { deliverableId } = await releaseHeldDeliverable({ orgId: client.id, runId: payload.runId, actor: { type: "system" } });
    const [d] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.id, deliverableId));
    expect(d!.data).toMatchObject({ substantive: false });
    expect(d!.hoursSaved).toBe(0);
  });
});
