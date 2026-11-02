/**
 * The Architect — "the agent that builds agents".
 *
 * Input: a discovery-call transcript (+ client org name/industry). Output: a validated `AgentSpec`.
 *
 * - With ANTHROPIC_API_KEY: one structured-output call (JSON schema from the zod spec) with a strong system prompt,
 *   validated with zod and repaired once on failure.
 * - Offline: a deterministic reader (`@/server/llm/offline/discovery`) segments the call, scores the sentences that
 *   describe pain (time costs, money at stake, manual work), groups them into one topic per task, and assembles a
 *   spec from those topics with this business's own systems, people, rules and schedules. It is labelled as an
 *   offline draft in `openQuestions`.
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { isOfflineModel } from "@/server/env";
import { anthropicStructured } from "@/server/llm/anthropic";
import { OFFLINE_MODEL } from "@/server/llm/offline";
import { hoursPerWeekIn, moneyIn, quoteOf, readDiscovery, type Action, type Cadence, type Discovery, type Topic } from "@/server/llm/offline/discovery";
import { hash32, normalizeWhitespace, truncate } from "@/server/llm/text";
import type { LlmUsage } from "@/server/llm/types";
import { agentSpec, type AgentSpec, type WorkflowSpec } from "./spec";

export type ArchitectInput = { transcript: string; orgName?: string | null; industry?: string | null };
export type ArchitectResult = { spec: AgentSpec; model: string; usage: LlmUsage };

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const MAX_TRANSCRIPT_CHARS = 400_000;

export async function architect(input: ArchitectInput): Promise<ArchitectResult> {
  const transcript = input.transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  if (normalizeWhitespace(transcript).length < 40) throw new Error("Transcript is too short to design an agent from");
  if (isOfflineModel()) return { spec: heuristicSpec({ ...input, transcript }), model: OFFLINE_MODEL, usage: ZERO_USAGE };
  return modelSpec({ ...input, transcript });
}

// ───────────────────────────────────────────── real model ─────────────────────────────────────────────

export const ARCHITECT_SYSTEM = `You are the Architect at an AI-employee agency. You read a discovery call with a business owner and design ONE vertical AI employee that will be live within 24 hours and earn a flat $5,000/month by doing real, recurring work.

How to design:
1. Find the owner's "itch": the boring, repetitive work someone does by hand for hours every week (quotes, data entry between systems, catalog/price updates, invoices, follow-ups, reports, inbox triage). Quote their numbers (hours/week, $ per job). Ignore generic advice or small talk that is not about this business's operations.
2. Turn each itch into a workflow: a concrete numbered procedure the agent can follow with its tools (knowledge_search, memory_recall, memory_save, create_deliverable, send_message, request_approval, http_fetch, schedule_followup, computer_* for clicking through web apps). Each workflow has a trigger: a 5-field cron schedule in the client's local time (e.g. "0 6 * * 1-5"), or an event (email.received, sms.received, slack.message, webhook, deliverable.approved), or manual. Give the output kind, delivery channels and realistic hours saved per run.
3. Proactive beats copilot: the agent delivers finished work (reports, documents, GFM tables, email drafts) without being asked. Pick a first OVERNIGHT deliverable the agent can produce tonight from the call transcript and public information alone, that will make the owner say "wow" the first morning. Make its instructions specific and self-contained.
4. Seed memories with concrete facts from the call (names, tools, prices, volumes, preferences, who approves what). Knowledge needs: the documents to request (catalogs, price lists, templates, SOPs) and why.
5. Risky actions (sending external email, sending invoices, spending money, changing records in client systems) must be listed in requireApprovalFor.
6. Resale (B2B2B): how this client could package the agent for THEIR customers as a new revenue stream.
7. Open questions: what the agency must confirm before go-live.
Write instructions as a job description in second person. Be specific to this business; never generic filler. Name: a short human first name. Voice: how it should sound to this owner.`;

async function modelSpec(input: ArchitectInput): Promise<ArchitectResult> {
  const format = zodOutputFormat(agentSpec);
  const user = [
    `Client: ${input.orgName ?? "(unknown)"}${input.industry ? ` — industry: ${input.industry}` : ""}`,
    "",
    "<transcript>",
    input.transcript,
    "</transcript>",
    "",
    "Design the AI employee. Return only the JSON object.",
  ].join("\n");
  const usage = { ...ZERO_USAGE };
  const add = (u: LlmUsage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
  };
  let lastError = "";
  let model = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await anthropicStructured({
      tier: "smart",
      system: ARCHITECT_SYSTEM,
      user: attempt === 0 ? user : `${user}\n\nYour previous output failed validation: ${lastError}\nFix it and return the full JSON object.`,
      schema: format.schema as Record<string, unknown>,
      maxTokens: 32_000,
    });
    add(res.usage);
    model = res.model;
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      lastError = "output was not valid JSON";
      continue;
    }
    const parsed = agentSpec.safeParse(clampSpecShape(json));
    if (parsed.success) return { spec: finalizeSpec(parsed.data), model, usage };
    lastError = z.prettifyError(parsed.error).slice(0, 2000);
  }
  // The model could not produce a valid spec twice: fall back to the deterministic extractor, flagged for review.
  const spec = heuristicSpec(input);
  spec.openQuestions = [
    "This proposal was drafted by the offline extractor because the model output failed validation — review closely.",
    ...spec.openQuestions,
  ].slice(0, 10);
  return { spec, model, usage };
}

/** Best-effort trimming of over-long strings/arrays from model output before zod validation. */
function clampSpecShape(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const clip = (v: unknown, n: number) => (typeof v === "string" ? truncate(v, n) : v);
  o.name = clip(o.name, 40);
  o.role = clip(o.role, 80);
  o.summary = clip(o.summary, 280);
  o.vertical = clip(o.vertical, 80);
  o.voice = clip(o.voice, 400);
  o.resaleIdea = clip(o.resaleIdea, 600);
  if (Array.isArray(o.workflows)) o.workflows = o.workflows.slice(0, 12);
  if (Array.isArray(o.seedMemories)) o.seedMemories = o.seedMemories.slice(0, 40).map((m) => clip(m, 500));
  if (Array.isArray(o.openQuestions)) o.openQuestions = o.openQuestions.slice(0, 10).map((m) => clip(m, 300));
  if (Array.isArray(o.knowledgeNeeds)) o.knowledgeNeeds = o.knowledgeNeeds.slice(0, 20);
  return o;
}

/** Normalize a validated spec: always-on core tools, approval defaults, weekly hours. */
export function finalizeSpec(spec: AgentSpec): AgentSpec {
  const core = ["knowledge_search", "memory_recall", "memory_save", "create_deliverable", "send_message", "request_approval", "schedule_followup"];
  const tools = [...new Set([...core, ...spec.tools, ...spec.workflows.flatMap((w) => w.tools)])];
  const channels = [...new Set(["portal" as const, ...spec.channels])];
  const usesComputer = tools.some((t) => /^computer_/.test(t));
  const requireApprovalFor = [...new Set(["send_external_email", "send_external_sms", ...(usesComputer ? ["write_client_system"] : []), ...spec.requireApprovalFor])];
  const weekly =
    spec.weeklyHoursSaved > 0
      ? spec.weeklyHoursSaved
      : Math.round(spec.workflows.reduce((n, w) => n + w.hoursSavedPerRun * runsPerWeek(w.trigger), 0) * 10) / 10;
  return agentSpec.parse({ ...spec, tools, channels, requireApprovalFor, weeklyHoursSaved: Math.min(400, weekly) });
}

// ───────────────────────────────────────────── heuristic extractor ─────────────────────────────────────────────
//
// Offline, the Architect designs from what the owner actually said: `readDiscovery` segments the call and groups the
// sentences that describe pain into topics (one per task, with its hours, dollars, systems, people, rules and
// cadence). Each topic becomes a workflow through a playbook for its kind of work (checking, chasing, reporting,
// triage, deadlines, paperwork, closing the books…), filled in with this business's own systems, people and rules.
// Industry templates are only light enrichment, and only when the business type is clear from the client's own
// description — never from words said in passing.

type Vertical = { id: string; label: string; re: RegExp; customers: string };

const VERTICALS: Vertical[] = [
  { id: "promo", label: "Promotional products distribution", re: /promotional products?|promo products?|\bswag\b|branded merch\w*|distributorship/gi, customers: "corporate buyers" },
  { id: "insurance", label: "Insurance", re: /insurance agenc\w*|insurance software|agency management software|\bpolic(?:y|ies)holders?\b|\binsureds?\b|\bcarriers?\b|premiums?/gi, customers: "agencies and policyholders" },
  { id: "design", label: "Design & branding agency", re: /design agency|brand assets|branding|graphic design/gi, customers: "brand clients" },
  { id: "legal", label: "Legal services", re: /law firm|attorneys?|lawyers?|paralegals?|case files?/gi, customers: "clients" },
  { id: "dental", label: "Dental practice", re: /dental|dentists?|hygienists?|patients?|orthodont\w*/gi, customers: "patients" },
  { id: "medical", label: "Medical practice", re: /clinic|physicians?|med ?spa|chiropract\w*|physical therap\w*/gi, customers: "patients" },
  { id: "home", label: "Home services (HVAC, plumbing, electrical)", re: /\bhvac\b|plumbing (?:company|contractor|business)|furnaces?|air condition\w*|heating (?:and|&) air|technicians?/gi, customers: "homeowners" },
  { id: "roofing", label: "Roofing & exteriors contractor", re: /roof\w*|gutters?|siding|storm damage|hail/gi, customers: "homeowners" },
  { id: "realestate", label: "Property management", re: /property manage\w*|\btenants?\b|\bunits\b|multifamily|leases?\b|landlords?/gi, customers: "owners and tenants" },
  { id: "accounting", label: "Accounting & bookkeeping", re: /bookkeep\w*|accounting firm|\bcpa\b|month[- ]end close|tax returns?|\bclients'? books\b/gi, customers: "small-business clients" },
  { id: "ecommerce", label: "E-commerce", re: /shopify|e-?commerce|online store|\bskus?\b/gi, customers: "shoppers" },
  { id: "restaurant", label: "Restaurants & hospitality", re: /restaurants?|menus?|reservations?|catering/gi, customers: "guests" },
  { id: "marketing", label: "Marketing agency", re: /marketing agency|\bseo\b|ad campaigns?|social media management/gi, customers: "brands" },
  { id: "recruiting", label: "Recruiting & staffing", re: /recruit\w*|candidates?|staffing|job postings?/gi, customers: "hiring managers" },
  { id: "construction", label: "Construction & contracting", re: /construction|general contractor|subcontractors?|takeoffs?/gi, customers: "project owners" },
];

const NAMES = ["Maya", "Quinn", "Theo", "Iris", "Jonah", "Nora", "Eli", "Ava", "Rhea", "Milo", "Tess", "Owen", "Lena", "Sage"];

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  return (s.match(re) ?? []).length;
}

function detectVerticals(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of VERTICALS) {
    const n = countMatches(v.re, text);
    if (n) m.set(v.id, n);
  }
  return m;
}

/** The business type, from the client's industry field or how the owner describes the business — not incidental words. */
function pickVertical(industry: string | null | undefined, description: string): Vertical | null {
  for (const src of [industry ?? "", description]) {
    if (!src.trim()) continue;
    const hit = VERTICALS.map((v) => ({ v, n: countMatches(v.re, src) + (src.toLowerCase().includes(v.label.toLowerCase().split(/[ &(]/)[0] ?? "\u0000") ? 1 : 0) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)[0];
    if (hit) return hit.v;
  }
  return null;
}

export function runsPerWeek(trigger: WorkflowSpec["trigger"]): number {
  if (trigger.type === "manual") return 1;
  if (trigger.type === "event") return 10;
  const parts = trigger.cron.trim().split(/\s+/);
  const [, hours = "0", dom = "*", , dow = "*"] = parts;
  const perDay = hours.includes(",") ? hours.split(",").length : 1;
  if (dom !== "*") return Math.round((dom.split(",").length / 4.33) * 100) / 100;
  if (dow === "*") return 7 * perDay;
  if (/^\d-\d$/.test(dow)) {
    const [a, b] = dow.split("-").map(Number) as [number, number];
    return (b - a + 1) * perDay;
  }
  return dow.split(",").length * perDay;
}

// ── helpers ──

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (s: string) => (/s$/.test(s) ? s : /y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const singular = (s: string) => s.replace(/ies$/, "y").replace(/(?<!s)s$/, "");
const listJoin = (xs: string[], conj = "and") => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${conj} ${xs[xs.length - 1]}`);
const fmtMoney = (n: number) => `$${n >= 10_000 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US")}`;
const fmtHours = (h: number) => `${Math.round(h * 10) / 10} hours a week`;
const DOW = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const clock = (h: number, m: number) => `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;

/** Systems that hold records (not the portals/carriers the agent checks against). */
const RECORD_SYSTEMS = /^(?:Dentrix|Eaglesoft|Open Dental|AppFolio|Buildium|Yardi|Rent Manager|QuickBooks(?: Online)?|Xero|NetSuite|Sage Intacct|FreshBooks|ServiceTitan|Housecall Pro|Jobber|Applied Epic|EZLynx|HawkSoft|Clio|Salesforce|HubSpot|AccuLynx|JobNimbus|Procore|Buildertrend|Karbon|TaxDome|Canopy|Shopify|Airtable|Google Sheets|Excel|commonsku|ESP|SAGE)$/;
const MESSAGING_SYSTEMS = /^(?:Weave|Podium|Outlook|Gmail|Slack|Teams)$/;

type Ctx = {
  org: string;
  d: Discovery;
  vertical: Vertical | null;
  ownerFirst: string;
  /** Who reviews before anything goes out ("Rosa or Priya"). */
  approver: string;
};

const recordSystem = (t: Topic, ctx: Ctx) => t.systems.find((s) => RECORD_SYSTEMS.test(s)) ?? ctx.d.systems.find((s) => RECORD_SYSTEMS.test(s)) ?? null;
const checkSources = (t: Topic) => t.systems.filter((s) => !RECORD_SYSTEMS.test(s) && !MESSAGING_SYSTEMS.test(s));
const doerOf = (t: Topic, ctx: Ctx) => t.people.find((p) => p !== ctx.d.owner && !p.startsWith("Dr.")) ?? ctx.d.owner ?? "the owner";
const messagingTool = (ctx: Ctx) => ctx.d.systems.find((s) => /^(?:Weave|Podium)$/.test(s)) ?? null;
const audienceOf = (t: Topic, ctx: Ctx): string => {
  const txt = t.sentences.map((s) => s.text).join(" ").toLowerCase();
  const m = /\b(?:each|every|all|our|the|those) (owner|client|customer|patient|tenant|homeowner|member|insured|buyer|adjuster)s?\b/.exec(txt) ?? /\b(owners|clients|customers|patients|tenants|homeowners|members|buyers)\b/.exec(txt);
  return m ? singular(m[1]!) : singular(ctx.vertical?.customers.split(" ")[0] ?? "customer");
};
/** Text channel for a topic's outreach: texts when the call says this audience prefers them. */
const prefersText = (t: Topic, ctx: Ctx) => {
  const aud = audienceOf(t, ctx);
  const prefs = ctx.d.sentences.map((s) => s.text).join(" ");
  return new RegExp(`\\b${aud}s?,? (?:prefer )?texts?\\b|\\btexts?, definitely\\b|\\balways text (?:${aud}s?|customers)\\b`, "i").test(prefs);
};
const rulesFor = (t: Topic, ctx: Ctx) => [...new Set([...t.rules, ...ctx.d.rules])].map((r) => quoteOf(r, 200));

function cronFor(t: Topic, ctx: Ctx, fallback: Cadence): WorkflowSpec["trigger"] {
  const c = t.cadence ?? fallback;
  if (c.kind === "event") return { type: "event", event: c.channel === "sms" ? "sms.received" : "email.received" };
  if (c.kind === "monthly") return { type: "schedule", cron: `0 6 ${c.day} * *`, label: `Monthly on the ${ordinal(c.day)} at 6:00 AM` };
  if (c.kind === "weekly") return { type: "schedule", cron: `0 7 * * ${c.dow}`, label: `${DOW[c.dow]} at 7:00 AM` };
  // Daily: land before the recipient starts their day ("Rosa gets in at 7:15" → 6:30).
  const by = ctx.d.recipient.by;
  let mins = by ? by.h * 60 + by.m - 45 : 6 * 60;
  mins = Math.max(5 * 60, Math.min(8 * 60, Math.round(mins / 15) * 15));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const days = c.days;
  return { type: "schedule", cron: `${m} ${h} * * ${days}`, label: `${days === "1-6" ? "Mon–Sat" : days === "*" ? "Every day" : "Weekdays"} at ${clock(h, m)}` };
}

type Play = {
  role: (t: Topic, ctx: Ctx) => string;
  name: (t: Topic, ctx: Ctx) => string;
  cadence: Cadence;
  outputKind: (t: Topic, ctx: Ctx) => WorkflowSpec["outputKind"];
  tools: string[];
  /** Works inside the client's systems through the computer (gated by write_client_system). */
  computer?: boolean;
  defaultHours: number;
  steps: (t: Topic, ctx: Ctx) => string[];
  knowledge: (t: Topic, ctx: Ctx) => Array<{ title: string; why: string }>;
  questions: (t: Topic, ctx: Ctx) => string[];
  overnight: (t: Topic, ctx: Ctx) => { title: string; description: string; instructions: string };
  resale: (t: Topic, ctx: Ctx) => string;
  verb: (t: Topic, ctx: Ctx) => string;
};

const approvalStep = (t: Topic, ctx: Ctx, what: string) => {
  const rules = rulesFor(t, ctx);
  return `Request approval from ${ctx.approver} before ${what}${rules[0] ? ` (on the call: “${truncate(rules[0], 150)}”)` : ""}.`;
};

const BASE = ["knowledge_search", "memory_recall", "memory_save", "create_deliverable"];
const COMPUTER = ["computer_screenshot", "computer_click", "computer_type", "computer_key"];

const PLAYS: Record<Action, Play> = {
  verify: {
    role: (t) => `${cap(t.qualifier || "Insurance")} Verification Coordinator`,
    name: (t) => `${cap(t.qualifier || singular(t.phrase.replace(/\s*verif\w*/, "")) || "Insurance")} verification${/tomorrow/i.test(t.sentences.map((s) => s.text).join(" ")) ? " for tomorrow's schedule" : ""}`,
    cadence: { kind: "daily", days: "1-5" },
    outputKind: () => "table",
    tools: [...BASE, ...COMPUTER, "send_message", "request_approval"],
    computer: true,
    defaultHours: 5,
    steps: (t, ctx) => {
      const rec = recordSystem(t, ctx);
      const src = checkSources(t);
      const who = doerOf(t, ctx);
      const aud = audienceOf(t, ctx);
      const items = t.items.length ? t.items : ["coverage status", "remaining benefits", "deductible", "limits that affect the planned visit"];
      return [
        `Pull tomorrow's ${aud} schedule from ${rec ?? "the scheduling system"} (read-only), with each ${aud}'s ${t.qualifier || "insurance"} carrier and planned procedure.`,
        `For each ${aud}, check ${t.qualifier === "insurance" || !t.qualifier ? "eligibility and benefits" : t.phrase} on the carrier's portal${src.length ? ` (${listJoin(src.slice(0, 5))})` : ""} and capture: ${listJoin(items)}.`,
        `Flag every problem before the visit: inactive coverage, out of network, a frequency limit the planned procedure would exceed, or an estimated ${aud} balance${t.moneyText ? ` — the call put the cost of misses at ${t.money ? fmtMoney(t.money) : "real money"}: “${quoteOf(t.moneyText, 140)}”` : ""}.`,
        `Write the verified benefits into ${rec ? `the ${aud} notes in ${rec}` : "the record system"}; this changes a client system, so it waits for approval until ${who} says otherwise.`,
        `Deliver the verification sheet as a GFM table (${aud}, appointment time, carrier, status, remaining max, deductible, frequency flags, estimated ${aud} portion, action) to ${ctx.d.recipient.name ?? who}${ctx.d.recipient.by ? ` before ${clock(ctx.d.recipient.by.h, ctx.d.recipient.by.m)}` : " first thing"}, with problems at the top.`,
        `For each flagged ${aud}, draft the day-before ${prefersText(t, ctx) ? `text${messagingTool(ctx) ? ` (sent through ${messagingTool(ctx)})` : ""}` : "call script"} explaining what they will likely owe, or offering to reschedule.`,
        approvalStep(t, ctx, `any message reaches a ${aud}`),
      ];
    },
    knowledge: (t, ctx) => [
      { title: `Carrier portal logins (${listJoin(checkSources(t).slice(0, 4)) || "each payer"})`, why: "The agent checks eligibility and benefits on each portal." },
      { title: `Read access to ${recordSystem(t, ctx) ?? "the schedule"}`, why: "Tomorrow's schedule and where verified benefits get written." },
      { title: "Fee schedule / typical procedure codes", why: "Needed to estimate what the patient will owe." },
    ],
    questions: (t, ctx) => [
      `Which carriers make up most of the schedule, and can we get a portal login for each (${listJoin(checkSources(t).slice(0, 4)) || "Delta Dental, MetLife…"})?`,
      `May the agent write verified benefits into ${recordSystem(t, ctx) ?? "the record system"} directly, or should ${doerOf(t, ctx)} paste them in for the first weeks?`,
    ],
    overnight: (t, ctx) => {
      const who = ctx.d.recipient.name ?? doerOf(t, ctx);
      return {
        title: `${cap(t.qualifier || "Insurance")} verification sheet for ${who}, ready for tomorrow's schedule`,
        description: `Tonight ${ctx.org}'s new verification coordinator builds the morning sheet ${who} asked for — format, per-carrier checklist and the patient call script — so the ${t.hoursPerWeek ? `~${fmtHours(t.hoursPerWeek)}` : "hours"} of portal checks start shrinking on day one.`,
        instructions: [
          "Using the discovery call in the knowledge base and what you remember about this practice:",
          `1. Build the verification sheet ${who} will get every morning as a GFM table with these columns: patient, appointment time, carrier, status, ${listJoin(t.items.length ? t.items : ["remaining max", "deductible", "frequency limits", "network status"])}, estimated patient portion, action. Fill two example rows marked "example".`,
          `2. Write a one-page checklist per carrier${checkSources(t).length ? ` (${listJoin(checkSources(t).slice(0, 5))})` : ""}: where to look, what to capture, what counts as a problem.`,
          "3. Draft the day-before message for a patient who will owe money, and one for a patient who should reschedule — warm, plain, no jargon.",
          `4. List exactly what access you need (portal logins, read access to ${recordSystem(t, ctx) ?? "the schedule"}) to run the real sheet tomorrow night, and what needs a decision (who approves patient messages, compliance).`,
        ].join("\n"),
      };
    },
    resale: (_t, ctx) => `Offer the verification desk to other practices ${ctx.org} knows (study clubs, referral partners) as a monthly service — every practice has the same portal grind.`,
    verb: (t) => `verifies ${t.qualifier || "insurance"} before every visit`,
  },
  chase: {
    role: (t, ctx) => `${cap(audienceOf(t, ctx))} Follow-up Coordinator`,
    name: (t) => `${cap(normalizeObject(t.phrase))} follow-up`,
    cadence: { kind: "weekly", dow: 1 },
    outputKind: () => "email_draft",
    tools: [...BASE, "send_message", "request_approval", "schedule_followup"],
    defaultHours: 3,
    steps: (t, ctx) => {
      const rec = recordSystem(t, ctx);
      const aud = audienceOf(t, ctx);
      const txt = prefersText(t, ctx);
      const via = txt ? `text${messagingTool(ctx) ? ` (through ${messagingTool(ctx)})` : ""}` : "email";
      return [
        `Pull the list of ${normalizeObject(t.phrase)} from ${rec ? `${rec}${/report/i.test(t.sentences.map((s) => s.text).join(" ")) ? " (the report the team already runs)" : ""}` : "the knowledge base and memory"}: ${aud}, what is open, value, and last contact.`,
        `Prioritize by value and age${t.money ? ` — about ${fmtMoney(t.money)} sits in this list today, so start with the largest items` : ""}; skip anyone contacted in the last 7 days.`,
        `Draft one short, personal ${via} per ${aud} that names exactly what is open and makes the next step easy (book a time, send the document, reply yes).`,
        approvalStep(t, ctx, `anything goes to a ${aud}`),
        `Schedule a second touch 4 days later for anyone who has not replied; stop after three touches and list them for a personal call.`,
        `Deliver the queue as one document: a GFM table (${aud}, what is open, value, last contact, drafted message, next step) with the drafts below it; save replies and outcomes to memory.`,
      ];
    },
    knowledge: (t, ctx) => [{ title: `Export of open ${normalizeObject(t.phrase)}${recordSystem(t, ctx) ? ` from ${recordSystem(t, ctx)}` : ""}`, why: "The follow-up queue is built from it." }],
    questions: (t, ctx) => [`How many touches should a ${audienceOf(t, ctx)} get before we stop, and from whose name and number should messages go?`],
    overnight: (t, ctx) => ({
      title: `${cap(normalizeObject(t.phrase))}: follow-up queue and message drafts`,
      description: `Every open item ${ctx.org} mentioned, prioritized by value, with a message ready to approve${t.money ? ` — about ${fmtMoney(t.money)} is waiting in this list` : ""}.`,
      instructions: [
        "Using the discovery call and memory:",
        `1. Lay out the follow-up queue as a GFM table (${audienceOf(t, ctx)}, what is open, value, last contact, next step) — fill it from anything the call or knowledge base names; mark rows "example" where you have no data yet.`,
        `2. Draft three ${prefersText(t, ctx) ? "texts" : "emails"} in ${ctx.ownerFirst}'s voice: first touch, second touch, last touch.`,
        `3. Say exactly which export you need to fill the real queue next run, and what needs a decision (who approves, how many touches).`,
      ].join("\n"),
    }),
    resale: (t, ctx) => `Package the ${normalizeObject(t.phrase)} follow-up as a done-for-you service ${ctx.org} can offer peers in the same trade.`,
    verb: (t) => `follows up on ${normalizeObject(t.phrase)}`,
  },
  report: {
    role: () => "Reporting Analyst",
    name: (t, ctx) => {
      const c = t.cadence;
      const when = c?.kind === "monthly" ? "Monthly" : c?.kind === "weekly" ? (c.dow === 1 ? "Monday" : "Weekly") : c?.kind === "daily" ? "Daily" : "";
      const aud = audienceOf(t, ctx);
      const q = t.qualifier && !/^(?:monthly|weekly|daily|monday)$/.test(t.qualifier) ? t.qualifier : "";
      return normalizeWhitespace(`${when} ${q !== aud ? `${aud} ` : ""}${q} reports`).replace(/^./, (x) => x.toUpperCase());
    },
    cadence: { kind: "weekly", dow: 1 },
    outputKind: () => "report",
    tools: [...BASE, "send_message", "request_approval"],
    defaultHours: 2,
    steps: (t, ctx) => {
      const rec = recordSystem(t, ctx);
      const aud = audienceOf(t, ctx);
      const items = t.items.length ? t.items : ["the key figures", "what changed since last period", "what needs attention"];
      const c = t.cadence;
      const deadline = c?.kind === "monthly" && c.deadlineDay ? c.deadlineDay : null;
      return [
        `Pull last ${c?.kind === "monthly" ? "month" : "week"}'s figures for each ${aud} from ${rec ?? "the source system"} (read-only)${/statement/i.test(t.sentences.map((s) => s.text).join(" ")) ? ", starting from the statement it already produces" : ""}.`,
        `For each ${aud}, cover: ${listJoin(items)}.`,
        `Compare with the prior ${c?.kind === "monthly" ? "month" : "week"} and flag anything unusual (a change over 15%, a late payment, an item that has been open too long).`,
        `Write each ${aud}'s ${/letter/i.test(t.sentences.map((s) => s.text).join(" ")) ? "summary letter" : "report"} in ${ctx.ownerFirst}'s voice: a two-sentence headline, a GFM table of the figures with the change, and 1–3 things to know or decide.`,
        `Deliver all drafts to the portal${deadline ? ` by the ${ordinal(Math.max(1, deadline - 3))}, so they go out before the ${ordinal(deadline)}` : ""}; ${approvalStep(t, ctx, `emailing each ${aud} their report`).replace(/^Request/, "request")}`,
      ];
    },
    knowledge: (t, ctx) => [
      { title: `A recent ${t.phrase} you were happy with`, why: "Sets the format and tone to match." },
      { title: `Read access or exports from ${recordSystem(t, ctx) ?? "the system that holds the figures"}`, why: "Every figure comes from it." },
    ],
    questions: (t, ctx) => [`Which ${audienceOf(t, ctx)}s get a ${t.phrase.replace(/s$/, "")}, and is there anyone who needs a different format?`],
    overnight: (t, ctx) => ({
      title: `${PLAYS.report.name(t, ctx)}: the template and a worked example`,
      description: `${ctx.org} wakes up to the ${t.phrase} format built from the call, with a worked example — the work that takes ${t.hoursPerWeek ? `about ${fmtHours(t.hoursPerWeek)}` : "hours"} by hand today.`,
      instructions: [
        "Using the discovery call and memory:",
        `1. Draft the ${t.phrase.replace(/s$/, "")} template: headline, a GFM table covering ${listJoin(t.items.length ? t.items : ["the key figures"])}, and "what to know / what to decide".`,
        `2. Fill one worked example for a typical ${audienceOf(t, ctx)}, with placeholder figures clearly marked.`,
        `3. List exactly what access (${recordSystem(t, ctx) ?? "system"} exports) you need to produce every real report next cycle.`,
      ].join("\n"),
    }),
    resale: (t, ctx) => `${ctx.org} could sell the ${t.phrase} as a premium upgrade to its ${audienceOf(t, ctx)}s.`,
    verb: (t, ctx) => `drafts the ${PLAYS.report.name(t, ctx).toLowerCase()}`,
  },
  triage: {
    role: (t) => `${cap(t.qualifier || "Service")} Coordinator`,
    name: (t) => `${cap(t.qualifier || "Service")} request triage & dispatch`,
    cadence: { kind: "event", channel: "email" },
    outputKind: () => "message",
    tools: [...BASE, "send_message", "request_approval", "schedule_followup"],
    defaultHours: 5,
    steps: (t, ctx) => {
      const txt = t.sentences.map((s) => s.text).join(" ");
      const examples = /water leak|no heat|leak|flood|no cooling|no hot water/i.exec(txt)?.[0];
      const vendorList = /preferred vendor list[^,.]*/i.exec(txt)?.[0];
      const money = rulesFor(t, ctx).filter((r) => /\$\d/.test(r));
      return [
        `Read each new request as it arrives (${listJoin([...new Set([recordSystem(t, ctx) ? `the ${recordSystem(t, ctx)} portal` : null, /\btext/i.test(txt) ? "texts to the office line" : null, "email"].filter((x): x is string => !!x))], "or")}) and pull out the unit/address, the problem, photos and how to get in.`,
        `Classify it: emergency${examples ? ` (${examples} and anything like it)` : ""} → handle now; routine → today's queue.`,
        `Pick the vendor by trade and area from ${vendorList ? `the ${vendorList.replace(/^the\s+/i, "")}` : "the preferred vendor list"}.`,
        money.length
          ? `Apply the approval limits from the call: ${money.map((r) => `“${truncate(r, 140)}”`).join(" ")} Draft the approval email to the owner and follow up after 24 hours if there is no answer.`
          : "Check whether the job needs the owner's approval before work starts; draft the approval request if so.",
        `Draft the dispatch to the vendor and a short acknowledgement to the requester; external sends wait for approval.`,
        `Deliver a running GFM table to ${doerOf(t, ctx)} (request, unit, urgency, vendor, approval needed?, status) and keep it current in memory.`,
      ];
    },
    knowledge: () => [{ title: "Preferred vendor list (trade, area, rates, contact)", why: "Every dispatch picks from it." }, { title: "Owner approval thresholds per property", why: "Some owners want approval at a lower amount." }],
    questions: (t, ctx) => [`Confirm the approval limits per owner (${rulesFor(t, ctx).filter((r) => /\$\d/.test(r)).length ? "the call mentioned more than one" : "the call did not give one"}), and who covers emergencies at night.`],
    overnight: (t, ctx) => ({
      title: `${cap(t.qualifier || "Service")} triage playbook and dispatch drafts`,
      description: `The rules ${doerOf(t, ctx)} applies in her head, written down — urgency, vendor choice and approval limits — with ready-to-use dispatch and approval messages.`,
      instructions: [
        "Using the discovery call and memory:",
        "1. Write the triage rules: what counts as an emergency, what can wait, with examples from the call.",
        "2. Write the approval rules as a GFM table (situation, limit, who approves, how to ask) using the dollar limits from the call.",
        "3. Draft the vendor dispatch message, the owner approval email and the requester acknowledgement.",
        "4. List what you need to go live (vendor list, owner limits, access to the request inbox).",
      ].join("\n"),
    }),
    resale: (_t, ctx) => `Offer the after-hours and triage desk to other operators ${ctx.org} knows as a white-labeled service.`,
    verb: (t) => `triages every ${t.qualifier || "service"} request and drafts the dispatch`,
  },
  urgent: {
    role: () => "After-hours Coordinator",
    name: () => "After-hours emergency triage",
    cadence: { kind: "event", channel: "sms" },
    outputKind: () => "message",
    tools: [...BASE, "send_message", "request_approval"],
    defaultHours: 2,
    steps: (t, ctx) => {
      const txt = t.sentences.map((s) => s.text).join(" ");
      const ex = /water (?:is )?coming through the ceiling|water leak|no heat|flood\w*|gas smell|burst pipe/i.exec(txt)?.[0];
      return [
        "When a message arrives outside office hours, read it right away and decide whether it is an emergency" + (ex ? ` (e.g. ${ex})` : "") + ".",
        `Emergency: text ${ctx.d.owner ?? "the on-call person"} immediately with the address, the problem and the recommended vendor from the preferred list, plus a one-tap approval to dispatch.`,
        "Draft a calm reply to the sender with what happens next and what to do in the meantime; it goes out once approved.",
        "Not an emergency: acknowledge it and queue it for the morning triage.",
        "Log every after-hours message and what was done, for the morning summary.",
      ];
    },
    knowledge: () => [{ title: "After-hours emergency list and on-call contacts", why: "Decides who gets woken up and which vendor to call." }],
    questions: (_t, ctx) => [`Who is on call at night, and should the agent text ${ctx.d.owner ?? "the owner"} for every emergency or only above a threshold?`],
    overnight: (_t, ctx) => ({
      title: "After-hours emergency playbook",
      description: `What counts as an emergency at ${ctx.org}, who gets called, and the messages to send — ready before the next 11 PM leak.`,
      instructions: "Write the after-hours playbook from the call: emergency vs. routine examples, the on-call escalation, the vendor to call by trade, and three message drafts (to the on-call person, to the vendor, to the sender).",
    }),
    resale: (_t, ctx) => `Sell the after-hours line to other operators in ${ctx.org}'s network.`,
    verb: () => "catches after-hours emergencies",
  },
  deadline: {
    role: (t) => `${cap(t.qualifier || "Renewals")} Coordinator`,
    name: (t) => `${cap(t.qualifier ? `${t.qualifier} renewal` : "Renewal")} offers`,
    cadence: { kind: "weekly", dow: 1 },
    outputKind: () => "email_draft",
    tools: [...BASE, "send_message", "request_approval", "schedule_followup"],
    defaultHours: 1.5,
    steps: (t, ctx) => {
      const lead = t.leadDays ?? 60;
      const q = t.qualifier || "contract";
      return [
        `List every ${q} expiring in the next ${lead + 30} days from ${recordSystem(t, ctx) ?? "the records"}, with current terms.`,
        `For each one reaching ${lead} days out, draft the renewal offer (current terms, proposed terms per your rules, deadline to respond).`,
        approvalStep(t, ctx, "any offer is sent"),
        `Track responses; flag anything within 30 days with no answer so it does not roll over by default.`,
        `Deliver a GFM table each week (${q}, expires, days left, offer status, next step) with the drafts below.`,
      ];
    },
    knowledge: (t) => [{ title: `${cap(t.qualifier || "Renewal")} renewal rules (increase policy, terms)`, why: "Offers must follow them." }],
    questions: (t) => [`What are the rules for ${t.qualifier || ""} renewal offers (increase, term length), and who signs off on each?`],
    overnight: (t, ctx) => ({
      title: `${cap(t.qualifier || "Renewal")} renewal tracker and offer template`,
      description: `A tracker for every ${t.qualifier || ""} renewal ${ctx.org} must send ${t.leadDays ?? 60} days out, with an offer template ready to approve.`,
      instructions: `Build the renewal tracker as a GFM table (${t.qualifier || "item"}, expires, days left, status), draft the renewal offer template, and list what data you need to fill it for real.`,
    }),
    resale: (_t, ctx) => `Offer renewal tracking as an add-on to ${ctx.org}'s customers.`,
    verb: (t) => `sends ${t.qualifier || ""} renewal offers on time`,
  },
  packet: {
    role: (t) => (/claim|supplement/i.test(t.phrase) ? "Claims Coordinator" : "Paperwork Coordinator"),
    name: (t) => (/claim|supplement/i.test(t.phrase) ? `${/insurance/i.test(t.phrase) || /insurance/i.test(t.first.text) ? "Insurance claim" : "Claim"} packets & supplements` : `${cap(t.phrase)} prep`),
    cadence: { kind: "event", channel: "email" },
    outputKind: () => "document",
    tools: [...BASE, ...COMPUTER, "send_message", "request_approval", "schedule_followup"],
    computer: true,
    defaultHours: 4,
    steps: (t, ctx) => {
      const sys = t.systems.length ? t.systems : ctx.d.systems;
      const items = t.items.length ? t.items : ["photos", "measurements", "the estimate", "the adjuster's scope"];
      return [
        `When a job is ready for the claim, gather everything for it${sys.length ? ` from ${listJoin(sys.slice(0, 4))}` : ""}: ${listJoin(items)}.`,
        "Check the packet against the carrier's checklist and list anything missing.",
        "Compare our scope with the adjuster's line by line; draft a supplement for every item they left out, with the photo or measurement that supports it.",
        "Draft the cover email to the adjuster.",
        approvalStep(t, ctx, "anything is submitted to a carrier or adjuster"),
        "Track every open claim (submitted, days waiting, amount pending) and deliver a weekly GFM status table; schedule a follow-up for anything waiting more than 10 days.",
      ];
    },
    knowledge: () => [{ title: "Carrier checklists and two past claim packets that were paid", why: "Sets the format adjusters accept." }],
    questions: () => ["Which carriers and adjusters come up most, and does anyone need to sign the packet before it goes out?"],
    overnight: (t, ctx) => ({
      title: `${PLAYS.packet.name(t, ctx)}: checklist, supplement template and claim tracker`,
      description: `The packet ${ctx.org} assembles by hand today, as a checklist and templates — plus a tracker for every open claim${t.money ? ` (the call mentioned ${fmtMoney(t.money)} at stake)` : ""}.`,
      instructions: [
        "Using the discovery call and memory:",
        `1. Write the claim packet checklist (${listJoin(t.items.length ? t.items : ["photos", "measurements", "estimate", "scope"])}) as a GFM table: item, where it comes from, who provides it.`,
        "2. Draft the supplement request template and the adjuster cover email.",
        "3. Lay out the open-claims tracker (job, carrier, submitted, days waiting, amount pending, next step).",
        "4. List what access you need to assemble the first real packet.",
      ].join("\n"),
    }),
    resale: (_t, ctx) => `Sell claim packet prep to other contractors ${ctx.org} subs for or partners with.`,
    verb: () => "assembles claim packets and supplements",
  },
  close: {
    role: () => "Month-end Close Coordinator",
    name: (t) => (/reconcil/i.test(t.phrase) ? "Account reconciliations" : "Month-end close"),
    cadence: { kind: "monthly", day: 1, deadlineDay: null },
    outputKind: () => "report",
    tools: [...BASE, ...COMPUTER, "send_message", "request_approval", "schedule_followup"],
    computer: true,
    defaultHours: 6,
    steps: (t, ctx) => {
      const rec = recordSystem(t, ctx) ?? "the accounting system";
      const items = t.items.length ? t.items : ["bank and credit card reconciliations", "uncategorized transactions", "accruals", "the close package"];
      return [
        `On the first business day, build the close checklist for every client: ${listJoin(items)}.`,
        `Reconcile bank and card accounts in ${rec}; list every unmatched or uncategorized transaction with date, payee and amount.`,
        "Draft ONE email per client with a table of what we need from them (receipt, explanation, document) — never one email per item.",
        `Prepare proposed adjusting entries for review; nothing is posted in ${rec} without approval.`,
        approvalStep(t, ctx, "any email goes to a client"),
        "Deliver a close status board as a GFM table (client, accounts reconciled, open items, waiting on client, ready to close?) and update it daily until every client is closed.",
      ];
    },
    knowledge: (t, ctx) => [{ title: `Client list with close deadlines and ${recordSystem(t, ctx) ?? "accounting system"} access`, why: "The close board is built from it." }, { title: "Your close checklist", why: "Every client is closed the same way." }],
    questions: (t, ctx) => [`Which clients close first, and can the agent post entries in ${recordSystem(t, ctx) ?? "the books"} after approval or only propose them?`],
    overnight: (t, ctx) => ({
      title: "Month-end close board and client question drafts",
      description: `A close board for every ${ctx.org} client and the "what we need from you" emails, drafted — the work behind ${t.hoursPerWeek ? `about ${fmtHours(t.hoursPerWeek)}` : "the close"}.`,
      instructions: [
        "Using the discovery call and memory:",
        "1. Write the close checklist as a GFM table (step, owner, due day, done?).",
        "2. Lay out the close status board (client, accounts reconciled, open items, waiting on client, ready?) with example rows marked.",
        "3. Draft the client question email with a table of open items, warm and specific.",
        "4. List the access you need to run the real close.",
      ].join("\n"),
    }),
    resale: (_t, ctx) => `${ctx.org} could sell a mid-month "books health check" from the same agent as an upgrade.`,
    verb: () => "runs the month-end close checklist",
  },
  quote: {
    role: () => "Quoting Specialist",
    name: (t, ctx) => (ctx.vertical?.id === "promo" || /presentation/i.test(t.sentences.map((s) => s.text).join(" ")) ? "Quote & product presentation builder" : "Quote builder"),
    cadence: { kind: "event", channel: "email" },
    outputKind: () => "document",
    tools: [...BASE, "http_fetch", "send_message", "request_approval"],
    defaultHours: 8,
    steps: (t, ctx) => {
      const promo = ctx.vertical?.id === "promo";
      return [
        `Read the incoming request (email or portal) and extract: customer, contact, ${promo ? "item types, quantities, imprint/logo details, in-hands date" : "scope, quantities, deadline"}, budget.`,
        `Search the knowledge base for matching ${promo ? "products" : "products and services"}; pick 3–5 options across good/better/best price points.`,
        "Price each option from the latest price list (apply the standard margin and any customer-specific pricing in memory); note lead times and minimums.",
        "Build the quote as a document: a short intro, then a GFM table (option, description, unit price, quantity, total, lead time), then terms.",
        approvalStep(t, ctx, "the quote email goes to the customer"),
        "Log the quote (customer, value, date) to memory so follow-ups and repeat orders are faster.",
        `If anything is missing (quantity, date, artwork), ask the owner one specific question in the portal instead of guessing.${ctx.d.systems.length ? ` Use ${listJoin(ctx.d.systems.slice(0, 3))} where the data lives.` : ""}`,
      ];
    },
    knowledge: (_t, ctx) => [
      { title: ctx.vertical?.id === "promo" ? "Supplier catalogs and current price lists" : "Price list / rate card", why: "Every quote line is priced from it." },
      { title: "Two or three past quotes the owner was proud of", why: "Sets the format, tone and margin to match." },
      { title: "Standard terms, minimums and lead times", why: "Quotes must state them correctly." },
    ],
    questions: () => ["What margin do you apply by default, and who must approve a quote before it goes out?", "Where do quote requests arrive today (a shared inbox, a web form, phone)?"],
    overnight: (t, ctx) => ({
      title: ctx.vertical?.id === "promo" ? "Your quote kit: template + 3 ready-to-send sample quotes" : "Your quote kit: template + 3 sample quotes",
      description: `Overnight, ${ctx.org}'s new quoting specialist turns the call into a reusable quote template and three realistic sample quotes in your format — so the ${t.hoursPerWeek ? `~${Math.round(t.hoursPerWeek)} hours a week of` : "hours spent on"} quote-building starts shrinking on day one.`,
      instructions: [
        "Using the discovery call transcript in the knowledge base and anything you remember about this business:",
        `1. Write a one-page quote template for ${ctx.org} (intro, options table, terms) in markdown.`,
        `2. Build three sample quotes for the kinds of requests described on the call, each with a GFM table of 3–5 ${ctx.vertical?.id === "promo" ? "products" : "line items"} (description, unit price placeholder, quantity, total, lead time).`,
        "3. List the exact data you still need (catalogs, price lists, margins) to fill real prices.",
      ].join("\n"),
    }),
    resale: (_t, ctx) =>
      ctx.vertical?.id === "promo"
        ? `Give ${ctx.org}'s corporate buyers a self-serve "quote desk": they request branded merchandise in a white-labeled portal and get an instant, on-brand quote. Sell it as a premium tier or use it to win larger accounts.`
        : `Package the quote builder as a self-serve quote desk for ${ctx.org}'s customers (white-labeled portal), sold as a premium tier.`,
    verb: () => "builds customer quotes and presentations",
  },
  entry: {
    role: (t) => (/migrat|switch|bring/i.test(t.phrase) ? "Data Migration Specialist" : "Data Entry Specialist"),
    name: (t, ctx) => (/migrat|switch|bring|pulling records|fields/i.test(t.phrase) ? (ctx.vertical?.id === "insurance" ? "Overnight policy & insured data migration" : "Overnight data migration") : `Data entry into ${recordSystem(t, ctx) ?? "your system"}`),
    cadence: { kind: "event", channel: "email" },
    outputKind: () => "table",
    tools: [...BASE, ...COMPUTER, "request_approval"],
    computer: true,
    defaultHours: 10,
    steps: (t, ctx) => [
      "Open the source system on your computer and sign in with the credentials stored for this customer.",
      `For each ${ctx.vertical?.id === "insurance" ? "insured and policy (named insured, policy number, carrier, effective/expiration dates, premium, coverages)" : "record"}, click into every field and capture the values.`,
      "Normalize the data to the target system's field map (dates ISO-8601, money as numbers, names split first/last).",
      "Validate: flag duplicates, missing required fields and values that do not match the field map.",
      "Produce a GFM table of migrated records plus an exceptions table that needs a human.",
      approvalStep(t, ctx, "writing records into the target system; then import and spot-check 5 records against the source"),
      "Report totals (records moved, exceptions, time taken) in the morning summary.",
    ],
    knowledge: (_t, ctx) => [
      { title: "Target system field map", why: "Defines where every source field goes." },
      { title: ctx.vertical?.id === "insurance" ? "Source agency-management system access (test account)" : "Source system access (test account)", why: "The agent works through the UI like a person would." },
      { title: "A sample export or 10 example records", why: "Lets the agent verify its mapping before the full run." },
    ],
    questions: () => ["Which source systems do customers usually migrate from, and can we get a test login for one?", "Who signs off on a migration before records are written to production?"],
    overnight: (t, ctx) => ({
      title: "Migration playbook + field map draft",
      description: `By morning ${ctx.org} gets a draft field map and the step-by-step runbook the agent will follow${t.money ? `, so the first real migration (a job billed at ~${fmtMoney(t.money)}) can run overnight this week` : ""}.`,
      instructions: [
        "From the discovery call and knowledge base:",
        `1. Draft the field map as a GFM table (source field → target field → transform → required?) for ${ctx.vertical?.id === "insurance" ? "insureds and policies" : "the records discussed"}.`,
        "2. Write the overnight runbook: login, navigation, extraction order, validation rules, exception handling, approval checkpoint.",
        "3. Estimate run time and cost versus the manual process quoted on the call.",
        "4. List exactly what access and sample data you need to run the first migration.",
      ].join("\n"),
    }),
    resale: (t, ctx) =>
      `Sell "migration in a night" to ${ctx.org}'s own customers: when a customer switches from a competitor, the agent moves their ${ctx.vertical?.id === "insurance" ? "policies and insureds" : "data"} overnight. Charge per migration${t.money ? ` (it replaces a manual job billed at ~${fmtMoney(t.money)})` : ""} or bundle it into onboarding.`,
    verb: () => "moves data between systems overnight",
  },
  schedule: {
    role: () => "Dispatch Coordinator",
    name: () => "Morning dispatch board",
    cadence: { kind: "daily", days: "1-6" },
    outputKind: () => "table",
    tools: [...BASE, "send_message"],
    defaultHours: 6,
    steps: (t, ctx) => {
      const txt = t.sentences.map((s) => s.text).join(" ");
      const crew = /\b(?:six|five|four|three|eight|ten|\d+) (?:techs|technicians|crews|installers|drivers)\b/i.exec(txt)?.[0];
      return [
        `Collect new requests from overnight ${listJoin([/voicemail/i.test(txt) ? "voicemails" : null, /web form/i.test(txt) ? "web form requests" : null, "emails"].filter((x): x is string => !!x))}.`,
        `Classify each by urgency${/no[- ]heat/i.test(txt) ? " (no-heat calls first)" : ""}, job type and estimated duration.`,
        `Assign jobs to ${crew ?? "the crew"} by skill, location and existing appointments${recordSystem(t, ctx) ? ` in ${recordSystem(t, ctx)}` : ""}; leave buffer for emergencies.`,
        "Deliver the dispatch board as a GFM table (time, customer, area, job, assigned to, notes).",
        `Text each tech their first job and ${ctx.d.recipient.name ?? "the owner"} a one-line summary${ctx.d.recipient.by ? ` before ${clock(ctx.d.recipient.by.h, ctx.d.recipient.by.m)}` : ""}.`,
      ];
    },
    knowledge: () => [{ title: "Crew roster, skills and service areas", why: "Needed to assign jobs correctly." }],
    questions: (t, ctx) => [`Can the agent read today's appointments in ${recordSystem(t, ctx) ?? "the job system"}?`],
    overnight: (_t, ctx) => ({
      title: "Tomorrow's dispatch board, pre-built",
      description: `${ctx.org} wakes up to tomorrow's jobs already sorted by urgency and assigned.`,
      instructions: "Build tomorrow's dispatch board as a GFM table from the requests in the knowledge base and memory; write the urgency rules you used; flag anything you could not assign.",
    }),
    resale: (_t, ctx) => `Package the dispatcher for other contractors ${ctx.org} partners with.`,
    verb: () => "builds the daily dispatch board",
  },
  reviews: {
    role: () => "Reputation Manager",
    name: () => "Review requests & responses",
    cadence: { kind: "daily", days: "1-5" },
    outputKind: () => "email_draft",
    tools: [...BASE, "send_message", "request_approval"],
    defaultHours: 1,
    steps: (t, ctx) => [
      `List ${audienceOf(t, ctx)}s whose visit or job finished today and draft a short review request for each${prefersText(t, ctx) ? " by text" : ""}.`,
      "Draft responses to new reviews (thank positive ones by name; offer to make negative ones right, offline).",
      approvalStep(t, ctx, "any request or response is sent"),
    ],
    knowledge: () => [{ title: "Links to your review profiles", why: "Requests must point to the right place." }],
    questions: () => ["Which review sites matter most to you?"],
    overnight: (_t, ctx) => ({
      title: "Review request templates",
      description: `Review request and response templates in ${ctx.org}'s voice.`,
      instructions: "Write 3 review request templates and 4 response templates (positive, neutral, negative, no-text).",
    }),
    resale: (_t, ctx) => `Bundle review management for ${ctx.org}'s customers.`,
    verb: () => "asks for and answers reviews",
  },
  sync: {
    role: () => "Catalog & Pricing Analyst",
    name: () => "Nightly catalog & pricing sync",
    cadence: { kind: "daily", days: "1-5" },
    outputKind: () => "table",
    tools: ["http_fetch", ...BASE],
    defaultHours: 5,
    steps: (_t, ctx) => [
      "Fetch each supplier catalog page / feed listed in the knowledge base (public pages only, via http_fetch).",
      `Extract ${ctx.vertical?.id === "promo" ? "product name, SKU, category, decoration methods, minimums, price breaks" : "item, SKU, category, price"} for every item.`,
      "Compare with the last snapshot in memory: new items, discontinued items, price changes above 3%.",
      "Save the new snapshot summary to memory.",
      "Deliver a GFM table of changes (item, category, old price, new price, change %) with the biggest changes first.",
    ],
    knowledge: () => [{ title: "List of supplier catalog URLs / feeds", why: "The nightly sync reads them." }],
    questions: () => ["Which suppliers matter most, and do any require a login to see pricing?"],
    overnight: (_t, ctx) => ({ title: "Catalog snapshot by category", description: `A categorized snapshot of ${ctx.org}'s key supplier catalogs.`, instructions: "Fetch the supplier catalogs in the knowledge base and produce a GFM table per category with price breaks and minimums. Note gaps." }),
    resale: (_t, ctx) => `Offer ${ctx.org}'s customers a live, branded product catalog with current pricing as a portal add-on.`,
    verb: () => "keeps the catalog and pricing current overnight",
  },
  invoice: {
    role: () => "Billing Coordinator",
    name: () => "Invoice prep & payment follow-up",
    cadence: { kind: "daily", days: "1-5" },
    outputKind: () => "document",
    tools: [...BASE, "send_message", "request_approval"],
    defaultHours: 3,
    steps: (t, ctx) => [
      `List orders/jobs completed since the last run that do not have an invoice yet${recordSystem(t, ctx) ? ` in ${recordSystem(t, ctx)}` : ""}.`,
      "Draft each invoice (customer, line items, quantities, prices, tax, terms) from the order and the price list.",
      "List invoices that are past due, with days outstanding, and draft a polite reminder for each.",
      "Deliver a document: invoices ready to send (GFM table with totals), reminders drafted, and anything that needs the owner.",
      approvalStep(t, ctx, "any invoice or reminder is sent"),
    ],
    knowledge: () => [{ title: "Invoice template and payment terms", why: "Invoices must match your format and terms." }],
    questions: (t, ctx) => [`May the agent create draft invoices in ${recordSystem(t, ctx) ?? "your billing system"}?`],
    overnight: (_t, ctx) => ({ title: "Receivables snapshot", description: `What ${ctx.org} is owed and the reminders to send, ready for approval.`, instructions: "Build a GFM table of open and past-due invoices you can find in the knowledge base, with drafted reminders and the total outstanding." }),
    resale: (_t, ctx) => `Offer ${ctx.org}'s customers automated statements and payment reminders under their brand.`,
    verb: () => "preps invoices and chases payments",
  },
  inbox: {
    role: () => "Executive Assistant",
    name: () => "Inbox triage & reply drafts",
    cadence: { kind: "event", channel: "email" },
    outputKind: () => "email_draft",
    tools: [...BASE, "send_message", "request_approval"],
    defaultHours: 3,
    steps: (t, ctx) => [
      "Read each new email and classify it: needs owner, can be answered from knowledge, FYI, spam.",
      "Draft replies for anything answerable from the knowledge base and memory, in the owner's voice.",
      "Deliver a morning digest: a GFM table (from, subject, category, suggested action) plus the drafts.",
      approvalStep(t, ctx, "any reply goes out"),
    ],
    knowledge: () => [{ title: "FAQ / canned answers you send often", why: "Lets the agent draft accurate replies." }],
    questions: () => ["Which inbox should the agent watch, and which senders always go straight to you?"],
    overnight: (_t, ctx) => ({ title: "Inbox playbook + top reply templates", description: `${ctx.org}'s most common emails, each with a reply template.`, instructions: "Write the inbox playbook: categories, routing rules and 5 reply templates based on the call." }),
    resale: (_t, ctx) => `Offer ${ctx.org}'s customers an AI front desk that answers routine email under their brand.`,
    verb: () => "triages the inbox and drafts replies",
  },
  manual: {
    role: () => "Operations Assistant",
    name: (t) => cap(truncate(t.phrase, 60)),
    cadence: { kind: "weekly", dow: 1 },
    outputKind: () => "document",
    tools: [...BASE, "send_message", "request_approval"],
    defaultHours: 2,
    steps: (t, ctx) => [
      `Collect what is needed for ${t.phrase} from ${listJoin(t.systems.slice(0, 3)) || "the knowledge base and memory"}.`,
      `Do the ${t.phrase} work the way ${doerOf(t, ctx)} does it today (see the call notes in the knowledge base), and mark any assumption clearly.`,
      `Deliver the result as one document with a GFM table of what was done and what needs ${ctx.ownerFirst}.`,
      approvalStep(t, ctx, "anything leaves the business"),
    ],
    knowledge: (t) => [{ title: `How ${t.phrase} is done today (a checklist or an example)`, why: "The agent follows the same steps." }],
    questions: (t) => [`Walk us through one example of ${t.phrase}, start to finish.`],
    overnight: (t) => ({ title: `${cap(t.phrase)}: the checklist and a first draft`, description: `The ${t.phrase} process written down from the call, with a first draft.`, instructions: `Write the step-by-step checklist for ${t.phrase} from the call, a first draft of the output, and what you need to do it for real.` }),
    resale: (t, ctx) => `Offer ${t.phrase} as a service to ${ctx.org}'s customers.`,
    verb: (t) => `handles ${t.phrase}`,
  },
};

/** "unscheduled treatment" / "receipts and missing documents" → readable object for names. */
function normalizeObject(phrase: string): string {
  return phrase.replace(/\band\b/g, "&").replace(/\s+/g, " ").trim();
}

function firstName(name: string | null): string {
  return name ? (name.startsWith("Dr.") ? name : (name.split(" ")[0] ?? name)) : "the owner";
}

export function heuristicSpec(input: ArchitectInput): AgentSpec {
  const orgName = normalizeWhitespace(input.orgName ?? "") || "the client";
  const raw = readDiscovery(input.transcript);
  // The business type comes from the industry field or the owner's own description of the business.
  const description = raw.sentences
    .slice(0, 12)
    .filter((s) => /\b(?:we|i)\b.*\b(?:are|run|own|manage|do|see|have|serve|operate|install|handle)\b/i.test(s.text))
    .map((s) => s.text)
    .join(" ");
  const vertical = pickVertical(input.industry, `${orgName} ${description}`);
  // A monologue (podcast, unlabelled notes) mixes several businesses: keep sentences about this one.
  const labelled = raw.sentences.some((s) => s.speaker);
  const d =
    !labelled && vertical
      ? readDiscovery(input.transcript, (text, prev, next) => {
          const vs = detectVerticals(`${prev} ${text} ${next}`);
          return vs.size === 0 || vs.has(vertical.id);
        })
      : raw;
  d.vertical = vertical?.label ?? null;

  const approverNames = (() => {
    const r = d.rules.join(" ");
    const m = /without ((?:me|[A-Z][a-z]+)(?: or (?:me|[A-Z][a-z]+))?) (?:seeing|reading|reviewing|approving|signing off|looking at|checking)/.exec(r);
    if (m) return m[1]!.replace(/\bme\b/, firstName(d.owner));
    const rev = /\b(?:my|our) (?:partner|office manager|manager),? ([A-Z][a-z]+),? reviews/.exec(r)?.[1];
    return rev ?? firstName(d.owner);
  })();
  const ctx: Ctx = { org: orgName, d, vertical, ownerFirst: firstName(d.owner), approver: approverNames };

  // Distinct actions only, best first; 2–5 workflows.
  const seen = new Set<Action>();
  const topics = d.topics.filter((t) => (seen.has(t.action) ? false : (seen.add(t.action), true))).slice(0, 5);
  const fallbackTopic: Topic | null = topics.length
    ? null
    : {
        action: "manual",
        phrase: "the weekly operations summary",
        qualifier: "",
        sentences: d.sentences.slice(0, 3),
        first: d.sentences[0] ?? { text: "", turn: 0, idx: 0, speaker: null, afterItch: false },
        hoursPerWeek: null,
        money: null,
        moneyText: null,
        score: 0,
        cadence: { kind: "weekly", dow: 1 },
        items: [],
        systems: d.systems,
        people: [],
        rules: [],
        leadDays: null,
      };
  if (fallbackTopic) topics.push(fallbackTopic);
  const primary = topics[0]!;

  const workflows: WorkflowSpec[] = topics.map((t) => {
    const p = PLAYS[t.action];
    const trigger = cronFor(t, ctx, p.cadence);
    const stated = t.hoursPerWeek;
    // The agent drafts; a person still reviews — count ~80% of the stated time as saved.
    const weekly = stated ? stated * 0.8 : p.defaultHours;
    const perRun = Math.min(200, Math.max(0.25, Math.round((weekly / runsPerWeek(trigger)) * 4) / 4));
    const evidence = [...t.sentences].sort((a, b) => painScore(b.text) - painScore(a.text))[0] ?? t.first;
    const cost = [stated ? `about ${fmtHours(stated)} by hand today` : null, t.money && t.moneyText ? `${fmtMoney(t.money)} at stake (“${quoteOf(t.moneyText, 120)}”)` : null].filter(Boolean).join("; ");
    const problem = truncate(`On the call: “${quoteOf(evidence.text, 260)}”${cost ? ` — ${cost}.` : ""}`, 600);
    const deliverTo: WorkflowSpec["deliverTo"] = ["portal"];
    const recipientChannel = ctx.d.recipient.channel ?? "email";
    if (t.action === "urgent" || (t.action === "schedule" && d.channels.sms)) deliverTo.push("sms");
    else deliverTo.push(recipientChannel === "sms" && d.channels.sms ? "sms" : "email");
    return {
      name: truncate(p.name(t, ctx), 80),
      problem,
      instructions: truncate(p.steps(t, ctx).map((s, i) => `${i + 1}. ${s}`).join("\n"), 6000),
      trigger,
      outputKind: p.outputKind(t, ctx),
      deliverTo: [...new Set(deliverTo)],
      hoursSavedPerRun: perRun,
      tools: p.tools,
    };
  });

  const weeklyHoursSaved = Math.round(workflows.reduce((n, w) => n + w.hoursSavedPerRun * runsPerWeek(w.trigger), 0) * 10) / 10;
  const name = NAMES[hash32(`${orgName}:${primary.action}`) % NAMES.length]!;
  const role = truncate(PLAYS[primary.action].role(primary, ctx), 80);
  const verticalLabel = vertical?.label ?? (input.industry ? truncate(input.industry, 80) : "");

  const channels: AgentSpec["channels"] = ["portal", "email"];
  if (d.channels.slack) channels.push("slack");
  if (d.channels.sms) channels.push("sms");

  const verbs = topics.map((t) => PLAYS[t.action].verb(t, ctx));
  const verbList = verbs.length > 1 ? `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}` : (verbs[0] ?? "handles recurring work");
  const summary = truncate(`${name} ${verbList} for ${orgName} — about ${Math.round(weeklyHoursSaved)} hours a week back.`, 280);

  // Seed memories: concrete facts from the call, in the owner's words where possible.
  const seedMemories: string[] = [];
  seedMemories.push(`${orgName} is ${verticalLabel ? `${/^[aeiou]/i.test(verticalLabel) ? "an" : "a"} ${verticalLabel.toLowerCase()} business${vertical ? ` serving ${vertical.customers}` : ""}` : "a small business"}.`);
  for (const f of d.facts.slice(0, 4)) seedMemories.push(`About the business: “${quoteOf(f)}”`);
  topics.forEach((t, i) => {
    const w = workflows[i]!;
    if (t.hoursPerWeek) seedMemories.push(`${w.name}: currently ~${Math.round(t.hoursPerWeek * 10) / 10} hours/week of manual work.`);
    if (t.money && t.moneyText) seedMemories.push(`${w.name}: ${fmtMoney(t.money)} at stake — “${quoteOf(t.moneyText)}”`);
    const ev = [...t.sentences].filter((s) => s !== t.first).sort((a, b) => painScore(b.text) - painScore(a.text))[0];
    seedMemories.push(`From the discovery call: “${quoteOf(t.first.text)}”`);
    if (ev && painScore(ev.text) > 0) seedMemories.push(`From the discovery call: “${quoteOf(ev.text)}”`);
  });
  for (const p of d.people) seedMemories.push(`Person: ${p.name}${p.role ? ` (${p.role}${p.name === d.owner ? ", on the call" : ""})` : ""}.`);
  if (d.systems.length) seedMemories.push(`Systems and tools mentioned: ${d.systems.join(", ")}.`);
  for (const r of d.rules) seedMemories.push(`Approval rule from the call: “${quoteOf(r)}”`);
  for (const pref of d.preferences) if (!d.rules.includes(pref)) seedMemories.push(`Preference from the call: “${quoteOf(pref)}”`);
  if (d.recipient.name) {
    seedMemories.push(
      `Morning deliverables go to ${d.recipient.name}${d.recipient.channel ? ` by ${d.recipient.channel === "sms" ? "text" : "email"}` : ""}${d.recipient.by ? `, before ${clock(d.recipient.by.h, d.recipient.by.m)}` : ""}.`,
    );
  }

  const knowledgeNeeds = dedupeBy(topics.flatMap((t) => PLAYS[t.action].knowledge(t, ctx)), (k) => k.title).slice(0, 12);
  const usesComputer = topics.some((t) => PLAYS[t.action].computer);
  const compliance: string[] = [];
  if (d.compliance.includes("hipaa"))
    compliance.push("Patient data is PHI: sign a BAA with the practice, keep messages to the minimum necessary, and confirm which patient messages need a human before they go out (HIPAA).");
  if (d.compliance.includes("pii")) compliance.push("The agent will handle financial/personal records (PII): confirm where they may be stored and who may see them.");
  if (d.compliance.includes("contract")) compliance.push("Confirm the approval limits in the management agreement per owner before the agent drafts any dispatch.");
  const openQuestions = dedupeBy(
    [
      "Drafted offline from the transcript (no AI model was used) — review every workflow before hiring.",
      ...compliance,
      ...topics.flatMap((t) => PLAYS[t.action].questions(t, ctx)),
      d.recipient.name ? null : `Who at ${orgName} should receive the morning deliverables, and by what time?`,
      d.systems.length ? `Can we get access to ${listJoin(d.systems.filter((s) => !MESSAGING_SYSTEMS.test(s)).slice(0, 3))} for the agent (read-only to start)?` : "Which systems hold the data the agent needs, and can it get read access?",
    ].filter((q): q is string => !!q),
    (q) => q,
  )
    .map((q) => truncate(q, 300))
    .slice(0, 10);

  const requireApprovalFor = [...new Set(["send_external_email", "send_external_sms", ...(usesComputer ? ["write_client_system"] : [])])];
  const specTools = [...new Set(["knowledge_search", "memory_recall", "memory_save", "create_deliverable", "send_message", "request_approval", "schedule_followup", ...workflows.flatMap((w) => w.tools)])];

  const first = PLAYS[primary.action].overnight(primary, ctx);
  const resaleIdea = truncate(`${PLAYS[primary.action].resale(primary, ctx)}${d.resale ? ` (The call points this way: “${quoteOf(d.resale)}”)` : ""}`, 600);

  const instructions = [
    `You are ${name}, ${role} at ${orgName}${verticalLabel ? ` (${verticalLabel.toLowerCase()})` : ""}. You were hired to take the work below off the team's plate and deliver it finished.`,
    "",
    "## Your responsibilities",
    ...workflows.map((w) => `- **${w.name}** — ${triggerLabel(w.trigger)}. ${truncate(w.problem, 240)}`),
    "",
    "## Rules from the call",
    ...(d.rules.length ? d.rules.map((r) => `- “${quoteOf(r, 220)}”`) : ["- Nothing leaves the business (emails, texts, changes in client systems) without approval."]),
    "",
    "## How you work",
    "- Be proactive: deliver finished work (documents, GFM tables, drafts), not questions. If one detail is missing, make a sensible assumption, label it, and keep going.",
    "- Ground everything in the knowledge base and your memory. Never invent prices, balances, benefits or customer data — mark unknowns clearly.",
    "- Anything that leaves the building (emails, texts, changes in client systems) goes through approval first.",
    "- Save new facts and preferences you learn to memory so you get better every week.",
    d.systems.length ? `- Systems you will work with: ${d.systems.join(", ")}.` : null,
    d.people.length ? `- People: ${d.people.map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join("; ")}.` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const spec: AgentSpec = {
    name,
    role,
    summary,
    vertical: verticalLabel,
    instructions: truncate(instructions, 12000),
    voice: `Warm, concise and specific, like a sharp ${role.toLowerCase()} who knows ${verticalLabel ? verticalLabel.toLowerCase() : "the business"}. Leads with the result; plain words, no jargon.`,
    workflows,
    knowledgeNeeds,
    seedMemories: dedupeBy(seedMemories, (s) => s).map((s) => truncate(s, 500)).slice(0, 40),
    channels,
    tools: specTools,
    requireApprovalFor,
    firstDeliverable: { title: truncate(first.title, 120), description: truncate(first.description, 600), instructions: truncate(first.instructions, 4000) },
    resaleIdea,
    weeklyHoursSaved: Math.min(400, weeklyHoursSaved),
    openQuestions,
  };
  return agentSpec.parse(spec);
}

function painScore(s: string): number {
  const h = hoursPerWeekIn(s);
  return (h ? 3 + h / 2 : 0) + (moneyIn(s) ? 2 : 0) + (/\bby hand|manually|chas|worst|kills|nobody|miss|forget|written off|wrote off|surprise|cold\b/i.test(s) ? 1.5 : 0);
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function triggerLabel(t: WorkflowSpec["trigger"]): string {
  if (t.type === "manual") return "on demand";
  if (t.type === "event") return t.event === "sms.received" ? "whenever a text comes in" : t.event === "email.received" ? "whenever an email comes in" : `whenever ${t.event}`;
  return t.label ? t.label.toLowerCase() : `on schedule (${t.cron})`;
}
