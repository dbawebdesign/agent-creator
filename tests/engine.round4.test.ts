/**
 * Regression tests for product critique r3 (round 4): named recipients only (C1), change requests never send (C2),
 * resale shares nothing by default (C3), no placeholder filler / proposals are documents (H6), approving an email draft
 * sends it and counts (M8), proposal edits reach the first deliverable, and dead-lettered runs are failed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import type { AgentSpec } from "@/server/agents/spec";
import { db, schema } from "@/server/db/client";
import { runJobsOnce } from "@/server/jobs/handlers";
import { DEAD_RUN_ERROR, failRunsOfDeadJobs } from "@/server/jobs/scheduler";
import { setLlmProviderForTests, type LlmProvider, type LlmResponse } from "@/server/llm";
import { compose, noPlaceholders } from "@/server/llm/offline/compose";
import { draftsIn, firstDeliverableInstructions, genericForResale, hireAgent, messageAgent, reviewDeliverable } from "@/server/services/engine";
import { makeOrgs, resetDb, tzAtLocalHour } from "./engine.helpers";

const PODCAST = readFileSync(path.join(__dirname, "fixtures", "podcast-ai-employees.md"), "utf8");
const SYSTEM = "You are Sage, Operations Assistant at BrightPath Commercial Cleaning. Keeps the sites happy.\n";
const CONTACTS = {
  title: "property-managers.csv",
  text:
    "Property,Property manager,Email,Last complaint\n" +
    "Westshore Plaza,Renee Calloway,renee@westshore.example,2026-10-20\n" +
    "Bayside Pediatrics,Lorna Fitch,lorna@baysidepeds.example,2026-10-29\n" +
    "Harbor Point,Dev Shah,dev@harborpoint.example,2026-10-11",
};
const INSPECTIONS = { title: "inspections.csv", text: "Site,Inspection score,Inspected\nWestshore Plaza,92,2026-10-27\nBayside Pediatrics,81,2026-10-28\nHarbor Point,88,2026-10-26" };
const RULE = "Approval rule from the call: “St. Luke's only via Greg Haines, ghaines@stlukesoutpatient.org — never send St. Luke's a price directly.”";

async function hire() {
  const orgs = await makeOrgs({ clientName: "BrightPath Commercial Cleaning", industry: "Commercial cleaning", timezone: tzAtLocalHour(12) });
  const spec = heuristicSpec({ transcript: PODCAST, orgName: orgs.client.name });
  const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "user", userId: orgs.user.id } });
  await db().execute(sql`delete from jobs where org_id = ${orgs.client.id}`);
  return { ...orgs, agentId, spec };
}

const U = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
function reply(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>, text = ""): LlmResponse {
  return {
    model: "roster-offline-1",
    stopReason: calls.length ? "tool_use" : "end_turn",
    text,
    toolCalls: calls,
    assistantContent: [...(text ? [{ type: "text" as const, text }] : []), ...calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input }))],
    usage: U,
  };
}
function scripted(first: Array<{ name: string; input: Record<string, unknown> }>): LlmProvider {
  return {
    id: "offline",
    async chat(req) {
      const done = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
      return done ? reply([], "Done.") : reply(first.map((c, i) => ({ id: `toolu_${i}`, ...c })));
    },
  };
}
afterEach(() => setLlmProviderForTests(null));

describe("C1: drafts go to the person the request names, and answer the question", () => {
  const ask = (body: string) => compose({ kind: "message", title: "Reply to Lorna", output: "email_draft", body, system: SYSTEM, knowledge: [CONTACTS, INSPECTIONS], memories: [] });

  it("drafts to Lorna Fitch at Bayside only, with Bayside's score from the data", () => {
    const d = ask("Draft a reply to Lorna Fitch at Bayside. She asked what Bayside's inspection score was last week.");
    expect(d.body).toContain("**To:** Lorna Fitch <lorna@baysidepeds.example>");
    expect(d.body).not.toMatch(/Renee|westshore|Dev Shah/i);
    expect(d.body).toMatch(/Inspection score: 81/);
    expect(d.body).toMatch(/> Hi Lorna,/);
    expect(d.body).not.toMatch(/Hi there|Our open item/);
  });

  it("names nobody it can find → no draft, and says what's missing", () => {
    const d = ask("Draft a reply to Tomas Ruiz at Lakeview Dental about Tuesday's visit.");
    expect(d.body).not.toContain("**To:**");
    expect(d.body).toMatch(/No email drafted/);
    expect(d.body).toMatch(/Tomas Ruiz/);
    expect(d.preview).toMatch(/no email drafted/i);
  });

  it("never addresses a draft from rule or memory text", () => {
    const d = compose({ kind: "message", title: "Quote", output: "email_draft", body: "Draft an email with the St. Luke's quote.", system: SYSTEM, knowledge: [], memories: [{ title: "memory", text: RULE, kind: "fact" }] });
    expect(d.body).not.toMatch(/\*\*To:\*\*|^> .*ghaines/m);
    expect(d.body).toMatch(/No email drafted/);
  });

  it("answers a chat question from the data", async () => {
    const { client, user, agentId } = await hire();
    const [src] = await db().insert(schema.knowledgeSources).values({ orgId: client.id, agentId, title: INSPECTIONS.title, kind: "file", status: "ready", chunkCount: 1 }).returning();
    await db().insert(schema.knowledgeChunks).values({ orgId: client.id, sourceId: src!.id, agentId, seq: 0, content: INSPECTIONS.text });
    const r = await messageAgent({ orgId: client.id, agentId, channel: "api", text: "What was Bayside Pediatrics' inspection score?", actor: { type: "user", userId: user.id }, wait: true });
    expect(r.reply).toMatch(/81/);
  });
});

describe("C2: change requests revise, never send; recipients never come from memory", () => {
  beforeEach(resetDb);

  it("a change request on a deliverable that mentions an address produces a linked new version and no outbound approval", async () => {
    const { client, user, agentId } = await hire();
    await db().insert(schema.memories).values({ orgId: client.id, agentId, kind: "fact", importance: 5, content: RULE });
    const [d] = await db()
      .insert(schema.deliverables)
      .values({ orgId: client.id, agentId, title: "St. Luke's bid", kind: "document", body: "## Bid\n\nRoute through ghaines@stlukesoutpatient.org. Send the price.", needsReview: true })
      .returning();
    await reviewDeliverable({ orgId: client.id, deliverableId: d!.id, action: "request_changes", feedback: "Private: our margin on St. Luke's is thin, bump the price 8% and email it.", actor: { type: "user", userId: user.id } });
    await runJobsOnce({ types: ["agent.run"], max: 5 });
    expect(await db().$count(schema.approvals, eq(schema.approvals.orgId, client.id))).toBe(0);
    const outbound = await db().select().from(schema.messages).where(and(eq(schema.messages.orgId, client.id), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(0);
    const versions = await db().select().from(schema.deliverables).where(sql`${schema.deliverables.data}->>'revisionOf' = ${d!.id}`);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.data).toMatchObject({ revisionOf: d!.id, previousVersionId: d!.id, version: 2 });
  });

  it("send_message to an address that only appears in memory is refused before any approval card", async () => {
    const { client, user, agentId } = await hire();
    await db().insert(schema.memories).values({ orgId: client.id, agentId, kind: "fact", importance: 5, content: RULE });
    setLlmProviderForTests(scripted([{ name: "send_message", input: { channel: "email", to: "ghaines@stlukesoutpatient.org", subject: "A price", text: "Here is our price." } }]));
    const r = await messageAgent({ orgId: client.id, agentId, channel: "api", text: "Follow up with St. Luke's about the bid.", actor: { type: "user", userId: user.id }, wait: true });
    expect(await db().$count(schema.approvals, eq(schema.approvals.orgId, client.id))).toBe(0);
    const step = await db().execute(sql`select data from run_steps where run_id = ${r.runId} and kind = 'tool_result' and name = 'send_message'`);
    expect(JSON.stringify(step.rows[0])).toMatch(/Recipients never come from memory/);
  });

  it("an address written in the request is allowed (it waits for approval as usual)", async () => {
    const { client, user, agentId } = await hire();
    setLlmProviderForTests(scripted([{ name: "send_message", input: { channel: "email", to: "lorna@baysidepeds.example", subject: "Thanks", text: "Thanks for the note." } }]));
    await messageAgent({ orgId: client.id, agentId, channel: "api", text: "Email lorna@baysidepeds.example to say thanks.", actor: { type: "user", userId: user.id }, wait: true });
    expect(await db().$count(schema.approvals, eq(schema.approvals.orgId, client.id))).toBe(1);
  });
});

describe("C3: resale carries the job, not the reseller's business", () => {
  it("strips the reseller's people, rules and call quotes; resets the first deliverable", () => {
    const spec = heuristicSpec({ transcript: PODCAST, orgName: "Summit Promo Co" });
    const dirty: AgentSpec = {
      ...spec,
      instructions: `${spec.instructions}\n\n## Rules from the call\n- “Never send a price without Marisol's OK.”\n- People: Marisol (owner); Tavo (ops lead).`,
      workflows: spec.workflows.map((w) => ({ ...w, instructions: `${w.instructions}\n9. Hard rules from the call, in every draft: “St. Luke's only via Greg Haines.”\n10. Check with Marisol before sending.` })),
    };
    const g = genericForResale(dirty, ["Marisol Vega", "Tavo Reyes", "Greg Haines"], spec.name);
    const all = JSON.stringify(g);
    expect(all).not.toMatch(/Marisol|Tavo|Greg Haines|St\. Luke/);
    expect(g.instructions).toMatch(/## Rules\n- Nothing leaves the business/);
    expect(g.workflows[0]!.instructions).toMatch(/Check with the team before sending/);
    expect(g.seedMemories).toEqual([]);
    expect(g.firstDeliverable.title).toBe(`Your first week with ${spec.name}`);
  });
});

describe("H6: no filler", () => {
  it("never leaves literal placeholders", () => {
    expect(noPlaceholders("> Hi {customer first name},\n> Total: {price} for {period}.")).toBe("> Hello,\n> Total: — for this period.");
  });

  it("a proposal workflow produces a proposal document priced from the rate guide, not an email", () => {
    const rates = { title: "rate-guide.csv", text: "Service,Rate,Unit\nNightly office cleaning,0.12,per sq ft\nFloor care,0.35,per sq ft\nDay porter,38,per hour" };
    const d = compose({
      kind: "workflow",
      title: "Bid proposal drafts",
      output: "email_draft",
      body: "1. Draft a bid proposal for each new walk-through: scope, pricing from the rate guide, and terms.\n2. Request approval before anything goes to the prospect.",
      system: SYSTEM,
      knowledge: [rates],
      memories: [],
    });
    expect(d.kind).toBe("document");
    expect(d.body).toMatch(/### Scope of work/);
    expect(d.body).toMatch(/\| Nightly office cleaning \| 0\.12 \| per sq ft \|/);
    expect(d.body).toMatch(/### Terms/);
    expect(d.body).not.toMatch(/\*\*To:\*\*|\{[^}]+\}/);
  });
});

describe("M8: approving an email draft sends it and counts", () => {
  beforeEach(resetDb);

  it("queues one email per addressed draft, once, and credits hours", async () => {
    const { client, user, agentId } = await hire();
    const body =
      "## The work\n\n### To Lorna Fitch\n\n**To:** Lorna Fitch <lorna@baysidepeds.example>  \n**Subject:** Re: Bayside Pediatrics\n\n> Hi Lorna,\n>\n> Your score was 81.\n\n### No address\n\n**To:** Someone  \n**Subject:** x\n\n> Hi,";
    expect(draftsIn(body)).toEqual([{ to: "lorna@baysidepeds.example", name: "Lorna Fitch", subject: "Re: Bayside Pediatrics", body: "Hi Lorna,\n\nYour score was 81." }]);
    const [d] = await db().insert(schema.deliverables).values({ orgId: client.id, agentId, title: "Reply to Lorna", kind: "email_draft", body, needsReview: true }).returning();
    await reviewDeliverable({ orgId: client.id, deliverableId: d!.id, action: "approve", actor: { type: "user", userId: user.id } });
    await reviewDeliverable({ orgId: client.id, deliverableId: d!.id, action: "approve", actor: { type: "user", userId: user.id } });
    const msgs = await db().select().from(schema.messages).where(and(eq(schema.messages.orgId, client.id), eq(schema.messages.direction, "outbound")));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.meta).toMatchObject({ to: "lorna@baysidepeds.example", approvedDeliverableId: d!.id });
    const jobs = await db().execute(sql`select payload from jobs where type = 'channel.deliver' and org_id = ${client.id}`);
    expect(jobs.rows).toHaveLength(1);
    expect((jobs.rows[0] as { payload: Record<string, unknown> }).payload).toMatchObject({ channel: "email", messageId: msgs[0]!.id, to: "lorna@baysidepeds.example" });
    const [after] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.id, d!.id));
    expect(after!.hoursSaved).toBeGreaterThan(0);
  });
});

describe("M8/C2: an approved draft that quotes a private note is held, not sent", () => {
  beforeEach(resetDb);

  it("holds it and records why", async () => {
    const { client, user, agentId } = await hire();
    const note = "Private: our margin on St. Luke's is thin, bump the price 8% before it goes out.";
    await db().insert(schema.deliverables).values({ orgId: client.id, agentId, title: "Old", kind: "document", body: "x", feedback: note });
    const body = `**To:** Greg Haines <ghaines@stlukesoutpatient.org>  \n**Subject:** Price\n\n> Hi Greg,\n>\n> ${note}`;
    const [d] = await db().insert(schema.deliverables).values({ orgId: client.id, agentId, title: "Price", kind: "email_draft", body, needsReview: true }).returning();
    await reviewDeliverable({ orgId: client.id, deliverableId: d!.id, action: "approve", actor: { type: "user", userId: user.id } });
    expect(await db().$count(schema.messages, and(eq(schema.messages.orgId, client.id), eq(schema.messages.direction, "outbound")))).toBe(0);
    const [after] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.id, d!.id));
    expect(after!.data).toMatchObject({ heldDrafts: [{ to: "ghaines@stlukesoutpatient.org" }] });
  });
});

describe("hire: proposal edits reach the first deliverable", () => {
  it("rebuilds tonight's brief from the edited title and the matching workflow", () => {
    const spec = heuristicSpec({ transcript: PODCAST, orgName: "Summit Promo Co" });
    const wf = { ...spec.workflows[0]!, name: "Monday property-manager reports", instructions: "1. Pull last week's visits and complaints per site.\n2. Write one report per property manager." };
    const edited: AgentSpec = { ...spec, workflows: [wf, ...spec.workflows.slice(1)], firstDeliverable: { ...spec.firstDeliverable, title: "Monday property-manager reports + complaint heads-up", description: "This week's reports, ready to send." } };
    const brief = firstDeliverableInstructions(edited);
    expect(brief).toMatch(/^Produce “Monday property-manager reports \+ complaint heads-up” tonight/);
    expect(brief).toContain("Write one report per property manager.");
  });
});

describe("dead-lettered runs", () => {
  beforeEach(resetDb);

  it("a run whose agent.run job is dead is failed with a client-safe error (once)", async () => {
    const { client, agentId } = await hire();
    const [run] = await db().insert(schema.runs).values({ orgId: client.id, agentId, trigger: "manual", status: "running", input: { kind: "task", title: "x" } }).returning();
    await db().insert(schema.jobs).values({ type: "agent.run", orgId: client.id, payload: { orgId: client.id, runId: run!.id }, status: "dead", attempts: 5, maxAttempts: 5, finishedAt: new Date() });
    expect(await failRunsOfDeadJobs(db())).toBe(1);
    const [after] = await db().select().from(schema.runs).where(eq(schema.runs.id, run!.id));
    expect(after).toMatchObject({ status: "failed", error: DEAD_RUN_ERROR });
    expect(await failRunsOfDeadJobs(db())).toBe(0);
  });
});
