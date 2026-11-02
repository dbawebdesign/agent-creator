/**
 * Resale (B2B2B): what a customer's copy of an agent may carry from the reseller's agent — the job (role, voice,
 * workflows), never the reseller's business: its people, accounts, patients, pets and customers, its rules, files it
 * did not share, or a role written for its own industry (product critique r3 C3 / r4 H-4, security critique r3 M3).
 */
import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { agentSpec, type AgentSpec } from "@/server/agents/spec";
import { schema, type DB } from "@/server/db/client";
import { truncate } from "@/server/llm/text";

/** What belongs to the reseller's own business. */
export type ResalePrivate = {
  /** Its people (members, contacts, people its agent learned about): written as "the team". */
  people: string[];
  /** Other names from its memories, rules, contacts and unshared knowledge (accounts, patients, pets): sentences naming them are dropped. */
  terms: string[];
  /** Its rules (approval and hard rules): sentences restating them are dropped. */
  rules: string[];
  /** Titles of knowledge it did not share: a procedure that reads one points to the team's file instead. */
  unsharedFiles: string[];
};

export type ResaleParties = { customerName: string; resellerName: string; customerIndustry?: string | null; resellerIndustry?: string | null };

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ABBREV_RE = /\b(?:St|Dr|Mr|Mrs|Ms|Mx|Mt|Jr|Sr|Ave|Rd|Blvd|No|vs|approx|etc|e\.g|i\.e|Inc|Co|Ltd)\.$/i;

/** Capitalized words that are not anyone's private name: calendar words, common software, the platform itself. */
const NOT_PRIVATE = new Set(
  (
    "monday mondays tuesday tuesdays wednesday wednesdays thursday thursdays friday fridays saturday saturdays sunday sundays " +
    "january february march april may june july august september october november december " +
    "slack google gmail outlook microsoft teams excel word sheets docs drive dropbox box zoom calendly notion airtable asana trello monday.com " +
    "quickbooks xero freshbooks gusto adp stripe square paypal venmo zelle shopify etsy amazon ebay woocommerce hubspot salesforce mailchimp " +
    "klaviyo twilio resend docusign yelp facebook instagram linkedin tiktok youtube whatsapp imessage apple android iphone ios windows mac " +
    "jobber servicetitan housecall pro avimark cornerstone ezyvet dentrix eaglesoft opendental epic athena kareo clio mycase appfolio buildium " +
    "yardi toast opentable resy ups fedex usps dhl csv pdf sms api mcp portal studio roster agent approval approvals knowledge base team " +
    "business profile review reviews calendar inbox invoice invoices report reports dashboard form forms policy schedule " +
    "i im i'm ok okay am pm"
  ).split(/\s+/),
);

/** Replace the reseller's people with "the team" (possessives too). */
export function withoutPeople(text: string, people: string[], agentName: string): string {
  const tokens = [...new Set(people.flatMap((p) => [p.trim(), p.trim().split(/\s+/).find((w) => !/^(?:dr|mr|mrs|ms|mx)\.?$/i.test(w)) ?? ""]))]
    .filter((t) => t.length >= 3 && t.toLowerCase() !== agentName.toLowerCase())
    .sort((a, b) => b.length - a.length);
  if (!tokens.length) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:Dr|Mr|Mrs|Ms|Mx)\\.\\s+)?(?:${tokens.map(escapeRe).join("|")})(?:['’]s)?(?![\\p{L}\\p{N}])`, "gu");
  return text.replace(re, (m) => (/['’]s$/.test(m) ? "the team's" : "the team"));
}

/** Is the word at `index` the first of its sentence, line, list item or quote? (Capitals there prove nothing.) */
function isInitial(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const gap = /[\s*_“"'‘(\[]*$/.exec(before)?.[0] ?? "";
  if (gap.includes("\n")) return true;
  const prev = before.slice(0, before.length - gap.length);
  if (!prev.trim()) return true;
  if (/[“"‘(]$/.test(before.trimEnd()) || /[“"‘(]/.test(gap)) return true;
  if (ABBREV_RE.test(prev)) return false;
  return /[.!?:;—–\-•]$/.test(prev) || /(?:^|\n)\s*\d+[.)]$/.test(prev);
}

type Cap = { word: string; index: number; initial: boolean };

/** Every capitalized word (not an abbreviation, not an all-caps code) with whether it starts its sentence. */
function capitalizedWords(text: string): Cap[] {
  const out: Cap[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])\p{Lu}[\p{L}’'-]*(?![\p{L}\p{N}_])/gu)) {
    const word = m[0].replace(/['’]s$/, "").replace(/[-'’]+$/, "");
    if (word.length < 3 || word === word.toUpperCase() || NOT_PRIVATE.has(word.toLowerCase())) continue;
    if (/^(?:St|Dr|Mr|Mrs|Ms|Mx|Mt|Jr|Sr)$/.test(word) && text[m.index! + m[0].length] === ".") continue;
    out.push({ word, index: m.index!, initial: isInitial(text, m.index!) });
  }
  return out;
}

/** Does `word` appear in `text` where a capital means a name (not at the start of a sentence)? */
function namedIn(text: string, word: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(word)}(?![\\p{L}\\p{N}_])`, "gu");
  for (const m of text.matchAll(re)) if (!isInitial(text, m.index!)) return true;
  return false;
}

/** The text of a cloned spec that a customer will see from the reseller: workflow names, procedures and the voice. */
function carriedText(spec: AgentSpec): string {
  return [spec.voice, ...spec.workflows.flatMap((w) => [w.name, w.instructions])].join("\n");
}

/**
 * Collect the reseller's private names for a cloned spec: its people, and every other capitalized name in the spec's
 * workflows or voice that its memories, rules, contacts or unshared knowledge rows also name.
 */
export async function resalePrivate(
  database: DB,
  input: { orgId: string; agentId: string; spec: AgentSpec; sharedSourceIds: string[]; customerName: string },
): Promise<ResalePrivate> {
  const { orgId, agentId } = input;
  const [members, mems, contacts, sources] = await Promise.all([
    database
      .select({ name: schema.users.name })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.orgId, orgId))
      .limit(500),
    database
      .select({ kind: schema.memories.kind, content: schema.memories.content })
      .from(schema.memories)
      .where(and(eq(schema.memories.orgId, orgId), eq(schema.memories.agentId, agentId)))
      .limit(1000),
    database.select({ name: schema.contacts.name }).from(schema.contacts).where(eq(schema.contacts.orgId, orgId)).limit(500),
    database
      .select({ id: schema.knowledgeSources.id, title: schema.knowledgeSources.title })
      .from(schema.knowledgeSources)
      .where(and(eq(schema.knowledgeSources.orgId, orgId), or(eq(schema.knowledgeSources.agentId, agentId), isNull(schema.knowledgeSources.agentId))))
      .limit(500),
  ]);
  const people = [
    ...members.map((m) => m.name),
    ...contacts.map((c) => c.name),
    ...mems.filter((m) => m.kind === "person" || /^Person/.test(m.content)).map((m) => /^Person(?: mentioned on the call)?:\s*([^(.,]+)/.exec(m.content)?.[1] ?? null),
  ]
    .filter((n): n is string => !!n && n.trim().length >= 2)
    .map((n) => n.trim());
  const rules = mems
    .filter((m) => /^(?:approval rule|hard rule)/i.test(m.content))
    .map((m) => /“([^”]+)”/.exec(m.content)?.[1] ?? m.content.replace(/^[^:]+:\s*/, ""))
    .filter((r) => r.trim().length >= 12);
  const shared = new Set(input.sharedSourceIds);
  const unshared = sources.filter((s) => !shared.has(s.id));

  // Systems the business named are tools, not private names.
  const systems = new Set(
    mems
      .flatMap((m) => /^Systems(?: and tools)? mentioned:\s*(.+)$/i.exec(m.content)?.[1]?.split(/[,;]|\band\b/) ?? [])
      .map((s) => s.trim().replace(/\.$/, "").toLowerCase())
      .filter(Boolean),
  );
  const own = new Set([...input.customerName.split(/\s+/), input.spec.name].map((w) => w.toLowerCase()));
  const candidates = capitalizedWords(withoutPeople(carriedText(input.spec), [...new Set(people)], input.spec.name)).filter(
    (c) => !systems.has(c.word.toLowerCase()) && !own.has(c.word.toLowerCase()),
  );
  if (!candidates.length) return { people: [...new Set(people)], terms: [], rules, unsharedFiles: unshared.map((s) => s.title) };

  // Strong evidence (rules, people, contacts, everything the agent remembers): any capitalized use, start of sentence or not.
  const corpus = [...mems.map((m) => m.content), ...people, ...contacts.map((c) => c.name ?? "")].join("\n");
  const terms = new Set(candidates.filter((c) => namedIn(corpus, c.word)).map((c) => c.word));
  // Knowledge rows it did not share (a patient list, a customer CSV, the call transcript): mid-sentence names only.
  const loose = [...new Set(candidates.filter((c) => !c.initial && !terms.has(c.word)).map((c) => c.word))].slice(0, 80);
  if (loose.length && unshared.length) {
    const pats = loose.map((w) => `(^|[^[:alnum:]_])${w.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&")}($|[^[:alnum:]_])`);
    const values = sql.join(
      loose.map((w, i) => sql`(${w}::text, ${pats[i]!}::text)`),
      sql`, `,
    );
    const hits = await database.execute(sql`
      select p.term from (values ${values}) as p(term, pat)
      where exists (
        select 1 from knowledge_chunks c
        where c.org_id = ${orgId} and c.source_id in ${unshared.map((s) => s.id)} and c.content ~ p.pat
      )`);
    for (const r of hits.rows as Array<{ term: string }>) terms.add(r.term);
  }
  return { people: [...new Set(people)], terms: [...terms], rules, unsharedFiles: unshared.map((s) => s.title) };
}

// ───────────────────────────── scrubbing ─────────────────────────────

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9$%' -]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

function grams(text: string, n: number): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Split a line into sentences without breaking on "St.", "Dr.", "e.g." or decimals. */
function sentencesOf(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of line.matchAll(/[.!?]+["”’)]*(?=\s+["“(*]?[\p{Lu}\d])/gu)) {
    const end = m.index! + m[0].length;
    if (ABBREV_RE.test(line.slice(start, end))) continue;
    out.push(line.slice(start, end).trim());
    start = end;
  }
  const rest = line.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

function hasTerm(text: string, terms: string[]): boolean {
  return terms.some((t) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, "u").test(text));
}

/** Drop every sentence that names a private term or restates one of the reseller's rules; renumber the steps left. */
export function scrubProcedure(text: string, terms: string[], rules: string[]): string {
  const ruleGrams = new Set(rules.flatMap((r) => [...grams(r, 5)]));
  const restates = (s: string) => [...grams(s, 5)].some((g) => ruleGrams.has(g));
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const marker = /^(\s*(?:\d+[.)]|[-*•])\s+)/.exec(line)?.[1] ?? "";
    const body = line.slice(marker.length);
    if (!body.trim()) {
      lines.push(line);
      continue;
    }
    const kept = sentencesOf(body).filter((s) => !hasTerm(s, terms) && !restates(s));
    if (kept.length) lines.push(`${marker}${kept.join(" ")}`);
  }
  let n = 0;
  return lines
    .map((l, i) => {
      const m = /^(\s*)\d+([.)])\s+/.exec(l);
      if (!m) {
        if (l.trim()) n = 0;
        return l;
      }
      if (i === 0 || !/^\s*\d+[.)]\s+/.test(lines[i - 1] ?? "")) n = 0;
      n++;
      return l.replace(/^(\s*)\d+([.)])/, `$1${n}$2`);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A workflow name without the reseller's private names ("Elm St. Rescue billing" → "Billing"). */
function scrubName(name: string, terms: string[], fallback: string): string {
  let out = name;
  for (const t of terms) {
    out = out.replace(new RegExp(`(?:(?:St|Dr|Mt|Mr|Mrs|Ms)\\.\\s*)?(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?:['’]s)?(?![\\p{L}\\p{N}_])(?:\\s+(?:St|Dr|Mt)\\.)?`, "gu"), " ");
  }
  out = out.replace(/\s{2,}/g, " ").replace(/^[\s,;:&—–-]+|[\s,;:&—–-]+$/g, "").trim();
  if (out.length < 2) return fallback;
  return out[0]!.toUpperCase() + out.slice(1);
}

/** Point a procedure at the team's own file where it read one the reseller did not share. */
function withoutUnsharedFiles(text: string, files: string[]): string {
  let out = text;
  for (const f of [...files].sort((a, b) => b.length - a.length)) {
    if (f.trim().length < 4) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(f.trim())}(?![\\p{L}\\p{N}_])`, "giu"), "the team's file (ask for it if it isn't in the knowledge base)");
  }
  return out;
}

// ───────────────────────────── re-targeting the role ─────────────────────────────

/** Who an industry serves, and the neutral word for a business that does not (a groomer has clients, not patients). */
const AUDIENCES: Array<{ re: RegExp; swaps: Array<[string, string]> }> = [
  {
    re: /veterinar|animal hospital|\bvets?\b|clinic|hospital|dental|dentist|orthodont|medical|physician|chiropract|therap|health|med ?spa|optometr|pharmac|pediatric|urgent care/i,
    swaps: [["patient", "client"]],
  },
  { re: /property manag|landlord|apartment|leasing|real estate|rental/i, swaps: [["tenant", "customer"]] },
  { re: /restaurant|hospitality|hotel|catering|caf[eé]|\bbar\b|brewer|winer|\binn\b/i, swaps: [["guest", "customer"], ["diner", "customer"]] },
  { re: /insurance/i, swaps: [["policyholder", "client"]] },
  { re: /school|tutor|education|academy|college|learning/i, swaps: [["student", "client"]] },
  { re: /cleaning|janitorial|construction|contract|roofing|landscap|hvac|plumb|electric|moving|painting|remodel|pest/i, swaps: [["crew", "team"]] },
];

function matchCase(src: string, word: string): string {
  if (src === src.toUpperCase()) return word.toUpperCase();
  return /^\p{Lu}/u.test(src) ? word[0]!.toUpperCase() + word.slice(1) : word;
}

/** Industry words for the customer's business ("patient" → "client" for a pet groomer). Null when nothing changes. */
export function audienceSwapper(parties: ResaleParties): ((t: string) => string) | null {
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const customerText = `${parties.customerIndustry ?? ""} ${parties.customerName}`;
  if (norm(parties.customerIndustry) && norm(parties.customerIndustry) === norm(parties.resellerIndustry)) return null;
  const swaps = AUDIENCES.filter((a) => !a.re.test(customerText)).flatMap((a) => a.swaps);
  if (!swaps.length) return null;
  return (t: string) => {
    let out = t;
    for (const [from, to] of swaps) out = out.replace(new RegExp(`\\b(${from})(s?)\\b`, "gi"), (_m, w: string, s: string) => matchCase(w, to) + s);
    return out;
  };
}

/**
 * The role, written for the customer: no reseller vertical in parentheses ("(veterinary clinic)"), no reseller industry
 * words the customer's business doesn't share, and the customer's word for who it serves.
 */
export function roleForCustomer(role: string, parties: ResaleParties): string {
  const swap = audienceSwapper(parties) ?? ((t: string) => t);
  let r = swap(role.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s{2,}/g, " ").trim());
  const customerText = `${parties.customerIndustry ?? ""} ${parties.customerName}`.toLowerCase();
  const resellerWords = `${parties.resellerIndustry ?? ""}`.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  for (const w of resellerWords) {
    if (customerText.includes(w) || ["business", "services", "service", "company", "practice", "agency"].includes(w)) continue;
    r = r.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "gi"), " ").replace(/\s{2,}/g, " ").trim();
  }
  if (!r) return "Operations Coordinator";
  if (!/\s/.test(r)) r = `Operations ${r}`;
  return truncate(r[0]!.toUpperCase() + r.slice(1), 80);
}

// ───────────────────────────── the resold spec ─────────────────────────────

/**
 * Strip what belongs to the reseller's own business from a cloned spec: quotes from its discovery call, its rules,
 * its people, accounts and other private names, files it did not share, a role written for its industry, and a first
 * deliverable written from its call. The procedure stays.
 */
export function genericForResale(spec: AgentSpec, scrub: string[] | ResalePrivate, agentName: string, parties?: ResaleParties): AgentSpec {
  const priv: ResalePrivate = Array.isArray(scrub) ? { people: scrub, terms: [], rules: [], unsharedFiles: [] } : scrub;
  const swap = (parties && audienceSwapper(parties)) ?? ((t: string) => t);
  const clean = (t: string) =>
    withoutPeople(t, priv.people, agentName)
      .split("\n")
      .filter((l) => !/^\s*(?:\d+\.\s*)?(?:Hard rules from the call|Approval rules? from the call|Rules from the call|- People:|- Systems you will work with:)/i.test(l))
      .map((l) =>
        l
          .replace(/\s*On the call: “[^”]*”(?:\s*—\s*about [\d.,]+ hours? a week by hand today\.)?/g, "")
          .replace(/\s*\(The call points this way: “[^”]*”\)/g, "")
          .replace(/“[^”]*”/g, "")
          .replace(/\s{2,}/g, " ")
          .trimEnd(),
      )
      .join("\n");
  const procedure = (t: string) => swap(scrubProcedure(withoutUnsharedFiles(clean(t), priv.unsharedFiles), priv.terms, priv.rules));

  const customer = parties?.customerName ?? (/^You work for (.+?)\./.exec(spec.instructions)?.[1] ?? "the business");
  const role = parties ? roleForCustomer(spec.role, parties) : spec.role.replace(/\s*\([^)]*\)\s*$/, "");
  const industry = parties?.customerIndustry?.trim();
  const where = industry && !customer.toLowerCase().includes(industry.toLowerCase()) ? `${customer} (${industry.toLowerCase()})` : customer;
  const workflows = spec.workflows.map((w, i) => {
    const instructions = procedure(w.instructions);
    return {
      ...w,
      name: truncate(swap(scrubName(clean(w.name), priv.terms, `Workflow ${i + 1}`)), 80),
      problem: "",
      instructions: truncate(instructions.length >= 10 ? instructions : "Do this work for the team and deliver it finished.", 6000),
    };
  });
  const voice = truncate(procedure(spec.voice) || "Warm, concise, and specific. Leads with the result.", 400);
  // Instructions are rebuilt from an allowlist (role, responsibilities, a generic way of working, voice) — never the
  // reseller's own sections (pricing, margins, rates, named accounts, notes added in Agent settings).
  const when = (t: AgentSpec["workflows"][number]["trigger"]) =>
    t.type === "manual" ? "on demand" : t.type === "event" ? (t.event === "email.received" ? "when an email comes in" : t.event === "sms.received" ? "when a text comes in" : `when ${t.event} happens`) : "on its schedule";
  const instructions = [
    `You are ${spec.name}, ${role} at ${where}. You work for ${customer}. Take the work below off the team's plate and deliver it finished.`,
    "",
    "## Your responsibilities",
    ...workflows.map((w) => `- **${w.name}** — ${when(w.trigger)}.`),
    "",
    "## Rules",
    "- Nothing leaves the business (emails, texts, changes in client systems) without approval.",
    "",
    "## How you work",
    "- Be proactive: deliver finished work (documents, tables, drafts), not questions. If one detail is missing, make a sensible assumption, label it, and keep going.",
    `- Ground everything in ${customer}'s knowledge base and your memory. Never invent prices, balances or customer data — mark unknowns clearly.`,
    "- Save new facts and preferences you learn to memory so you get better every week.",
    "",
    "## Voice",
    voice,
    ...(parties?.resellerName ? ["", `(Provided to ${customer} by ${parties.resellerName}.)`] : []),
  ].join("\n");
  const list = workflows.map((w) => w.name.toLowerCase());
  const jobs = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "the team's routine work");
  const summary = `${spec.name}, ${role}: ${jobs}.${parties?.resellerName ? ` Provided to ${customer} by ${parties.resellerName}.` : ""}`;
  return agentSpec.parse({
    ...spec,
    role,
    vertical: parties ? (industry ?? "") : spec.vertical,
    voice,
    instructions: truncate(instructions, 12000),
    summary: truncate(summary, 280),
    workflows,
    knowledgeNeeds: [],
    firstDeliverable: {
      title: truncate(`Your first week with ${spec.name}`, 120),
      description: truncate(`What ${spec.name} will take over each week, and a first piece of finished work.`, 600),
      instructions:
        "Using the knowledge base (if any) and the workflows below, deliver a one-page brief: what you will do each week, what you need from the team to start (data, logins, documents), and a first piece of finished work in the format each workflow produces. Do not refer to any other business.",
    },
    seedMemories: [],
    openQuestions: [],
    resaleIdea: "",
  });
}

/** Replace the reseller's name with the customer's throughout a cloned spec; credit the reseller once. */
export function retargetSpec(spec: AgentSpec, fromName: string, toName: string): AgentSpec {
  const from = fromName.trim();
  const swap = (t: string) => (from ? t.replace(new RegExp(escapeRe(from), "gi"), toName) : t);
  const credit = `Provided to ${toName} by ${from}.`;
  return agentSpec.parse({
    ...spec,
    summary: truncate(`${swap(spec.summary).replace(/\s*Provided to .* by .*\.$/, "")} ${credit}`.trim(), 280),
    instructions: truncate(`You work for ${toName}. ${swap(spec.instructions)}\n\n(${credit})`, 12000),
    voice: swap(spec.voice),
    workflows: spec.workflows.map((w) => ({ ...w, name: truncate(swap(w.name), 80), problem: truncate(swap(w.problem), 600), instructions: truncate(swap(w.instructions), 6000) })),
    firstDeliverable: {
      title: truncate(swap(spec.firstDeliverable.title), 120),
      description: truncate(swap(spec.firstDeliverable.description), 600),
      instructions: truncate(swap(spec.firstDeliverable.instructions), 4000),
    },
    seedMemories: spec.seedMemories.map(swap),
    openQuestions: spec.openQuestions.map(swap),
  });
}
