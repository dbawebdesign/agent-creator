/**
 * The Architect — "the agent that builds agents".
 *
 * Input: a discovery-call transcript (+ client org name/industry). Output: a validated `AgentSpec`.
 *
 * - With ANTHROPIC_API_KEY: one structured-output call (JSON schema from the zod spec) with a strong system prompt,
 *   validated with zod and repaired once on failure.
 * - Offline: a heuristic extractor that reads the transcript for the owner's "itch" (repetitive, hours-a-week
 *   work), time/money costs, tools, people and companies, and assembles a specific, schedulable spec.
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { isOfflineModel } from "@/server/env";
import { anthropicStructured } from "@/server/llm/anthropic";
import { OFFLINE_MODEL } from "@/server/llm/offline";
import { hash32, normalizeWhitespace, splitSentences, truncate } from "@/server/llm/text";
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
  const requireApprovalFor = [...new Set(["send_external_email", ...spec.requireApprovalFor])];
  const weekly =
    spec.weeklyHoursSaved > 0
      ? spec.weeklyHoursSaved
      : Math.round(spec.workflows.reduce((n, w) => n + w.hoursSavedPerRun * runsPerWeek(w.trigger), 0) * 10) / 10;
  return agentSpec.parse({ ...spec, tools, channels, requireApprovalFor, weeklyHoursSaved: Math.min(400, weekly) });
}

// ───────────────────────────────────────────── heuristic extractor ─────────────────────────────────────────────

type Vertical = { id: string; label: string; re: RegExp; noun: string; customers: string };

const VERTICALS: Vertical[] = [
  { id: "promo", label: "Promotional products distribution", re: /promotional products?|promo products?|\bswag\b|branded merch\w*|distributorship/gi, noun: "products", customers: "corporate buyers" },
  { id: "insurance", label: "Insurance", re: /insurance|\bpolic(?:y|ies)\b|policyholders?|\binsureds?\b|\bcarriers?\b|premiums?|agency management software/gi, noun: "policies", customers: "agencies and policyholders" },
  { id: "design", label: "Design & branding agency", re: /design agency|brand assets|branding|graphic design/gi, noun: "brand assets", customers: "brand clients" },
  { id: "legal", label: "Legal services", re: /law firm|attorneys?|lawyers?|paralegals?|case files?|\blegal\b/gi, noun: "matters", customers: "clients" },
  { id: "dental", label: "Dental & medical practice", re: /dental|dentists?|hygienists?|patients?|clinic|med ?spa/gi, noun: "appointments", customers: "patients" },
  { id: "home", label: "Home services (HVAC, plumbing, electrical)", re: /hvac|plumb\w*|furnaces?|air condition\w*|technicians?|\btechs?\b|dispatch\w*|service calls?|work orders?|heating/gi, noun: "jobs", customers: "homeowners" },
  { id: "realestate", label: "Real estate & property management", re: /real estate|listings?|realtors?|brokerage|showings?|tenants?|property manage\w*/gi, noun: "listings", customers: "owners and tenants" },
  { id: "accounting", label: "Accounting & bookkeeping", re: /bookkeep\w*|accounting|\bcpa\b|reconcil\w*|month[- ]end|receipts|quickbooks|\bxero\b|cash (?:report|flow)/gi, noun: "client books", customers: "small-business clients" },
  { id: "ecommerce", label: "E-commerce", re: /shopify|e-?commerce|online store|\bskus?\b|inventory/gi, noun: "orders", customers: "shoppers" },
  { id: "restaurant", label: "Restaurants & hospitality", re: /restaurants?|menus?|reservations?|catering/gi, noun: "orders", customers: "guests" },
  { id: "marketing", label: "Marketing agency", re: /marketing agency|\bseo\b|ad campaigns?|social media management/gi, noun: "campaigns", customers: "brands" },
  { id: "recruiting", label: "Recruiting & staffing", re: /recruit\w*|candidates?|staffing|job postings?/gi, noun: "candidates", customers: "hiring managers" },
  { id: "construction", label: "Construction & contracting", re: /construction|general contractor|subcontractors?|takeoffs?/gi, noun: "bids", customers: "project owners" },
];

type Archetype = {
  id: string;
  re: RegExp;
  role: string;
  workflowName: (v: Vertical | null) => string;
  /** Default hours/week of human time when the call gives no number. */
  defaultHoursPerWeek: number;
  trigger: WorkflowSpec["trigger"];
  outputKind: WorkflowSpec["outputKind"];
  deliverTo: WorkflowSpec["deliverTo"];
  tools: string[];
  approvals: string[];
  procedure: (v: Vertical | null, ctx: Ctx) => string[];
  knowledge: (v: Vertical | null) => Array<{ title: string; why: string }>;
  questions: (v: Vertical | null, ctx: Ctx) => string[];
  overnight: (v: Vertical | null, ctx: Ctx) => { title: string; description: string; instructions: string };
  resale: (v: Vertical | null, ctx: Ctx) => string;
  summaryVerb: string;
};

type Ctx = { orgName: string; tools: string[]; people: string[]; primaryHours: number | null };

const toolsList = (ctx: Ctx, fallback: string) => (ctx.tools.length ? ctx.tools.slice(0, 3).join(", ") : fallback);

const ARCHETYPES: Archetype[] = [
  {
    id: "quoting",
    re: /\bquot(?:e|es|ing)\b|proposals?|\bbids?\b|\bestimates\b|presentations?/gi,
    role: "Quoting Specialist",
    workflowName: (v) => (v?.id === "promo" ? "Quote & product presentation builder" : "Quote builder"),
    defaultHoursPerWeek: 8,
    trigger: { type: "event", event: "email.received" },
    outputKind: "document",
    deliverTo: ["portal", "email"],
    tools: ["knowledge_search", "http_fetch", "create_deliverable", "send_message", "request_approval"],
    approvals: ["send_external_email"],
    procedure: (v, ctx) => [
      `Read the incoming request (email or portal) and extract: customer, contact, ${v?.id === "promo" ? "item types, quantities, imprint/logo details, in-hands date" : "scope, quantities, deadline"}, budget.`,
      `Search the knowledge base for matching ${v?.noun ?? "products and services"}; pick 3–5 options across good/better/best price points.`,
      `Price each option from the latest price list (apply the standard margin and any customer-specific pricing in memory); note lead times and minimums.`,
      `Build the quote as a document: a short intro, then a GFM table (option, description, unit price, quantity, total, lead time), then terms.`,
      `Draft the reply email to the customer with the quote attached as a summary; request approval before sending it externally.`,
      `Log the quote (customer, value, date) to memory so follow-ups and repeat orders are faster.`,
      `If anything is missing (quantity, date, artwork), ask the owner one specific question in the portal instead of guessing.${ctx.tools.length ? ` Use ${toolsList(ctx, "")} where the data lives.` : ""}`,
    ],
    knowledge: (v) => [
      { title: v?.id === "promo" ? "Supplier catalogs and current price lists" : "Price list / rate card", why: "Every quote line is priced from it." },
      { title: "Two or three past quotes the owner was proud of", why: "Sets the format, tone and margin the agent should match." },
      { title: "Standard terms, minimums and lead times", why: "Quotes must state them correctly." },
    ],
    questions: (v) => [
      `Which ${v?.id === "promo" ? "supplier catalogs" : "price lists"} should quotes pull from, and what margin do you apply by default?`,
      "Who must approve a quote before it goes to a customer, and is there a dollar threshold?",
      "Where do quote requests arrive today (a shared inbox, a web form, phone)?",
    ],
    overnight: (v, ctx) => ({
      title: v?.id === "promo" ? "Your quote kit: template + 3 ready-to-send sample quotes" : "Your quote kit: template + 3 sample quotes",
      description: `Overnight, ${ctx.orgName}'s new quoting specialist turns the discovery call into a reusable quote template, a pricing checklist and three realistic sample quotes in your format — so the ${ctx.primaryHours ? `~${Math.round(ctx.primaryHours)} hours a week of` : "hours spent on"} quote-building starts shrinking on day one.`,
      instructions: [
        "Using the discovery call transcript in the knowledge base and anything you remember about this business:",
        `1. Write a one-page quote template for ${ctx.orgName} (intro, options table, terms) in markdown.`,
        `2. Build three sample quotes for the kinds of requests described on the call, each with a GFM table of 3–5 ${v?.noun ?? "line items"} (description, unit price placeholder, quantity, total, lead time).`,
        "3. List the exact data you still need (catalogs, price lists, margins) to fill real prices, as a checklist.",
        "4. Deliver it as one document titled with today's date. Lead with the time it will save per week.",
      ].join("\n"),
    }),
    resale: (v, ctx) =>
      v?.id === "promo"
        ? `Give ${ctx.orgName}'s corporate buyers a self-serve "quote desk": they request branded merchandise in a white-labeled portal and get an instant, on-brand quote. Sell it as a premium tier or use it to win larger accounts.`
        : `Package the quote builder as a self-serve quote desk for ${ctx.orgName}'s customers (white-labeled portal), sold as a premium tier.`,
    summaryVerb: "builds customer quotes and presentations",
  },
  {
    id: "migration",
    re: /migrat\w*|switch(?:ing)? over|bring (?:all )?(?:of )?(?:this|the|their) data|data entry|typ(?:e|ing) (?:them|it|records) into|pulling records|click(?:s|ing)? into (?:all )?(?:of )?(?:the )?(?:different )?fields|re-?key\w*|copy(?:ing)? and past\w*|scrap(?:e|ing) agent/gi,
    role: "Data Migration Specialist",
    workflowName: (v) => (v?.id === "insurance" ? "Overnight policy & insured data migration" : "Overnight data migration"),
    defaultHoursPerWeek: 10,
    trigger: { type: "manual" },
    outputKind: "table",
    deliverTo: ["portal", "email"],
    tools: ["knowledge_search", "computer_screenshot", "computer_click", "computer_type", "computer_key", "create_deliverable", "request_approval"],
    approvals: ["write_client_system"],
    procedure: (v) => [
      `Open the source system on your computer and sign in with the credentials stored for this customer.`,
      `For each ${v?.id === "insurance" ? "insured and policy (named insured, policy number, carrier, effective/expiration dates, premium, coverages)" : "record"}, click into every field and capture the values.`,
      "Normalize the data to the target system's field map (dates ISO-8601, money as numbers, names split first/last).",
      "Validate: flag duplicates, missing required fields and values that do not match the field map.",
      "Produce a GFM table of migrated records plus an exceptions table that needs a human.",
      "Request approval before writing records into the target system; then import and spot-check 5 records against the source.",
      "Report totals (records moved, exceptions, time taken) in the morning summary.",
    ],
    knowledge: (v) => [
      { title: "Target system field map", why: "Defines where every source field goes." },
      { title: v?.id === "insurance" ? "Source agency-management system access (test account)" : "Source system access (test account)", why: "The agent works through the UI like a person would." },
      { title: "A sample export or 10 example records", why: "Lets the agent verify its mapping before the full run." },
    ],
    questions: () => [
      "Which source systems do customers usually migrate from, and can we get a test login for one?",
      "What is the target field map, and which fields are required?",
      "Who signs off on a migration before records are written to production?",
    ],
    overnight: (v, ctx) => ({
      title: "Migration playbook + field map draft",
      description: `By morning ${ctx.orgName} gets a draft field map and a step-by-step migration runbook the agent will follow, so the first real migration (a job that used to be billed at ~$10K) can run overnight this week.`,
      instructions: [
        "From the discovery call and knowledge base:",
        `1. Draft the field map as a GFM table (source field → target field → transform → required?) for ${v?.id === "insurance" ? "insureds and policies" : "the records discussed"}.`,
        "2. Write the overnight runbook: login, navigation, extraction order, validation rules, exception handling, approval checkpoint.",
        "3. Estimate run time and cost versus the manual process quoted on the call.",
        "4. List exactly what access and sample data you need to run the first migration.",
      ].join("\n"),
    }),
    resale: (v, ctx) =>
      `Sell "migration in a night" to ${ctx.orgName}'s own customers: when a customer switches from a competitor, the agent moves their ${v?.id === "insurance" ? "policies and insureds" : "data"} overnight. Charge per migration (it replaces a manual job billed at ~$10K) or bundle it into onboarding.`,
    summaryVerb: "moves customer data between systems overnight",
  },
  {
    id: "catalog",
    re: /scrap(?:e|es|ing)\b|catalogs?|product (?:data|feeds?|categories)|price lists?|supplier (?:sites?|portals?)|categories/gi,
    role: "Catalog & Pricing Analyst",
    workflowName: () => "Nightly catalog & pricing sync",
    defaultHoursPerWeek: 5,
    trigger: { type: "schedule", cron: "0 2 * * 1-5", label: "Weeknights at 2:00 AM" },
    outputKind: "table",
    deliverTo: ["portal"],
    tools: ["http_fetch", "knowledge_search", "memory_save", "create_deliverable"],
    approvals: [],
    procedure: (v) => [
      `Fetch each supplier catalog page / feed listed in the knowledge base (public pages only, via http_fetch).`,
      `Extract ${v?.id === "promo" ? "product name, SKU, category, decoration methods, minimums, price breaks" : "item, SKU, category, price"} for every item.`,
      "Compare with yesterday's snapshot in memory: new items, discontinued items, price changes above 3%.",
      "Save the new snapshot summary to memory.",
      "Deliver a GFM table of changes (item, category, old price, new price, change %) with the biggest changes first.",
    ],
    knowledge: () => [
      { title: "List of supplier catalog URLs / feeds", why: "The nightly sync reads them." },
      { title: "Category taxonomy you use", why: "Keeps products grouped the way you sell them." },
    ],
    questions: () => ["Which suppliers matter most, and do any require a login to see pricing?"],
    overnight: (v, ctx) => ({
      title: "Catalog snapshot by category",
      description: `A clean, categorized snapshot of ${ctx.orgName}'s key supplier catalogs, ready to quote from.`,
      instructions: `Fetch the supplier catalogs in the knowledge base and produce a GFM table per category of ${v?.noun ?? "items"} with price breaks and minimums. Note gaps you could not fetch.`,
    }),
    resale: (_v, ctx) => `Offer ${ctx.orgName}'s customers a live, branded product catalog with current pricing as a portal add-on.`,
    summaryVerb: "keeps the catalog and pricing current overnight",
  },
  {
    id: "invoicing",
    re: /invoic\w*|billing|accounts receivable|payment reminders?|past[- ]due/gi,
    role: "Billing Coordinator",
    workflowName: () => "Invoice prep & payment follow-up",
    defaultHoursPerWeek: 4,
    trigger: { type: "schedule", cron: "0 7 * * 1-5", label: "Weekdays at 7:00 AM" },
    outputKind: "document",
    deliverTo: ["portal", "email"],
    tools: ["knowledge_search", "memory_recall", "create_deliverable", "send_message", "request_approval"],
    approvals: ["send_invoice", "send_external_email"],
    procedure: () => [
      "List orders/jobs completed since the last run that do not have an invoice yet.",
      "Draft each invoice (customer, line items, quantities, prices, tax, terms) from the order and the price list.",
      "List invoices that are past due, with days outstanding, and draft a polite reminder for each.",
      "Deliver a document: invoices ready to send (GFM table with totals), reminders drafted, and anything that needs the owner.",
      "Request approval before any invoice or reminder is sent to a customer.",
    ],
    knowledge: () => [{ title: "Invoice template and payment terms", why: "Invoices must match your format and terms." }],
    questions: () => ["Which system issues invoices today, and may the agent create drafts there?"],
    overnight: (_v, ctx) => ({
      title: "Receivables snapshot",
      description: `A clear view of what ${ctx.orgName} is owed and the reminder emails to send, ready for approval.`,
      instructions: "Build a GFM table of open and past-due invoices you can find in the knowledge base, with drafted reminders and the total outstanding.",
    }),
    resale: (_v, ctx) => `Offer ${ctx.orgName}'s customers automated statements and payment reminders under their brand.`,
    summaryVerb: "preps invoices and chases payments",
  },
  {
    id: "dispatch",
    re: /dispatch\w*|technician schedule|schedul(?:e|ing) (?:the )?(?:techs?|technicians|crews?)|route(?:s|ing)?\b|voicemails?/gi,
    role: "Dispatch Coordinator",
    workflowName: () => "Morning dispatch board",
    defaultHoursPerWeek: 6,
    trigger: { type: "schedule", cron: "30 5 * * 1-6", label: "Mon–Sat at 5:30 AM" },
    outputKind: "table",
    deliverTo: ["portal", "sms"],
    tools: ["knowledge_search", "memory_recall", "create_deliverable", "send_message"],
    approvals: [],
    procedure: () => [
      "Collect new service requests from overnight voicemails, emails and web forms.",
      "Classify each by urgency (no heat/no cooling first), job type, and estimated duration.",
      "Assign jobs to technicians by skill, location and existing appointments; leave buffer for emergencies.",
      "Deliver the dispatch board as a GFM table (time, customer, address area, job, tech, notes).",
      "Text each technician their first job and the owner a one-line summary.",
    ],
    knowledge: () => [{ title: "Technician roster, skills and service areas", why: "Needed to assign jobs correctly." }],
    questions: () => ["Which system holds today's appointments, and can the agent read it?"],
    overnight: (_v, ctx) => ({
      title: "Tomorrow's dispatch board, pre-built",
      description: `${ctx.orgName} wakes up to tomorrow's jobs already sorted by urgency and assigned to techs.`,
      instructions: "Build tomorrow's dispatch board as a GFM table from the requests in the knowledge base and memory; flag anything you could not assign.",
    }),
    resale: (_v, ctx) => `Package the dispatcher for other contractors ${ctx.orgName} partners with.`,
    summaryVerb: "builds the daily dispatch board",
  },
  {
    id: "followup",
    re: /follow(?:ing)?[- ]?ups?\b|follow up on|leads?\b|prospects?|outreach|unsigned estimates|chas(?:e|ing) (?:clients|customers|people)/gi,
    role: "Customer Follow-up Specialist",
    workflowName: () => "Lead & estimate follow-up",
    defaultHoursPerWeek: 4,
    trigger: { type: "schedule", cron: "0 8 * * 1-5", label: "Weekdays at 8:00 AM" },
    outputKind: "email_draft",
    deliverTo: ["portal", "email"],
    tools: ["knowledge_search", "memory_recall", "create_deliverable", "send_message", "request_approval", "schedule_followup"],
    approvals: ["send_external_email"],
    procedure: () => [
      "List open leads, quotes and estimates with no reply in 3+ days (from memory and the knowledge base).",
      "For each, draft a short, personal follow-up that references what they asked for.",
      "Prioritize by value and how warm the lead is; schedule a second follow-up for 4 days later.",
      "Deliver the drafts as one document with a GFM table (contact, value, last touch, next step).",
      "Request approval before sending anything externally.",
    ],
    knowledge: () => [{ title: "List of open quotes / estimates / leads", why: "The follow-ups are drafted from it." }],
    questions: () => ["How many follow-ups should a lead get before we stop, and from whose email should they go?"],
    overnight: (_v, ctx) => ({
      title: "Follow-up queue with drafted emails",
      description: `Every open lead ${ctx.orgName} mentioned, with a drafted follow-up ready to approve.`,
      instructions: "Build the follow-up queue as a GFM table and draft one email per lead from the call details.",
    }),
    resale: (_v, ctx) => `Offer ${ctx.orgName}'s customers a done-for-you follow-up assistant as an add-on.`,
    summaryVerb: "follows up on every open lead and estimate",
  },
  {
    id: "reporting",
    re: /\breports?\b|dashboards?|metrics|\bkpis?\b|weekly update|cash report|numbers/gi,
    role: "Operations Analyst",
    workflowName: () => "Monday performance report",
    defaultHoursPerWeek: 2,
    trigger: { type: "schedule", cron: "0 6 * * 1", label: "Mondays at 6:00 AM" },
    outputKind: "report",
    deliverTo: ["portal", "email"],
    tools: ["knowledge_search", "memory_recall", "create_deliverable"],
    approvals: [],
    procedure: () => [
      "Gather last week's numbers from the knowledge base and memory (volume, revenue, open items).",
      "Compare with the prior week and the same week last month; flag changes over 10%.",
      "Write a one-page report: headline, a GFM table of key metrics with week-over-week change, three things to act on.",
      "Deliver to the portal and email the owner.",
    ],
    knowledge: () => [{ title: "Where your weekly numbers live (exports, spreadsheet, system access)", why: "The report is built from it." }],
    questions: () => ["Which 5 numbers do you look at every week?"],
    overnight: (_v, ctx) => ({
      title: "Baseline operations report",
      description: `A first one-page baseline of ${ctx.orgName}'s operations from what we learned on the call.`,
      instructions: "Write a one-page baseline report with a GFM table of the metrics mentioned on the call and what to track weekly.",
    }),
    resale: (_v, ctx) => `Offer ${ctx.orgName}'s customers a branded weekly report as a retention perk.`,
    summaryVerb: "writes the weekly performance report",
  },
  {
    id: "inbox",
    re: /\binbox\b|drafting replies|email (?:replies|triage)|respond(?:ing)? to emails|calendar|executive assistant/gi,
    role: "Executive Assistant",
    workflowName: () => "Inbox triage & reply drafts",
    defaultHoursPerWeek: 3,
    trigger: { type: "event", event: "email.received" },
    outputKind: "email_draft",
    deliverTo: ["portal", "email"],
    tools: ["knowledge_search", "memory_recall", "memory_save", "create_deliverable", "send_message", "request_approval"],
    approvals: ["send_external_email"],
    procedure: () => [
      "Read each new email and classify it: needs owner, can be answered from knowledge, FYI, spam.",
      "Draft replies for anything answerable from the knowledge base and memory, in the owner's voice.",
      "Pull out dates and meeting requests and propose calendar slots.",
      "Deliver a morning digest: a GFM table (from, subject, category, suggested action) plus the drafts.",
      "Request approval before any reply goes out.",
    ],
    knowledge: () => [{ title: "FAQ / canned answers you send often", why: "Lets the agent draft accurate replies." }],
    questions: () => ["Which inbox should the agent watch, and which senders always go straight to you?"],
    overnight: (_v, ctx) => ({
      title: "Inbox playbook + top reply templates",
      description: `${ctx.orgName}'s most common emails, each with a reply template in your voice.`,
      instructions: "Write the inbox playbook: categories, routing rules and 5 reply templates based on the call.",
    }),
    resale: (_v, ctx) => `Offer ${ctx.orgName}'s customers an AI front desk that answers routine email under their brand.`,
    summaryVerb: "triages the inbox and drafts replies",
  },
  {
    id: "reviews",
    re: /\breviews?\b|reputation|testimonials?/gi,
    role: "Reputation Manager",
    workflowName: () => "Review requests & responses",
    defaultHoursPerWeek: 2,
    trigger: { type: "schedule", cron: "0 17 * * 1-5", label: "Weekdays at 5:00 PM" },
    outputKind: "email_draft",
    deliverTo: ["portal"],
    tools: ["knowledge_search", "create_deliverable", "send_message", "request_approval"],
    approvals: ["send_external_email"],
    procedure: () => [
      "List customers whose job/order completed today and draft a short review request for each.",
      "Draft responses to any new reviews (thank positive ones by name; offer to make negative ones right).",
      "Deliver the drafts in one document; request approval before sending.",
    ],
    knowledge: () => [{ title: "Links to your review profiles", why: "Requests must point to the right place." }],
    questions: () => ["Which review sites matter most to you?"],
    overnight: (_v, ctx) => ({
      title: "Review request templates",
      description: `Review request and response templates in ${ctx.orgName}'s voice.`,
      instructions: "Write 3 review request templates and 4 response templates (positive, neutral, negative, no-text).",
    }),
    resale: (_v, ctx) => `Bundle review management for ${ctx.orgName}'s customers.`,
    summaryVerb: "asks for and answers reviews",
  },
];

const KNOWN_TOOLS = [
  "Salesforce", "HubSpot", "QuickBooks", "Xero", "Excel", "Google Sheets", "Google Drive", "Gmail", "Outlook", "Slack", "Shopify",
  "Canva", "Instagram", "LinkedIn", "Zapier", "ServiceTitan", "Housecall Pro", "Jobber", "Applied Epic", "EZLynx", "HawkSoft",
  "Dentrix", "Clio", "Asana", "Trello", "Notion", "Airtable", "Stripe", "Square", "SAGE", "ESP", "SAGE World", "commonsku", "DocuSign",
  "Calendly", "Zoom", "Teams", "Claude", "ChatGPT", "Orgo",
];
/** Assistants and chat/channel apps are not "systems the agent works in". */
const IGNORE_TOOLS = new Set(["Claude", "ChatGPT", "Orgo", "Zoom", "Instagram", "LinkedIn", "Slack", "Gmail", "Outlook", "Teams"]);

const NAMES = ["Maya", "Quinn", "Theo", "Iris", "Jonah", "Nora", "Eli", "Ava", "Rhea", "Milo", "Tess", "Owen", "Lena", "Sage"];

const HOURS_RE =
  /(\d+(?:\.\d+)?|a couple(?: of)?|a few|several|an?|one|two|three|four|five|six|eight|ten|twelve|fifteen|twenty|thirty|forty)\s*(?:-|to)?\s*(?:\d+\s*)?(?:hours?|hrs?)\s+(?:a|per|each|every)\s+(week|day|month)/i;
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  "a couple": 2, "a couple of": 2, "a few": 3, several: 4,
};
const PAIN_RE =
  /by hand|manually|(?:had|has|have|need) to (?:scrape|create|build|put|type|copy|pull|enter|send|chase|call|update|go)|repetitive|boring|tedious|takes (?:me|us|them|like|about|forever)|spend(?:s|ing)? (?:about |like )?\d|all day|every (?:morning|night|week|monday|day)|itch|copy and paste|typing|pulling|chas(?:e|ing)|hours? a (?:week|day)|weeks|overnight|\$\s?\d|\d+\s?(?:k|grand|thousand)\b/gi;

function cleanTranscript(raw: string): string {
  let t = raw.replace(/^---[\s\S]*?\n---\n/, ""); // frontmatter
  const marker = t.search(/^##\s+Transcript\s*$/im);
  if (marker >= 0) t = t.slice(marker);
  return t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\\[[^\]]*\\\]/g, " ")
    .replace(/\[(?:music|laughter|applause|crosstalk|inaudible)\]/gi, " ")
    .replace(/\*\*\d{1,2}:\d{2}(?::\d{2})?\*\*\s*·?/g, "\n")
    .replace(/^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?)\s*/gm, "")
    .replace(/^#+\s.*$/gm, "")
    .replace(/\b(?:uh|um|you know),?\s+/gi, "")
    .replace(/\b(\w+) \1\b/gi, "$1");
}

function hoursPerWeekIn(s: string): number | null {
  const m = HOURS_RE.exec(s);
  if (!m?.[1] || !m[2]) return null;
  const n = Number.isFinite(Number(m[1])) ? Number(m[1]) : (WORD_NUM[m[1].toLowerCase()] ?? null);
  if (n == null) return null;
  const unit = m[2].toLowerCase();
  return unit === "day" ? n * 5 : unit === "month" ? n / 4.3 : n;
}

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  return (s.match(re) ?? []).length;
}

type Itch = { arch: Archetype; score: number; hoursPerWeek: number | null; evidence: string[]; verticals: Map<string, number> };

export function runsPerWeek(trigger: WorkflowSpec["trigger"]): number {
  if (trigger.type === "manual") return 1;
  if (trigger.type === "event") return 10;
  const parts = trigger.cron.trim().split(/\s+/);
  const dow = parts[4] ?? "*";
  const hours = parts[1] ?? "0";
  const perDay = hours.includes(",") ? hours.split(",").length : 1;
  if (dow === "*") return 7 * perDay;
  if (/^\d-\d$/.test(dow)) {
    const [a, b] = dow.split("-").map(Number) as [number, number];
    return (b - a + 1) * perDay;
  }
  return dow.split(",").length * perDay;
}

function detectVerticals(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of VERTICALS) {
    const n = countMatches(v.re, text);
    if (n) m.set(v.id, n);
  }
  return m;
}

function pickVertical(industry: string | null | undefined, counts: Map<string, number>): Vertical | null {
  if (industry) {
    const hit = VERTICALS.map((v) => ({ v, n: countMatches(v.re, industry) + (industry.toLowerCase().includes(v.label.toLowerCase().split(" ")[0] ?? "\u0000") ? 1 : 0) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)[0];
    if (hit) return hit.v;
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? (VERTICALS.find((v) => v.id === top[0]) ?? null) : null;
}

function extractTools(text: string): string[] {
  const found = KNOWN_TOOLS.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, t === "ESP" || t === "SAGE" ? "" : "i").test(text));
  const out = found.filter((t) => !IGNORE_TOOLS.has(t));
  if (/agency management (?:software|system)/i.test(text) && !out.length) out.push("their agency management system");
  if (/spreadsheets?/i.test(text) && !out.includes("Excel") && !out.includes("Google Sheets")) out.push("spreadsheets");
  return [...new Set(out)];
}

function extractPeople(sentences: string[]): string[] {
  const people: string[] = [];
  const res = [
    /\b(?:his|her|my) name is ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/g,
    /\b(?:this is|I'm|I am) ([A-Z][a-z]+)(?:,| from| and| here)/g,
    /\b(?:my|our) (office manager|bookkeeper|assistant|partner|business partner|wife|husband|dispatcher|operations manager|controller|accountant),? ([A-Z][a-z]+)/g,
    /\b([A-Z][a-z]+),? (?:my|our) (office manager|bookkeeper|assistant|partner|dispatcher|operations manager|controller|accountant)/g,
  ];
  for (const s of sentences) {
    for (const re of res) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const [, a, b] = m;
        if (!a) continue;
        const isRoleFirst = /^[a-z]/.test(a);
        const name = isRoleFirst ? b : a;
        const role = isRoleFirst ? a : b;
        if (!name || /^(?:Hey|Okay|Yeah|Just|So|Well|Like)$/.test(name)) continue;
        people.push(role ? `${name} (${role})` : name);
      }
    }
  }
  return [...new Set(people)].slice(0, 8);
}

function extractCompanies(sentences: string[], orgName: string): string[] {
  const out: string[] = [];
  const re = /\b(?:company|agency|customer|client|firm|business|vendor|supplier) (?:here,? )?called ([A-Z][A-Za-z0-9&]+(?: [A-Z][A-Za-z0-9&]+)?)/g;
  for (const s of sentences) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) if (m[1] && m[1] !== orgName && !IGNORE_TOOLS.has(m[1]) && !/^(?:Anthropic|OpenAI|Google|Y Combinator)$/.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)].slice(0, 6);
}

function evidenceClean(s: string): string {
  return truncate(normalizeWhitespace(s.replace(/^(?:so|and|but|yeah|well|okay|like),?\s+/i, "")), 260);
}

export function heuristicSpec(input: ArchitectInput): AgentSpec {
  const orgName = normalizeWhitespace(input.orgName ?? "") || "the client";
  const text = cleanTranscript(input.transcript);
  const sentences = splitSentences(text).filter((s) => s.length >= 12);
  const allVerticals = detectVerticals(text);
  const vertical = pickVertical(input.industry, allVerticals);
  // Only keep people/companies that appear in context about THIS business (not other examples on the call).
  const onTopic = (i: number) => {
    if (!vertical) return true;
    const w = [sentences[i - 1] ?? "", sentences[i] ?? "", sentences[i + 1] ?? ""].join(" ");
    const vs = detectVerticals(w);
    return vs.size === 0 || vs.has(vertical.id);
  };
  const topicalSentences = sentences.filter((_, i) => onTopic(i));
  const tools = extractTools(topicalSentences.join(" "));
  const people = extractPeople(topicalSentences);
  const companies = extractCompanies(topicalSentences, orgName);
  const ctx: Ctx = { orgName, tools, people, primaryHours: null };

  // Score every sentence for "itch" signal and attribute it to task archetypes (with a ±1 sentence window).
  const itches = new Map<string, Itch>();
  sentences.forEach((s, i) => {
    const window = [sentences[i - 1] ?? "", s, sentences[i + 1] ?? ""].join(" ");
    const windowVerticals = detectVerticals(window);
    // A sentence about a different kind of business (another example on the call) is not this client's itch.
    if (vertical && windowVerticals.size > 0 && !windowVerticals.has(vertical.id)) return;
    const pain = countMatches(PAIN_RE, s);
    const hours = hoursPerWeekIn(s) ?? hoursPerWeekIn(window);
    for (const arch of ARCHETYPES) {
      const hits = countMatches(arch.re, s);
      if (!hits) continue;
      const score = hits + pain * 1.5 + (hours ? 3 : 0);
      const it: Itch = itches.get(arch.id) ?? { arch, score: 0, hoursPerWeek: null, evidence: [], verticals: new Map() };
      it.score += score;
      if (hours && (it.hoursPerWeek == null || hours > it.hoursPerWeek)) it.hoursPerWeek = hours;
      if (pain > 0 || hours) it.evidence.push(s);
      for (const [vid, n] of windowVerticals) it.verticals.set(vid, (it.verticals.get(vid) ?? 0) + n);
      itches.set(arch.id, it);
    }
  });

  // Keep itches that are about this business: tied to the chosen vertical, or vertical-neutral. Rank by signal.
  const ranked = [...itches.values()]
    .filter((it) => it.score >= 2.5 && it.evidence.length > 0)
    .filter((it) => {
      if (!vertical || it.verticals.size === 0) return true;
      if (it.verticals.has(vertical.id)) return true;
      // Mentioned only alongside other verticals → probably someone else's problem.
      return false;
    })
    .map((it) => ({ ...it, score: it.score + (vertical && it.verticals.has(vertical.id) ? 6 : 0) + (it.hoursPerWeek ? it.hoursPerWeek / 2 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (ranked.length === 0) {
    const fallback = ARCHETYPES.find((a) => a.id === "reporting");
    if (fallback) ranked.push({ arch: fallback, score: 1, hoursPerWeek: null, evidence: [], verticals: new Map() });
  }
  const primary = ranked[0]!;
  ctx.primaryHours = primary.hoursPerWeek;

  const workflows: WorkflowSpec[] = ranked.map((it) => {
    const a = it.arch;
    const hoursPerWeek = it.hoursPerWeek ?? a.defaultHoursPerWeek;
    const perRun = Math.max(0.25, Math.round((hoursPerWeek / runsPerWeek(a.trigger)) * 4) / 4);
    const quoted = it.evidence[0] ? evidenceClean(it.evidence[0]) : null;
    const problem = truncate(
      `${quoted ? `On the call: “${quoted}” ` : ""}Today this takes about ${Math.round(hoursPerWeek * 10) / 10} hours a week of manual work.`,
      600,
    );
    const steps = a.procedure(vertical, ctx);
    return {
      name: a.workflowName(vertical),
      problem,
      instructions: truncate(steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), 6000),
      trigger: a.trigger,
      outputKind: a.outputKind,
      deliverTo: a.deliverTo,
      hoursSavedPerRun: Math.min(200, perRun),
      tools: a.tools,
    };
  });

  const weeklyHoursSaved = Math.round(workflows.reduce((n, w) => n + w.hoursSavedPerRun * runsPerWeek(w.trigger), 0) * 10) / 10;
  const name = NAMES[hash32(`${orgName}:${primary.arch.id}`) % NAMES.length]!;
  const verticalLabel = vertical?.label ?? (input.industry ? truncate(input.industry, 80) : "");

  const channels: AgentSpec["channels"] = ["portal", "email"];
  if (/\bslack\b/i.test(text)) channels.push("slack");
  if (/\btext(?:s|ing)? (?:me|it|us|in)|\bsms\b|group chat|text message/i.test(text)) channels.push("sms");

  const verbs = ranked.map((r) => r.arch.summaryVerb);
  const verbList = verbs.length > 1 ? `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}` : (verbs[0] ?? "handles recurring work");
  const summary = truncate(`${name} ${verbList} for ${orgName} — about ${Math.round(weeklyHoursSaved)} hours a week back.`, 280);

  // Seed memories: concrete facts from the call.
  const seedMemories: string[] = [];
  const kindLabel = verticalLabel ? verticalLabel.toLowerCase() : "small";
  seedMemories.push(`${orgName} is ${/^[aeiou]/.test(kindLabel) ? "an" : "a"} ${kindLabel} business${vertical ? ` serving ${vertical.customers}` : ""}.`);
  for (const it of ranked) {
    const hrs = it.hoursPerWeek ?? null;
    if (hrs) seedMemories.push(`${it.arch.workflowName(vertical)}: currently ~${Math.round(hrs * 10) / 10} hours/week of manual work.`);
    for (const e of it.evidence.slice(0, 2)) seedMemories.push(`From the discovery call: “${evidenceClean(e)}”`);
  }
  if (tools.length) seedMemories.push(`Systems and tools mentioned: ${tools.join(", ")}.`);
  for (const p of people) seedMemories.push(`Person mentioned on the call: ${p}.`);
  for (const c of companies) seedMemories.push(`Company mentioned on the call: ${c}.`);
  const workWords = new RegExp(ARCHETYPES.map((a) => a.re.source).join("|") + "|\\bemail|\\btext|morning|approv|slack|phone|spreadsheet", "i");
  for (const s of topicalSentences) {
    if (/\b(?:I|we) (?:prefer|always|never|don't want|do not want|want everything|like to get|need (?:it|them|everything))\b/i.test(s) && s.length < 300 && workWords.test(s))
      seedMemories.push(`Preference from the call: “${evidenceClean(s)}”`);
  }
  if (/slack/i.test(text) && /\d+% of (?:your|my|the) day/i.test(text)) seedMemories.push("Reach people where they already work (email, Slack or text) rather than a new app.");
  const itchEvidence = new Set(ranked.flatMap((r) => r.evidence));
  const money = sentences.filter(
    (s, i) =>
      /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|K)?|\d+\s?(?:grand|thousand)\b/.test(s) &&
      /charge|cost|pay|bill|worth|price|\bfor\b/i.test(s) &&
      (itchEvidence.has(s) || itchEvidence.has(sentences[i - 1] ?? "") || itchEvidence.has(sentences[i + 1] ?? "") || ranked.some((r) => countMatches(r.arch.re, s) > 0)),
  );
  for (const s of money.slice(0, 3)) seedMemories.push(`Pricing/value mentioned: “${evidenceClean(s)}”`);

  const knowledgeNeeds = dedupeBy(ranked.flatMap((r) => r.arch.knowledge(vertical)), (k) => k.title).slice(0, 12);
  const openQuestions = dedupeBy(
    [
      ...ranked.flatMap((r) => r.arch.questions(vertical, ctx)),
      `Who at ${orgName} should receive the morning deliverables, and by what time?`,
      tools.length ? `Can we get read access to ${tools.slice(0, 2).join(" and ")} for the agent?` : "Which systems hold the data the agent needs, and can it get read access?",
    ],
    (q) => q,
  ).slice(0, 10);

  const requireApprovalFor = [...new Set(["send_external_email", ...ranked.flatMap((r) => r.arch.approvals)])];
  const specTools = [...new Set(["knowledge_search", "memory_recall", "memory_save", "create_deliverable", "send_message", "request_approval", "schedule_followup", ...workflows.flatMap((w) => w.tools)])];

  const role = primary.arch.role;
  const first = primary.arch.overnight(vertical, ctx);
  const resaleEvidence =
    topicalSentences.find((s) => /package (?:this|it) up|sell (?:this|it) to (?:your|their) (?:own )?customers|resell/i.test(s)) ??
    topicalSentences.find((s) => s.length > 40 && /revenue stream|b ?to ?b ?to ?b|b2b2b/i.test(s));
  const resaleIdea = truncate(
    `${primary.arch.resale(vertical, ctx)}${resaleEvidence ? ` (The call points this way: “${evidenceClean(resaleEvidence)}”)` : ""}`,
    600,
  );

  const instructions = [
    `You are ${name}, ${role} at ${orgName}${verticalLabel ? ` (${verticalLabel.toLowerCase()})` : ""}. You were hired to take repetitive, hours-a-week work off the owner's plate and deliver it finished.`,
    "",
    "## Your responsibilities",
    ...workflows.map((w) => `- **${w.name}** — ${triggerLabel(w.trigger)}. ${truncate(w.problem.replace(/^On the call: “[^”]*”\s*/, ""), 200)}`),
    "",
    "## How you work",
    "- Be proactive: deliver finished work (documents, GFM tables, email drafts), not questions. If one detail is missing, make a sensible assumption, label it, and keep going.",
    "- Ground everything in the knowledge base and your memory. Never invent prices, policy details or customer data — mark unknowns clearly.",
    `- Anything that leaves the building (emails to customers, invoices, changes in client systems) goes through request_approval first.`,
    "- Save new facts and preferences you learn to memory so you get better every week.",
    "- Lead every deliverable with the result and the time it saved.",
    tools.length ? `- Systems you will work with: ${tools.join(", ")}.` : null,
    people.length ? `- People: ${people.join("; ")}.` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const spec: AgentSpec = {
    name,
    role,
    summary,
    vertical: verticalLabel,
    instructions: truncate(instructions, 12000),
    voice: `Warm, concise and specific, like a sharp ${role.toLowerCase()} who knows ${verticalLabel ? verticalLabel.toLowerCase() : "the business"}. Leads with the result and the time saved; no jargon.`,
    workflows,
    knowledgeNeeds,
    seedMemories: dedupeBy(seedMemories, (s) => s).map((s) => truncate(s, 500)).slice(0, 40),
    channels,
    tools: specTools,
    requireApprovalFor,
    firstDeliverable: {
      title: truncate(first.title, 120),
      description: truncate(first.description, 600),
      instructions: truncate(first.instructions, 4000),
    },
    resaleIdea,
    weeklyHoursSaved: Math.min(400, weeklyHoursSaved),
    openQuestions,
  };
  return agentSpec.parse(spec);
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
  if (t.type === "event") return `whenever ${t.event.replace(".", " is ").replace("_", " ")}`;
  return t.label ? t.label.toLowerCase() : `on schedule (${t.cron})`;
}
