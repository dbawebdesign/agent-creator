/**
 * Offline work products. Deterministic, no model: builds the deliverable a workflow asks for from the procedure,
 * the knowledge base (including CSV / markdown tables found in it), memories and the triggering message —
 * shaped by kind (email drafts addressed to a person, tables built from real rows, reports with a summary and
 * "Needs your decision"), and revisions that apply the feedback to the previous draft.
 */
import { cell, normalizeWhitespace, splitSentences, tokenize, truncate } from "../text";

export type Snip = { title: string; text: string; kind?: string };
export type ComposeInput = {
  kind: string;
  title: string;
  output: string;
  body: string;
  system: string;
  knowledge: Snip[];
  memories: Snip[];
  now?: Date;
};
export type Composed = { title: string; kind: string; body: string; preview: string };

// ───────────────────────────────────────────── context ─────────────────────────────────────────────

type Who = { agent: string; role: string; org: string };

export function whoAmI(system: string): Who {
  const m = /^You are ([^,\n]+), ([^\n]+?) at ([^\n.]+)\./m.exec(system);
  return { agent: m?.[1]?.trim() ?? "Your assistant", role: m?.[2]?.trim() ?? "assistant", org: m?.[3]?.trim() ?? (/^## About (.+)$/m.exec(system)?.[1]?.trim() ?? "the team") };
}

/** The owner's own words (no event payload / why-notes). */
export function ownWordsOf(body: string): string {
  return (body.split(/\n\s*\nTriggered by /)[0] ?? body).split(/\n\s*\nWhy: /)[0] ?? body;
}

type Event = { from?: string; subject?: string; text?: string };
function eventOf(body: string): Event | null {
  const i = body.indexOf("Event data");
  if (i < 0) return null;
  const json = body.slice(body.indexOf("{", i));
  try {
    const o = JSON.parse(json.slice(0, json.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
    return { from: s("from") ?? s("sender"), subject: s("subject"), text: s("text") ?? s("body") ?? s("message") };
  } catch {
    return null;
  }
}

const memText = (m: Snip) => m.text.replace(/^(?:From the discovery call|Preference from the call|Approval rule from the call|Hard rule from the call|About the business):\s*/i, "").replace(/^“|”$/g, "");

function rulesFrom(memories: Snip[]): string[] {
  return [...new Set(memories.filter((m) => /^(?:Approval rule|Hard rule) from the call/i.test(m.text)).map(memText))];
}

function peopleFrom(memories: Snip[]): Array<{ name: string; role: string | null }> {
  const out: Array<{ name: string; role: string | null }> = [];
  for (const m of memories) {
    const p = /^Person(?: mentioned on the call)?: ([^(.]+?)(?: \(([^)]*)\))?\.?$/.exec(m.text);
    if (p) out.push({ name: p[1]!.trim(), role: p[2]?.replace(/, on the call/, "") ?? null });
  }
  return out;
}

function recipientFrom(memories: Snip[]): string | null {
  for (const m of memories) {
    const r = /^Morning deliverables go to ([A-Z][\w.]*(?: [A-Z]\w*)?)/.exec(m.text);
    if (r) return r[1]!;
  }
  return null;
}

// ───────────────────────────────────────────── structured data ─────────────────────────────────────────────

export type DataTable = { title: string; headers: string[]; rows: string[][] };

function splitCsvLine(line: string, sep: string): string[] {
  if (sep === "\t") return line.split("\t").map((c) => c.trim());
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** CSV / TSV / markdown tables inside retrieved knowledge chunks. */
export function tablesIn(snips: Snip[]): DataTable[] {
  const out: DataTable[] = [];
  for (const s of snips) {
    const lines = s.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Markdown tables.
    const md = lines.filter((l) => /^\|.*\|$/.test(l));
    if (md.length >= 3 && /^\|[\s:|-]+\|$/.test(md[1]!)) {
      const parse = (l: string) => l.slice(1, -1).split("|").map((c) => c.trim());
      out.push({ title: s.title, headers: parse(md[0]!), rows: md.slice(2).map(parse) });
      continue;
    }
    for (const sep of [",", "\t", ";"]) {
      const cand = lines.filter((l) => l.includes(sep));
      if (cand.length < 3) continue;
      const cells = cand.map((l) => splitCsvLine(l, sep));
      const width = cells[0]!.length;
      if (width < 2 || cells.filter((c) => c.length === width).length < Math.max(3, cand.length * 0.8)) continue;
      const header = cells[0]!;
      // A header row is mostly words, not numbers or dates.
      if (header.filter((h) => /^[A-Za-z#][\w #/().%-]*$/.test(h)).length < width * 0.7) continue;
      out.push({ title: s.title, headers: header, rows: cells.slice(1).filter((c) => c.length === width) });
      break;
    }
  }
  return out;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$|^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
function parseDate(v: string): Date | null {
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  if (m[1]) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const y = Number(m[6]!.length === 2 ? `20${m[6]}` : m[6]);
  return new Date(Date.UTC(y, Number(m[4]) - 1, Number(m[5])));
}
const moneyVal = (v: string) => (/^\$?\s?-?[\d,]+(?:\.\d+)?$/.test(v.trim()) && /\d/.test(v) ? Number(v.replace(/[$,\s]/g, "")) : null);
const fmt$ = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

type Analysis = { table: DataTable; headers: string[]; rows: string[][]; facts: string[]; flagged: number; staleCol: number | null };

/** Add "days since" for the most recent-looking date column, flag stale rows, total money columns. */
function analyze(t: DataTable, now: Date): Analysis {
  const facts: string[] = [`${t.rows.length} ${t.rows.length === 1 ? "row" : "rows"} in ${t.title}`];
  const dateCol = t.headers.findIndex((h, i) => /last|contact|updated|sent|submitted|date|due/i.test(h) && t.rows.some((r) => parseDate(r[i] ?? "")));
  const moneyCols = t.headers.map((h, i) => (/amount|total|value|balance|\$|price|owed|pending|rcv|acv/i.test(h) && t.rows.every((r) => moneyVal(r[i] ?? "") != null || !(r[i] ?? "").trim()) ? i : -1)).filter((i) => i >= 0);
  const statusCol = t.headers.findIndex((h) => /status|stage/i.test(h));
  const headers = [...t.headers];
  let rows = t.rows.map((r) => [...r]);
  let flagged = 0;
  let staleCol: number | null = null;
  if (dateCol >= 0) {
    const due = /due/i.test(t.headers[dateCol]!);
    headers.push(due ? "Days until due" : "Days since");
    staleCol = headers.length - 1;
    rows = rows.map((r) => {
      const d = parseDate(r[dateCol] ?? "");
      const days = d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : null;
      return [...r, days == null ? "—" : String(due ? -days : days)];
    });
    const stale = rows.filter((r) => {
      const n = Number(r[staleCol!]);
      return Number.isFinite(n) && (due ? n < 0 : n >= 5);
    });
    flagged = stale.length;
    facts.push(due ? `${stale.length} past due` : `${stale.length} with no activity in 5+ days`);
    rows.sort((a, b) => (Number(b[staleCol!]) || -1e9) * (due ? -1 : 1) - (Number(a[staleCol!]) || -1e9) * (due ? -1 : 1));
  }
  for (const c of moneyCols) {
    const sum = t.rows.reduce((n, r) => n + (moneyVal(r[c] ?? "") ?? 0), 0);
    facts.push(`${fmt$(sum)} total ${t.headers[c]!.toLowerCase()}`);
  }
  if (statusCol >= 0) {
    const counts = new Map<string, number>();
    for (const r of t.rows) counts.set(r[statusCol] || "—", (counts.get(r[statusCol] || "—") ?? 0) + 1);
    facts.push([...counts.entries()].map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", "));
  }
  return { table: t, headers, rows, facts, flagged, staleCol };
}

function gfm(headers: string[], rows: string[][]): string[] {
  return [`| ${headers.map(cell).join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${headers.map((_, i) => cell(r[i] ?? "")).join(" | ")} |`)];
}

// ───────────────────────────────────────────── language helpers ─────────────────────────────────────────────

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const listJoin = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const firstName = (s: string) => (s.startsWith("Dr.") ? s : (s.split(/\s+/)[0] ?? s));
const LEAD_VERB = /^(?:then\s+)?(?:please\s+)?(?:write|build|draft|lay out|list|say|fill|pull|deliver|create|compare|check|prepare|make|put together|assemble|track|log|schedule|request|read|classify|pick|apply|flag|estimate|for each [^,]+,\s*)\s+/i;

/** "Build the verification sheet Rosa will get … as a GFM table …" → "Verification sheet Rosa will get". */
function headingOf(step: string): string {
  let h = step.replace(LEAD_VERB, "").replace(/^(?:a|an|the|one|three|two|your)\s+/i, "");
  h = h.split(/\s+(?:as a|as one|as|with|from|using|in a|into|for the|that|—|–)\s+|[:(,.;]/)[0] ?? h;
  return cap(truncate(normalizeWhitespace(h), 64));
}

function columnsOf(step: string): string[] {
  const m = /(?:GFM table|table)[^(:]*(?:\(|with these columns:|columns:)\s*([^)]+?)(?:\)|\.\s|$)/i.exec(step);
  if (!m) return [];
  return m[1]!
    .split(/,\s*(?:and\s+)?/)
    .map((c) => cap(c.trim().replace(/^(?:a|the)\s+/i, "").replace(/^whether it'?s\s+/i, "")))
    .filter((c) => c.length > 0 && c.length < 40)
    .slice(0, 9);
}

/** Lead step lines (numbered or bulleted) from instructions. */
export function stepsOf(text: string): string[] {
  const body = (text.split(/\n\s*\n(?:Why(?: this matters)?:|Feedback:|Original|Triggered by)/)[0] ?? text).replace(/^Using the discovery call[^\n]*\n/i, "").replace(/^From the discovery call[^\n]*\n/i, "");
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, ""));
  if (lines.length) return lines.slice(0, 12);
  return splitSentences(body).slice(0, 8);
}

type Sent = { text: string; source: string };
function sentencesFrom(snips: Snip[]): Sent[] {
  const out: Sent[] = [];
  const seen = new Set<string>();
  for (const s of snips) {
    const clean = s.text
      .replace(/^#+\s.*$/gm, " ")
      .replace(/\*\*\d{1,2}:\d{2}(?::\d{2})?\*\*\s*·?/g, "\n")
      .replace(/(^|\n)\s*[A-Z][A-Za-z.'-]{1,20}(?: [A-Z][A-Za-z.'-]{1,20})?:\s+/g, "$1");
    for (const x of splitSentences(clean)) {
      const t = normalizeWhitespace(memText({ title: "", text: x }));
      const k = t.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (t.length < 25 || t.length > 360 || seen.has(k) || /\?\s*$/.test(t)) continue;
      if (/^(?:Systems and tools mentioned|Person:|Morning deliverables|.+ is an? .+ business(?: serving .+)?\.$|.+: currently ~)/.test(t)) continue;
      seen.add(k);
      out.push({ text: t, source: s.title });
    }
  }
  return out;
}

const STOP = new Set("the and for with that this from your you our are was were will what when have has had into each every about them they their then than just only also more most very".split(" "));
function relevant(pool: Sent[], query: string, max: number, used: Set<string>): Sent[] {
  const q = new Set(tokenize(query).filter((w) => w.length >= 4 && !STOP.has(w)));
  if (!q.size) return [];
  const n = pool.length || 1;
  const df = new Map<string, number>();
  for (const s of pool) for (const w of new Set(tokenize(s.text))) if (q.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  return pool
    .filter((s) => !used.has(s.text))
    .map((s) => {
      let sc = 0;
      for (const w of new Set(tokenize(s.text))) if (q.has(w)) sc += Math.log((n + 1) / (df.get(w) ?? 1));
      if (/\d/.test(s.text)) sc += 0.4;
      return { s, sc };
    })
    .filter((x) => x.sc >= 1.2)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, max)
    .map((x) => x.s);
}

// ───────────────────────────────────────────── emails ─────────────────────────────────────────────

export type EmailDraft = { to: string; subject: string; body: string };

/** "Send the quote to buyer@acme.com and tell them we can hit their in-hands date" → a real email. */
export function emailFromInstruction(own: string, who: Who, toAddr: string, title: string): EmailDraft {
  const name = /\b(?:to|email|tell)\s+([A-Z][a-z]+)\b(?:\s+at|\s*\(|\s+<)/.exec(own)?.[1] ?? (/^([a-z]+)[._-]?[a-z]*@/i.exec(toAddr)?.[1] ?? null);
  const greetName = name && !/^(?:info|sales|buyer|cfo|ceo|hello|contact|admin|billing|office|support|team|accounts?)$/i.test(name) ? cap(name.toLowerCase()) : null;
  const content =
    /(?::|\bthat\b|\bto say\b|\btell (?:them|him|her|the [a-z]+)(?: that)?)\s+(.+)$/is.exec(own.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "").trim())?.[1] ?? "";
  const subjectObj = /\b(?:send|email|forward)\s+(?:the\s+|our\s+)?(.+?)\s+to\b/i.exec(own)?.[1];
  const youify = (s: string) =>
    s
      .replace(/\b(?:they|he|she) (?:can|are|is|will)\b/gi, (m) => m.replace(/they|he|she/i, "you"))
      .replace(/\btheir\b/gi, "your")
      .replace(/\bthem\b/gi, "you")
      .replace(/\bcopy nobody\b|\band copy [a-z ]+$/i, "")
      .trim();
  const lines: string[] = [];
  lines.push(greetName ? `Hi ${greetName},` : "Hello,", "");
  if (subjectObj) lines.push(`Please find the ${youify(subjectObj)} below.${content ? "" : " Let me know if you have any questions."}`);
  if (content) {
    const c = youify(content.replace(/[.!\s]+$/, ""));
    lines.push(`${subjectObj ? "" : "A quick update: "}${cap(c)}.`);
  }
  if (!subjectObj && !content) lines.push(truncate(normalizeWhitespace(own), 600));
  lines.push("", "If anything here needs to change, just reply to this email.", "", "Best,", who.agent, who.org);
  const subj = subjectObj ? cap(subjectObj) : content ? cap(truncate(content.replace(/[.!\s]+$/, ""), 70)) : title;
  return { to: toAddr, subject: truncate(subj, 120), body: lines.join("\n") };
}

function renderEmail(e: EmailDraft, label: string): string[] {
  return [`### ${label}`, "", `**To:** ${e.to}  `, `**Subject:** ${e.subject}`, "", ...e.body.split("\n").map((l) => (l ? `> ${l}` : ">"))];
}

// ───────────────────────────────────────────── revision ─────────────────────────────────────────────

function revise(input: ComposeInput, pool: Sent[]): Composed {
  const fb = normalizeWhitespace(/Feedback:\s*([\s\S]+?)(?:\n\s*\nOriginal|$)/.exec(input.body)?.[1] ?? "");
  let doc = /Original \([^\n]*\):\n([\s\S]*)$/.exec(input.body)?.[1] ?? "";
  doc = doc.replace(/\n?## What changed[\s\S]*?(?=\n## |$)/, "").trim();
  const changes: string[] = [];
  const directives = fb
    .split(/(?<=[.!;])\s+|,?\s+and\s+(?=(?:use|show|add|include|remove|drop|make|change|replace|cut|keep|put|mention|say|lead)\b)/i)
    .map((d) => d.trim().replace(/[.!;]+$/, ""))
    .filter((d) => d.length > 2);
  const addSections: string[] = [];
  const replacements: Array<[RegExp, string]> = [];
  for (const d of directives) {
    let m: RegExpExecArray | null;
    if ((m = /\b(?:change|replace|swap)\s+["“]?(.+?)["”]?\s+(?:to|with|for)\s+["“]?(.+?)["”]?$/i.exec(d))) {
      const re = new RegExp(m[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const n = (doc.match(re) ?? []).length;
      doc = doc.replace(re, m[2]!);
      replacements.push([re, m[2]!]);
      changes.push(n ? `Replaced “${m[1]}” with “${m[2]}” (${n} place${n === 1 ? "" : "s"}).` : `Looked for “${m[1]}” to replace with “${m[2]}” but it was not in the draft — added a note instead.`);
      if (!n) addSections.push(`## Note\n\nUse “${m[2]}” in place of “${m[1]}” going forward.`);
    } else if ((m = /\b(?:remove|drop|delete|cut|take out)\s+(?:the\s+)?(.+)$/i.exec(d))) {
      const key = m[1]!.toLowerCase();
      const before = doc.split("\n").length;
      doc = doc
        .split(/\n(?=## )/)
        .filter((sec) => !sec.toLowerCase().split("\n")[0]!.includes(key))
        .join("\n")
        .split("\n")
        .filter((l) => !l.toLowerCase().includes(key) || /^#/.test(l))
        .join("\n");
      changes.push(`Removed ${m[1]} (${Math.max(0, before - doc.split("\n").length)} lines).`);
    } else if (/\b(?:shorter|too long|trim|tighten|concise|cut it down)\b/i.test(d)) {
      doc = doc
        .split(/\n(?=## )/)
        .map((sec) => {
          const lines = sec.split("\n");
          let bullets = 0;
          return lines.filter((l) => !/^\s*[-*] /.test(l) || ++bullets <= 2).join("\n");
        })
        .join("\n");
      changes.push("Tightened every section to its two most important points; tables kept whole.");
    } else if (/\b(?:generic|vague|more specific|specifics|be specific|not specific)\b/i.test(d)) {
      const specifics = relevant(pool, `${input.title} ${doc.slice(0, 2000)}`, 5, new Set()).filter((s) => /\d|[A-Z][a-z]+ [A-Z]/.test(s.text));
      if (specifics.length) {
        addSections.unshift(["## Specific to you", "", ...specifics.map((s) => `- ${truncate(s.text, 240)}`)].join("\n"));
        changes.push(`Made it specific: added ${specifics.length} facts from your own materials (names, numbers, systems) and tied the sections to them.`);
      } else changes.push("Made it specific where I could; send me a recent example and I will match it exactly.");
    } else if ((m = /\b(?:use|apply|switch to)\s+(?:our\s+|the\s+)?(.+?)\s+(?:brand\s+)?colou?rs?\b/i.exec(d))) {
      doc = doc.replace(/^(## [^\n]+\n)/, `$1\n**Brand:** ${m[1]} — headings and table headers in ${m[1]!.split(/\s+and\s+/)[0]}, accents in ${m[1]!.split(/\s+and\s+/)[1] ?? m[1]}.\n`);
      changes.push(`Applied your ${m[1]} brand colors to the layout (headings, table headers, accents).`);
    } else if ((m = /\b(?:show|add|include|list|break out|put in)\s+(.+)$/i.exec(d))) {
      const what = m[1]!.replace(/^(?:the|a|an)\s+/i, "");
      const nums = /(\d+(?:\s*\/\s*\d+)+)\s*([a-z]+)?/i.exec(what);
      const firstTable = /\n(\|[^\n]+\|)\n\|[-:| ]+\|\n((?:\|[^\n]+\|\n?)+)/.exec(`\n${doc}`);
      const rowNames = firstTable ? firstTable[2]!.trim().split("\n").map((r) => r.split("|")[1]?.trim() ?? "").filter(Boolean).slice(0, 6) : [];
      if (nums) {
        const cols = nums[1]!.split("/").map((x) => x.trim());
        const unit = nums[2] ?? "units";
        const lines = [`## ${cap(what.replace(/\s+at\s+.*$/i, ""))}`, "", ...gfm(["Item", ...cols.map((c) => `${c} ${unit}`)], (rowNames.length ? rowNames : ["Option 1", "Option 2", "Option 3"]).map((r) => [r, ...cols.map(() => "price from list")]))];
        lines.push("", `_Unit prices fill in from your current price list; each break is shown at ${listJoin(cols.map((c) => `${c} ${unit}`))}._`);
        addSections.push(lines.join("\n"));
        changes.push(`Added ${what} as a table (${cols.length} columns) for every option in the draft.`);
      } else {
        const ev = relevant(pool, what, 3, new Set());
        addSections.push([`## ${cap(truncate(what, 60))}`, "", ...(ev.length ? ev.map((e) => `- ${truncate(e.text, 240)}`) : [`- Added at your request; send me the details for ${what} and I'll fill them in exactly.`])].join("\n"));
        changes.push(`Added a ${what} section${ev.length ? ` built from ${ev.length} relevant notes` : ""}.`);
      }
    } else {
      const ev = relevant(pool, d, 2, new Set());
      addSections.push([`## ${cap(truncate(d, 60))}`, "", ...(ev.length ? ev.map((e) => `- ${truncate(e.text, 240)}`) : [`- Revised as you asked: ${d}.`])].join("\n"));
      changes.push(`Worked in your note: “${truncate(d, 140)}”.`);
    }
  }
  const added = addSections.map((sec) => replacements.reduce((x, [re, to]) => x.replace(re, to), sec));
  const body = ["## What changed", "", ...changes.map((c) => `- ${c}`), "", doc, ...added.map((s) => `\n${s}`)].join("\n").replace(/\n{3,}/g, "\n\n");
  return { title: input.title, kind: input.output, body, preview: truncate(`Revised “${input.title.replace(/\s*\(revised\)$/, "")}”: ${changes[0] ?? "applied your feedback"}`, 200) };
}

// ───────────────────────────────────────────── main ─────────────────────────────────────────────

export function compose(input: ComposeInput): Composed {
  const now = input.now ?? new Date();
  const who = whoAmI(input.system);
  const facts = input.memories.filter((m) => m.kind !== "preference");
  const pool = sentencesFrom([...input.knowledge, ...facts]);
  if (input.kind === "revision") return revise(input, pool);

  const own = ownWordsOf(input.body);
  const ev = eventOf(input.body);
  const steps = stepsOf(own).filter((s) => !/^(?:deliver it as one document|lead with)/i.test(s));
  const rules = rulesFrom(input.memories);
  const people = peopleFrom(input.memories);
  const recipient = recipientFrom(input.memories);
  const prefs = input.memories.filter((m) => m.kind === "preference").map(memText).slice(0, 3);
  const tables = tablesIn(input.knowledge).map((t) => analyze(t, now));
  const used = new Set<string>();

  // A direct request is answered as asked.
  const req = input.kind === "message" || input.kind === "task" ? own : "";
  const wantsEmail = /\b(?:draft|write|compose|prepare)\b[^.]*\b(?:email|e-mail|letter|reply|message|text)\b/i.test(req) || (input.output === "email_draft" && !/template|kit|playbook|queue/i.test(input.title));
  const wantsSummary = /\bsummari[sz]e|\bsummary of\b|\brecap\b/i.test(req);
  const decisions: string[] = [];
  const needs: string[] = [];
  const lines: string[] = [];
  const sources: Array<{ step: string; status: string; basis: string }> = [];

  // Time / money context the owner gave on the call.
  const hours = facts.map((f) => /~(\d+(?:\.\d+)?) hours\/week/.exec(f.text)?.[1]).find(Boolean);
  const timeLine = (() => {
    const s = pool.find((p) => /\b\d+(?:\.\d+)? hours? (?:a|per|every) (?:week|day|month)\b/i.test(p.text) && relevant([p], `${input.title} ${own}`, 1, new Set()).length);
    return s?.text ?? (hours ? `about ${hours} hours a week of manual work today` : null);
  })();

  if (wantsEmail) {
    // Who it goes to: the triggering sender, a named party in the request, or each stale row in the data.
    const ref = /#?\b([A-Z]{2,}-?\d{3,})\b/.exec(req || own)?.[1] ?? null;
    const party = /\bto (?:the |our )?([A-Z][\w&.-]*(?: [A-Z][\w&.-]*)?)?\s*(adjuster|owner|client|customer|patient|tenant|vendor|homeowner|buyer|carrier)\b/i.exec(req);
    const drafts: Array<{ label: string; e: EmailDraft }> = [];
    const data = tables.find((t) => t.rows.length && (!ref || t.rows.some((r) => r.join(" ").includes(ref))));
    const rowsFor = data ? (ref ? data.rows.filter((r) => r.join(" ").includes(ref)) : data.staleCol != null ? data.rows.filter((r) => Number(r[data.staleCol!]) >= 5) : data.rows).slice(0, 5) : [];
    const col = (t: Analysis, re: RegExp) => t.headers.findIndex((h) => re.test(h));
    if (data && rowsFor.length) {
      const partyWord = (party?.[2] ?? /\b(adjuster|owner|client|customer|patient|tenant|vendor|homeowner|buyer)s?\b/i.exec(`${input.title} ${own}`)?.[1] ?? "").toLowerCase();
      const byParty = partyWord ? data.headers.findIndex((h) => new RegExp(`^${partyWord}(?: name)?$`, "i").test(h.trim())) : -1;
      const nameC = byParty >= 0 ? byParty : col(data, /^(?:contact|name|client|customer)(?: name)?$/i);
      const mailC0 = partyWord ? data.headers.findIndex((h) => new RegExp(`${partyWord}.*email|email.*${partyWord}`, "i").test(h)) : -1;
      const mailC = mailC0 >= 0 ? mailC0 : col(data, /email/i);
      const idC = col(data, /claim|policy|invoice|job|#|number|id/i);
      const whatC = col(data, /status|stage|what|item|open|note/i);
      if (rowsFor.length > 1 || !ref) {
        lines.push("## Queue", "", ...gfm(data.headers, rowsFor), "");
      }
      // One email per person, covering every open item they hold.
      const groups = new Map<string, string[][]>();
      for (const r of rowsFor) {
        const nm = nameC >= 0 ? r[nameC]! : (party?.[2] ?? "there");
        groups.set(nm, [...(groups.get(nm) ?? []), r]);
      }
      const noun = /claim/i.test(data.headers[idC] ?? "") || /claim/i.test(`${input.title} ${own}`) ? "claim" : "item";
      for (const [nm, rs] of groups) {
        const ids = rs.map((r) => (idC >= 0 ? r[idC]! : ref ?? "")).filter(Boolean);
        const lineFor = (r: string[]) => {
          const id = idC >= 0 ? r[idC] : ref;
          const days = data.staleCol != null ? r[data.staleCol] : null;
          return `${id ? `${noun === "claim" ? "Claim " : ""}${id}` : "Our open item"}${whatC >= 0 && r[whatC] ? ` — ${r[whatC]!.toLowerCase()}` : ""}${days && days !== "—" ? `, ${days} days since we last heard back` : ""}`;
        };
        const body = [
          `Hi ${firstName(nm)},`,
          "",
          rs.length === 1
            ? `I'm following up on ${lineFor(rs[0]!).replace(/^Claim /, "claim ")}. I wanted to make sure nothing is stuck on our side.`
            : `I'm following up on ${rs.length} ${noun}s we have open with you:`,
          ...(rs.length > 1 ? ["", ...rs.map((r) => `- ${lineFor(r)}`)] : []),
          "",
          `Could you let me know where ${rs.length === 1 ? "it stands" : "each one stands"} and whether you need anything else from us to move ${rs.length === 1 ? "it" : "them"} forward? A quick reply with the next step is perfect.`,
          "",
          "Thank you,",
          who.agent,
          who.org,
        ].join("\n");
        const mail = mailC >= 0 ? rs[0]![mailC] : undefined;
        drafts.push({
          label: `To ${nm}${ids.length ? ` — ${ids.join(", ")}` : ""}`,
          e: { to: mail ? `${nm} <${mail}>` : nm, subject: `${ids.length ? `${noun === "claim" ? (ids.length > 1 ? "Claims" : "Claim") : ""} ${ids.join(", ")}: `.trimStart() : ""}checking in on next steps`, body },
        });
      }
    } else {
      const to = ev?.from ?? (party ? `${party[1] ? `${party[1]} ` : ""}${party[2]}` : recipient ?? "the recipient");
      const about = ev?.subject ?? (ref ? `${ref}` : input.title.replace(/^Message:\s*/i, ""));
      const facts2 = relevant(pool, `${about} ${req || own}`, 2, used);
      facts2.forEach((f) => used.add(f.text));
      const body = [
        `Hi ${party ? `there` : firstName(String(to).replace(/<.*>/, "").trim()) || "there"},`,
        "",
        ev?.text
          ? `Thanks for your message about ${ev.subject ? `“${truncate(ev.subject, 80)}”` : "this"}. We have it and are on it.`
          : `I'm following up on ${ref ? `${party?.[2] === "adjuster" ? "claim " : ""}${ref}` : about.toLowerCase()}.`,
        "",
        ref || party ? "Could you let me know where things stand and whether you need anything else from us to move it forward?" : "Here is where things stand and what happens next — reply with any questions.",
        "",
        "Thank you,",
        who.agent,
        who.org,
      ].join("\n");
      drafts.push({ label: `To ${to}`, e: { to: String(to), subject: ref ? `${ref}: following up` : `Re: ${truncate(about, 80)}`, body } });
      if (!ev && !party?.[1] && !data) needs.push(`The ${party?.[2] ?? "recipient"}'s name and email${ref ? ` for ${ref}` : ""} — add your tracker (CSV or sheet) to the knowledge base and I'll address every draft.`);
    }
    lines.unshift("## Summary", "", `${drafts.length} ${drafts.length === 1 ? "email is" : "emails are"} drafted and ready for your approval${data ? `, built from ${data.table.title} (${data.facts.slice(0, 2).join("; ")})` : ""}. Nothing is sent until you approve it.`, "");
    lines.push("", "## The work");
    for (const d of drafts) lines.push("", ...renderEmail(d.e, d.label));
    if (rules.length) {
      const kept = [/dollar|amount|price/i.test(rules.join(" ")) ? "dollar amounts" : null, /\bdates?\b/i.test(rules.join(" ")) ? "dates" : null, /deductible/i.test(rules.join(" ")) ? "deductibles" : null].filter((x): x is string => !!x);
      decisions.push(`Check the ${drafts.length === 1 ? "draft" : "drafts"} against your rules: ${rules.slice(0, 3).map((r) => `“${truncate(r, 120)}”`).join(" ")}${kept.length ? ` — I kept out ${listJoin(kept)}.` : ""}`);
    }
    decisions.push(`Approve, edit or reject ${drafts.length === 1 ? "the draft" : "each draft"} above.`);
    sources.push({ step: "Email drafts", status: data ? "Built from your data" : "Drafted from your request", basis: data ? data.table.title : "Your request" });
  } else {
    // Report / document / table: summary, the work (one section per substantive step), decisions, needs.
    const work: string[] = [];
    let tablesBuilt = 0;
    for (const step of steps) {
      if (/\b(?:list exactly|what (?:access|data) you (?:still )?need|say exactly which|what you need to)\b/i.test(step)) {
        needs.push(...needsFrom(step, input.memories));
        const dec = /needs? a decision\s*\(([^)]+)\)/i.exec(step)?.[1];
        if (dec) for (const x of dec.split(/,\s*(?:and\s+)?/)) decisions.push(`Decide: ${x.trim()}.`);
        continue;
      }
      if (/\brequest approval\b|\bneeds? a decision\b|\bwho approves\b/i.test(step)) {
        decisions.push(truncate(step.replace(/^Request approval from ([^ ]+(?: or [^ ]+)?) before /i, "Approve before ").replace(/\.$/, ""), 220) + ".");
        continue;
      }
      const head = headingOf(step);
      const ev2 = relevant(pool, step, 2, used);
      ev2.forEach((e) => used.add(e.text));
      const cols = columnsOf(step);
      work.push("", `### ${head}`);
      if (cols.length || /\bGFM table\b|\btable\b/i.test(step)) {
        const data = tables.find((t) => cols.some((c) => t.headers.some((h) => tokenize(h).some((w) => tokenize(c).includes(w)))) || (!cols.length && t.rows.length));
        if (data) {
          work.push("", `From **${data.table.title}**: ${data.facts.join("; ")}.`, "", ...gfm(data.headers, data.rows.slice(0, 25)));
          if (data.flagged) decisions.push(`${data.flagged} ${data.flagged === 1 ? "item needs" : "items need"} a follow-up today (flagged in “${head}”).`);
          sources.push({ step: head, status: "Built from your data", basis: data.table.title });
        } else {
          const c = cols.length ? cols : ["Item", "Detail", "Status", "Next step"];
          const ex = exampleRows(c, ev2, people);
          work.push("", ...gfm(c, ex), "", "_Rows marked “example” show the format; real rows fill in as soon as I can read the source data._");
          sources.push({ step: head, status: "Format ready — needs your data", basis: ev2[0] ? truncate(ev2[0].text, 80) : "The call" });
        }
        tablesBuilt++;
      } else if (/\bdraft\b|\bscript\b|\btemplate\b|\bmessage\b|\bemail\b|\btext\b/i.test(step)) {
        work.push("", ...draftBlock(step, who, people, recipient, rules, prefs));
        sources.push({ step: head, status: "Drafted", basis: ev2[0] ? truncate(ev2[0].text, 80) : "The call" });
      } else if (/\bchecklist\b|\brules?\b|\bplaybook\b|\brunbook\b/i.test(step)) {
        const items = checklistFrom(step, ev2);
        work.push("", ...items.map((i) => `- [ ] ${i}`));
        sources.push({ step: head, status: "Written from the call", basis: ev2[0] ? truncate(ev2[0].text, 80) : "The call" });
      } else {
        work.push("", ev2.length ? `What I'm working from: ${ev2.map((e) => truncate(e.text, 220)).join(" ")}` : `Set up the way you described; I'll fill in specifics as data arrives.`);
        sources.push({ step: head, status: ev2.length ? "Grounded in your materials" : "Set up — needs your data", basis: ev2[0] ? truncate(ev2[0].text, 80) : "Best practice" });
      }
    }
    if (wantsSummary || !work.length) {
      const top = relevant(pool, own || input.title, 5, used);
      work.push("", "### What I found", "", ...(top.length ? top.map((t) => `- ${truncate(t.text, 260)}`) : ["- I don't have anything on file about this yet. Send me the details or a document and I'll take it from there."]));
      sources.push({ step: "Summary", status: top.length ? "Grounded in your materials" : "Needs your data", basis: top[0]?.source ?? "—" });
    }
    const dataNote = tables.length ? ` I used ${tables.map((t) => `${t.table.title} (${t.facts[0]})`).join(", ")}.` : "";
    lines.push(
      "## Summary",
      "",
      `Inside: ${listJoin(sources.map((x) => x.step.charAt(0).toLowerCase() + x.step.slice(1)).slice(0, 4))}.${timeLine ? ` This is built to take over ${/^about/.test(timeLine) ? timeLine : `the work you described on the call (“${truncate(timeLine, 160)}”)`}.` : ""}${dataNote}${decisions.length ? ` ${decisions.length} ${decisions.length === 1 ? "item needs" : "items need"} your decision below.` : ""}`,
    );
    if (prefs.length) lines.push("", `**Shaped by your preferences:** ${prefs.map((p) => truncate(p, 140)).join(" · ")}`);
    lines.push("", "## The work", ...work);
  }

  if (!decisions.length && rules.length) decisions.push(`Nothing goes out without approval, per your rule: “${truncate(rules[0]!, 160)}”.`);
  if (decisions.length) lines.push("", "## Needs your decision", "", ...[...new Set(decisions)].map((d) => `- ${d}`));
  if (needs.length) lines.push("", "## What I need from you", "", ...[...new Set(needs)].slice(0, 6).map((n) => `- ${n}`));
  lines.push("", "## How I put this together", "", "| # | Step | Status | Based on |", "|---|---|---|---|", ...sources.map((s, i) => `| ${i + 1} | ${cell(s.step)} | ${cell(s.status)} | ${cell(s.basis)} |`));

  const preview = truncate(
    wantsEmail
      ? `${input.title}: ${sources.length && /data/.test(sources[0]!.status) ? "follow-up emails drafted from your data" : "email drafted"} and waiting for your approval.`
      : `${input.title} is ready${decisions.length ? ` — ${decisions.length} ${decisions.length === 1 ? "item needs" : "items need"} your decision` : ""}.`,
    200,
  );
  return { title: input.title, kind: input.output, body: lines.join("\n").replace(/\n{3,}/g, "\n\n"), preview };
}

function needsFrom(step: string, memories: Snip[]): string[] {
  const out: string[] = [];
  const sys = memories.map((m) => /^Systems and tools mentioned: (.+)\.$/.exec(m.text)?.[1]).find(Boolean);
  const paren = /\(([^)]+)\)/.exec(step)?.[1];
  if (paren) for (const p of paren.split(/,\s*(?:and\s+)?|\s+and\s+/)) if (p.trim()) out.push(cap(p.trim()));
  if (sys && !paren) out.push(`Read-only access to ${sys} (a test login is fine to start).`);
  if (!out.length) out.push("The source data for this workflow (an export, a spreadsheet or a login).");
  return out;
}

function exampleRows(cols: string[], ev: Sent[], people: Array<{ name: string }>): string[][] {
  const names = ["Example A", "Example B"];
  const nums = ev.flatMap((e) => e.text.match(/\$[\d,]+(?:\.\d+)?|\b\d+ (?:days?|hours?|units?|claims?|patients?)\b/g) ?? []);
  return names.map((n, r) =>
    cols.map((c, i) => {
      if (i === 0) return `${n} (example)`;
      if (/status/i.test(c)) return r === 0 ? "Needs attention" : "OK";
      if (/action|next/i.test(c)) return r === 0 ? "Follow up today" : "None";
      if (/who|owner|assigned|tech/i.test(c)) return people[r]?.name ?? "—";
      if (/\$|amount|value|portion|price|max|deductible|total/i.test(c)) return "—";
      if (/\bdays?\b/i.test(c)) return r === 0 ? "6 days" : "1 day";
      if (/\btime\b/i.test(c)) return r === 0 ? "8:00 AM" : "9:30 AM";
      return "—";
    }),
  );
}

function checklistFrom(step: string, ev: Sent[]): string[] {
  const inner = /(?::|\()\s*([^)]+?)\)?\.?$/.exec(step)?.[1];
  const parts = inner ? inner.split(/,\s*(?:and\s+)?|;\s*/).map((p) => cap(p.trim())).filter((p) => p.length > 2) : [];
  const fromCall = ev.map((e) => truncate(e.text, 180));
  return [...parts, ...fromCall.map((f) => `Covered on the call: ${f}`)].slice(0, 8).concat(parts.length ? [] : ["Confirm the details above with the team before go-live"]);
}

function draftBlock(step: string, who: Who, people: Array<{ name: string; role: string | null }>, recipient: string | null, rules: string[], prefs: string[] = []): string[] {
  const audience = /\b(patient|homeowner|owner|client|customer|tenant|adjuster|vendor|buyer|member)s?\b/i.exec(step)?.[1]?.toLowerCase() ?? "customer";
  const isText = /\btexts?\b|\bsms\b/i.test(step) || (!/\bemails?\b/i.test(step) && prefs.some((p) => /\btexts?\b/i.test(p)));
  const pair = /\bfor (?:a |an |the )?([^,]+?),? and one for (?:a |an |the )?(.+?)(?:\s+[—–-]|\.|$)/i.exec(step);
  const variants = pair ? [cap(pair[1]!), cap(pair[2]!)] : /\bthree\b|first touch/i.test(step) ? ["First touch", "Second touch", "Last touch"] : /\btwo\b/i.test(step) ? ["Version 1", "Version 2"] : ["Draft"];
  const owe = /owe|money|balance/i.test(step);
  const out: string[] = [];
  const noMoney = rules.some((r) => /dollar amount|amounts?|price/i.test(r));
  variants.forEach((v, i) => {
    const greet = `Hi {${audience} first name},`;
    const msg =
      /reschedul/i.test(v)
        ? `This is ${who.agent} from ${who.org}. While getting ready for your visit tomorrow we found something with your coverage we'd like to sort out first, so you aren't surprised later. Could we move your appointment? Reply with a day that works and we'll take care of the rest.`
        : /owe|money/i.test(v) && !noMoney
          ? `This is ${who.agent} from ${who.org}. Before your visit tomorrow we checked your benefits, and part of the visit may not be covered. We'd like to walk you through it before you come in — reply here or call us and we'll explain your options.`
          : i === 0
        ? owe && !noMoney
          ? `This is ${who.agent} from ${who.org}. Before your visit tomorrow we checked your benefits, and part of the visit may not be covered. We'd like to walk you through it before you come in — reply here or call us and we'll explain your options.`
          : `This is ${who.agent} from ${who.org}, checking in. We wanted to make sure you have what you need from us and to help with the next step — just reply here.`
        : i === 1
          ? `Following up on my last note — happy to answer any questions or find a time that works for you.`
          : `Last check-in from me. If now isn't the right time, no problem — reply whenever you're ready and we'll pick it up.`;
    out.push(`**${v} (${isText ? "text" : "email"})**`, "", `> ${greet}`, ">", `> ${msg}`, ">", `> ${isText ? `— ${who.org}` : `Best,\n> ${who.agent}\n> ${who.org}`}`, "");
  });
  if (rules.length) out.push(`_Checked against your rules: ${rules.slice(0, 2).map((r) => `“${truncate(r, 150)}”`).join(" ")}_`);
  void people;
  void recipient;
  return out;
}
