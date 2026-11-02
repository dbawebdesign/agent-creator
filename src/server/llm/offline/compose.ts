/**
 * Offline work products. Deterministic, no model: builds the deliverable a workflow asks for from the procedure,
 * the knowledge base (including CSV / markdown tables found in it), memories and the triggering message —
 * shaped by kind (email drafts addressed to a person, tables built from real rows, reports with a summary and
 * "Needs your decision"), and revisions that apply the feedback to the previous draft.
 */
import { cell, normalizeWhitespace, tokenize, truncate } from "../text";
import { mentions, namedInTask } from "./quotes";
import { answerFromRows, asksForRows, closedRow, collectTables, columnsOf as tableColumns, describePlan, exclusionsFrom, namesIn, forbiddenTopics, linkFrom, nounOf, planRows, planTable, plural, renderDraft, rowDraft, splitSentences, type FileTable, type Plan } from "./tablework";

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
/** `trace` is the agency-facing "how I put this together" table: recorded in run_steps, never in the client's body. */
/** `data.substantive` is false when the body is a placeholder (format only, asks for data): no hours are credited for it. */
export type Composed = { title: string; kind: string; body: string; preview: string; trace?: string; data?: { substantive: boolean; basis?: string; rows?: number; sorted?: boolean; excluded?: number } };

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
    const r = /^Morning deliverables go to (Dr\. [A-Z][a-z]+|[A-Z][a-z]+)/.exec(m.text);
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

/** CSV / TSV / markdown tables inside retrieved knowledge chunks (a file's blocks merged across chunks). */
export function tablesIn(snips: Snip[]): DataTable[] {
  return collectTables(snips).map((t) => ({ title: t.title, headers: t.headers, rows: t.rows }));
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
      let hits = 0;
      for (const w of new Set(tokenize(s.text)))
        if (q.has(w)) {
          sc += Math.log((n + 1) / (df.get(w) ?? 1));
          hits++;
        }
      if (/\d/.test(s.text)) sc += 0.4;
      return { s, sc: hits >= 2 || q.size <= 2 ? sc : 0 };
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

const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FORMAL: Array<[RegExp, string]> = [
  [/\bHi ([^,\n]+),/g, "Dear $1,"],
  [/\bHello,/g, "Good morning,"],
  [/\bThanks so much,|\bThanks,|\bBest,/g, "Kind regards,"],
  [/\bwe'll\b/gi, "we will"],
  [/\bwe're\b/gi, "we are"],
  [/\bdon't\b/gi, "do not"],
  [/\bcan't\b/gi, "cannot"],
  [/\bit's\b/gi, "it is"],
  [/\bI'm\b/g, "I am"],
  [/\byou're\b/gi, "you are"],
  [/\blet's\b/gi, "let us"],
];
const FRIENDLY: Array<[RegExp, string]> = [
  [/\bDear ([^,\n]+),/g, "Hi $1,"],
  [/\bKind regards,|\bSincerely,|\bThank you,/g, "Thanks so much,"],
  [/\bwe will\b/gi, "we'll"],
  [/\bdo not\b/gi, "don't"],
  [/\bcannot\b/gi, "can't"],
];

/** Apply a change request to the previous version and say, in one line, what changed. */
function revise(input: ComposeInput, pool: Sent[]): Composed {
  const now = input.now ?? new Date();
  const who = whoAmI(input.system);
  const rules = rulesFrom(input.memories);
  const title = input.title.replace(/\s*\(revised\)$/i, "");
  const fb = normalizeWhitespace(/Feedback:\s*([\s\S]+?)(?:\n\s*\nOriginal|$)/.exec(input.body)?.[1] ?? "");
  let doc = /Original \([^\n]*\):\n([\s\S]*)$/.exec(input.body)?.[1] ?? "";
  doc = doc.replace(/^\*\*What changed:\*\*[^\n]*\n+/, "").replace(/^\n?## What changed[\s\S]*?(?=\n## |$)/, "").trim();
  const prefersText = input.memories.some((m) => m.kind === "preference" && /\btexts?\b|\balways text\b/i.test(m.text));

  // Work over an uploaded table: redo it on the rows with the note as extra criteria (filters, order, rows to leave out).
  const origSummary = /## Summary\s*\n+([^\n]+(?:\n[^\n#][^\n]*)*)/.exec(doc)?.[1] ?? "";
  const fileTables = collectTables(input.knowledge);
  const fbPlans = fileTables.map((t) => planRows(t, fb, [], now));
  // Rows named in the note ("remove Tank") or criteria on the columns ("only rabies", "most overdue first").
  const namesRows = fileTables.some((t) => namesIn(fb).some((n) => t.rows.some((r) => mentions(r.join(" | "), [n]))));
  const rowsAsked = fbPlans.some((x) => x.applied.length || x.sortedBy || x.excluded.length) || namesRows || /\b(?:actual list|the list|one row per|rows?\b|sort(?:ed)?\b)/i.test(fb);
  if (fileTables.length && rowsAsked) {
    // A new value filter in the note ("only rabies") replaces the old one instead of adding to it.
    const newValueFilter = fbPlans.some((x) => x.applied.some((a) => / is /.test(a)));
    const summaryText = (newValueFilter ? origSummary.replace(/\s*\([^)]*\bis\b[^)]*\)/, "") : origSummary).replace(/\bLeft out: /g, "Leave out ");
    // "Remove Tank" / "drop the Elm St. Rescue row" leave those rows out.
    const fbRows = fb.replace(/\b(?:remove|drop|delete|cut|take out|get rid of)\b/gi, "Leave out");
    const before = collectTables([{ title: "previous", text: doc }]).find((t) => t.headers.length > 2);
    const redo = tableWork({ ...input, kind: "workflow", title, body: `${summaryText}\n\n${fbRows}` }, `${summaryText}\n\n${fbRows}`, rules, who, now, prefersText);
    if (redo) {
      const n = redo.data?.rows ?? 0;
      const m = before ? before.rows.length : 0;
      const changed = [
        before ? (n !== m ? `${m} → ${n} rows` : `same ${n} rows`) : `turned it into the list from ${redo.data?.basis ?? "your file"} (${n} rows)`,
        /\bleave|left out|skip|remove|drop|exclude\b/i.test(fb) && (redo.data?.excluded ?? 0) > 0 ? `left out what you named` : null,
        /\bfirst\b|\bsort|\border\b/i.test(fb) ? (redo.data?.sorted ? "re-sorted as asked" : n > 1 ? "couldn't tell how to sort it, so it keeps the file's order" : null) : null,
        /\b(?:text|message|email|reminder)s?\b/i.test(fb) && /## (?:Reminder texts|Emails)/.test(redo.body) ? "one draft per row" : null,
      ].filter(Boolean);
      return { ...redo, title: input.title, body: `## What changed\n\n${cap(changed.join("; "))}.\n\n${redo.body}`, preview: truncate(`Revised “${title}”: ${changed.join("; ")}.`, 200) };
    }
  }

  const changes: string[] = [];
  const couldnt: string[] = [];
  const directives = fb
    .split(/(?<=[.!;])\s+|,?\s+and\s+(?=(?:use|show|add|include|remove|drop|make|change|replace|cut|keep|put|mention|say|lead|fix)\b)/i)
    .map((d) => d.trim().replace(/[.!;]+$/, ""))
    .filter((d) => d.length > 2);
  const addSections: string[] = [];
  const replacements: Array<[RegExp, string]> = [];
  const replace = (from0: string, to: string) => {
    let from = from0;
    let re = new RegExp(escRe(from), "gi");
    let n = (doc.match(re) ?? []).length;
    // "The booking link should be X": swap the value of the same shape (link, email, phone) when the words aren't there.
    if (!n) {
      const shape = /^\S+@\S+\.\S+$/.test(to) ? EMAIL_IN.source : /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/\S*$/.test(to) ? "(?:https?:\\/\\/)?[\\w-]+(?:\\.[\\w-]+)+\\/[\\w\\-./?=&%#]*" : /^\+?[\d\s().-]{7,}$/.test(to) ? "\\+?\\d[\\d\\s().-]{6,}\\d" : null;
      const host = /^(?:https?:\/\/)?([^/]+)/.exec(to)?.[1] ?? "";
      const cands = shape ? [...new Set(doc.match(new RegExp(shape, "g")) ?? [])].filter((c) => c !== to && (!host || c.includes(host.split(".").slice(-2).join(".")) || !/\//.test(to))) : [];
      if (cands.length === 1) {
        re = new RegExp(escRe(cands[0]!), "g");
        n = (doc.match(re) ?? []).length;
        from = cands[0]!;
      }
    }
    if (!n) {
      couldnt.push(`“${from}” isn't in the draft, so there was nothing to change to “${to}”`);
      return;
    }
    doc = doc.replace(re, to);
    replacements.push([re, to]);
    changes.push(`replaced “${from}” with “${to}” (${n} place${n === 1 ? "" : "s"})`);
  };
  for (const d0 of directives) {
    const d = d0.replace(/^(?:please|can you|could you|pls)\s+/i, "");
    let m: RegExpExecArray | null;
    if ((m = /\b(?:change|replace|swap|update)\s+["“]?(.+?)["”]?\s+(?:to|with|for)\s+["“]?(.+?)["”]?$/i.exec(d))) replace(m[1]!, m[2]!);
    else if ((m = /^["“]?(.+?)["”]?\s+(?:should be|should say|is actually|is really|needs to be)\s+["“]?(.+?)["”]?$/i.exec(d))) replace(m[1]!.replace(/^(?:the|it)\s+/i, ""), m[2]!);
    else if ((m = /^(?:it'?s|it is|that'?s)\s+["“]?(.+?)["”]?,?\s+not\s+["“]?(.+?)["”]?$/i.exec(d))) replace(m[2]!, m[1]!);
    else if ((m = /\bnot\s+["“]?(.+?)["”]?,?\s+but\s+["“]?(.+?)["”]?$/i.exec(d))) replace(m[1]!, m[2]!);
    else if ((m = /\b(?:remove|drop|delete|cut|take out|leave out|get rid of)\s+(?:the\s+|all\s+)?(.+?)(?:\s+(?:row|rows|line|lines|entry|entries|section|part|bit))?(?:\s+(?:from (?:it|this|the \w+)|entirely|completely))?$/i.exec(d))) {
      const key = m[1]!.toLowerCase().replace(/^["“]|["”]$/g, "");
      const before = doc.split("\n").length;
      const sections = doc.split(/\n(?=## )/);
      const kept = sections.filter((sec) => !sec.toLowerCase().split("\n")[0]!.replace(/^#+\s*/, "").includes(key));
      doc = kept.join("\n");
      // Rows and draft blocks that name it.
      doc = doc
        .split(/\n(?=#### )/)
        .filter((blk) => !(/^#### /.test(blk) && blk.toLowerCase().split("\n")[0]!.includes(key)))
        .join("\n")
        .split("\n")
        .filter((l) => !l.toLowerCase().includes(key) || /^#/.test(l))
        .join("\n");
      const gone = Math.max(0, before - doc.split("\n").length);
      if (gone) changes.push(`removed ${m[1]} (${gone} line${gone === 1 ? "" : "s"})`);
      else couldnt.push(`“${m[1]}” isn't in the draft, so nothing was removed`);
    } else if (/\b(?:shorter|too long|trim|tighten|concise|cut it down|less wordy|brief)\b/i.test(d)) {
      const before = doc.length;
      doc = doc
        .split(/\n(?=## )/)
        .map((sec) => {
          let bullets = 0;
          return sec
            .split("\n")
            .filter((l) => !/^\s*[-*] /.test(l) || ++bullets <= 2)
            .join("\n");
        })
        .join("\n")
        .replace(/^(?!\|)([^\n#>|-][^\n]{220,})$/gm, (para) => splitSentences(para).slice(0, 2).join(" "));
      changes.push(`shorter (${Math.round((100 * (before - doc.length)) / Math.max(1, before))}% cut; tables kept whole)`);
    } else if (/\b(?:longer|more detail|more detailed|expand|flesh (?:it )?out|elaborate)\b/i.test(d)) {
      const more = relevant(pool, `${title} ${doc.slice(0, 1500)}`, 4, new Set()).filter((x) => !doc.includes(x.text));
      if (more.length) {
        addSections.push(["## More detail", "", ...more.map((x) => `- ${truncate(x.text, 240)}`)].join("\n"));
        changes.push(`longer: added ${more.length} details from your files`);
      } else couldnt.push("I have no more detail on file to add — send me what should go in and I'll add it");
    } else if (/\b(?:more formal|formal|professional|less casual)\b/i.test(d)) {
      const was = doc;
      for (const [re, to] of FORMAL) doc = doc.replace(re, to);
      changes.push(doc === was ? "tone was already formal" : "more formal tone (greetings, sign-offs, no contractions)");
    } else if (/\b(?:friendlier|warmer|more casual|less formal|more personal|friendly|warm)\b/i.test(d)) {
      const was = doc;
      for (const [re, to] of FRIENDLY) doc = doc.replace(re, to);
      changes.push(doc === was ? "tone kept warm (it already was)" : "friendlier tone (greetings, sign-offs, contractions)");
    } else if ((m = /\b(?:use|apply|switch to)\s+(?:our\s+|the\s+)?(.+?)\s+(?:brand\s+)?colou?rs?\b/i.exec(d))) {
      doc = doc.replace(/^(## [^\n]+\n)/, `$1\n**Brand:** ${m[1]} — headings and table headers in ${m[1]!.split(/\s+and\s+/)[0]}, accents in ${m[1]!.split(/\s+and\s+/)[1] ?? m[1]}.\n`);
      changes.push(`applied your ${m[1]} brand colors`);
    } else if (/\b(?:generic|vague|more specific|specifics|be specific|not specific)\b/i.test(d)) {
      const specifics = relevant(pool, `${title} ${doc.slice(0, 2000)}`, 5, new Set()).filter((x) => /\d|[A-Z][a-z]+ [A-Z]/.test(x.text));
      if (specifics.length) {
        addSections.unshift(["## Specific to you", "", ...specifics.map((x) => `- ${truncate(x.text, 240)}`)].join("\n"));
        changes.push(`more specific: ${specifics.length} facts from your materials`);
      } else couldnt.push("I have nothing more specific on file — send me a recent example and I'll match it");
    } else if ((m = /\b(?:show|add|include|list|break out|put in|mention)\s+(.+)$/i.exec(d))) {
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
        changes.push(`added ${what} (${cols.length} columns)`);
      } else {
        const ev = relevant(pool, what, 3, new Set());
        if (ev.length) {
          addSections.push([`## ${cap(truncate(what, 60))}`, "", ...ev.map((e) => `- ${truncate(e.text, 240)}`)].join("\n"));
          changes.push(`added a section on ${truncate(what.replace(/^(?:a\s+)?(?:section|part|note)\s+(?:on|about|for)\s+(?:the\s+)?/i, ""), 60)} (${ev.length} note${ev.length === 1 ? "" : "s"} from your files)`);
        } else couldnt.push(`I have nothing on file for “${truncate(what, 80)}” — send me the details and I'll add them`);
      }
    } else {
      couldnt.push(`I couldn't apply “${truncate(d, 120)}” on my own — tell me the exact change (e.g. “change X to Y”, “remove the Z rows”, “make it shorter”)`);
    }
  }
  const added = addSections.map((sec) => replacements.reduce((x, [re, to]) => x.replace(re, to), sec));
  const line = changes.length ? `${changes.map(cap).join("; ")}.${couldnt.length ? ` Not changed: ${couldnt.join("; ")}.` : ""}` : `Nothing changed: ${couldnt.join("; ") || "the note didn't ask for a change I could make"}.`;
  const body = ["## What changed", "", line, "", doc, ...added.map((x) => `\n${x}`)].join("\n").replace(/\n{3,}/g, "\n\n");
  return { title: input.title, kind: input.output, body, preview: truncate(`Revised “${title}”: ${changes[0] ?? "no change applied"}.`, 200), data: { substantive: changes.length > 0 } };
}

// ───────────────────────────────────────────── table work ─────────────────────────────────────────────

/** The part of a task that says what to do with the data (first deliverable: the ask, not the borrowed procedure). */
function taskTextOf(input: ComposeInput, own: string): string {
  if (input.kind === "first_deliverable") {
    const why = /\n\s*\nWhy: ([\s\S]*)$/.exec(input.body)?.[1] ?? "";
    const ask = (own.split(/\n\s*\nFollow the procedure/)[0] ?? own).replace(/^Produce “[^”]*” tonight\s*—\s*/i, "");
    return `${input.title}. ${ask} ${why}`;
  }
  return `${input.kind === "workflow" ? `${input.title}. ` : ""}${own}`;
}

/** Which uploaded table a task is about: named by file, or the one whose headers / values it talks about. */
function tableFor(text: string, tables: FileTable[], rules: string[], now: Date): Plan | null {
  const lower = text.toLowerCase();
  let best: { p: Plan; score: number } | null = null;
  for (const t of tables) {
    if (!t.rows.length) continue;
    const p = planRows(t, text, rules, now);
    const named = lower.includes(t.title.toLowerCase()) || lower.includes(t.title.toLowerCase().replace(/\.[a-z]+$/, "").replace(/[_-]+/g, " "));
    const headerHits = t.headers.filter((h) => tokenize(h.replace(/_/g, " ")).some((w) => w.length >= 4 && new RegExp(`\\b${w}`).test(lower))).length;
    const score = (named ? 5 : 0) + p.applied.length * 2 + (p.sortedBy ? 2 : 0) + p.excluded.length + headerHits * 0.5;
    if ((named || p.applied.length || p.sortedBy) && (!best || score > best.score)) best = { p, score };
  }
  return best?.p ?? null;
}

const wantsRowDrafts = (text: string) =>
  /\b(?:draft|write|prepare|compose)\b[^.]*\b(?:texts?|sms|emails?|reminders?|messages?|notes?)\b|\b(?:reminder|follow-up|renewal) (?:texts?|emails?|messages?)\b|\b(?:texts?|emails?|messages?|reminders?) drafted\b/i.test(text) && /\b(?:each|every|per|all|one for|for the|owners?|clients?|customers?|contacts?)\b/i.test(text);

/** A table / list task over an uploaded file, done on the rows. Null when no uploaded table fits the task. */
function tableWork(input: ComposeInput, own: string, rules: string[], who: Who, now: Date, prefersText: boolean): Composed | null {
  const tables = collectTables(input.knowledge);
  if (!tables.length) return null;
  // Feedback the client gave on an earlier run of this same work applies to this run too.
  const past = input.memories.map((m) => new RegExp(`^Feedback on “${escRe(input.title.replace(/\s*\(revised\)$/i, ""))}”:\s*(.+)$`, "i").exec(m.text)?.[1]).filter((x): x is string => !!x);
  const text = [taskTextOf(input, own), ...past].join("\n\n");
  if (!asksForRows(text) && input.output !== "table") return null;
  const p = tableFor(text, tables, rules, now);
  if (!p) return null;
  const noun = nounOf(p);
  const lines: string[] = [];
  const decisions: string[] = [];
  const subj = (r: string[]) => (p.cols.subject >= 0 ? r[p.cols.subject] : r[0]) ?? "row";
  const person = (r: string[]) => (p.cols.person >= 0 ? r[p.cols.person] : null);
  const nameOf = (r: string[]) => `${subj(r)}${person(r) && person(r) !== subj(r) ? ` (${person(r)})` : ""}`;
  const odOf = (r: string[]) => (p.cols.overdue >= 0 ? Number(r[p.cols.overdue]) : p.derived?.values.get(r));

  const drafts = wantsRowDrafts(text)
    ? p.rows.filter((r) => !p.noContact.some((x) => x.row === r) && !closedRow(p, r, text)).slice(0, 25).map((r) =>
        rowDraft(p, r, {
          org: who.org,
          agent: who.agent,
          channel: /\btexts?\b|\bsms\b/i.test(text) || (prefersText && !/\bemails?\b/i.test(text)) ? "text" : "email",
          link: linkFrom(input.knowledge),
          topic: null,
          forbidden: forbiddenTopics(rules),
          now,
          addressed: input.kind === "workflow",
        }),
      )
    : [];
  const top = p.rows[0];
  const topOd = top ? odOf(top) : undefined;
  const summary = [describePlan(p, noun)];
  if (top && p.sortedBy === "most overdue first" && topOd != null && Number.isFinite(topOd) && topOd > 0) summary.push(`${subj(top)} is the most overdue at ${topOd} days.`);
  else if (top && p.sortedBy && /soonest first/.test(p.sortedBy) && p.cols.due >= 0) summary.push(`Soonest: ${subj(top)} on ${top[p.cols.due]}.`);
  if (drafts.length) {
    const heldN = drafts.filter((d) => d.held).length;
    summary.push(`${drafts.length} ${drafts[0]!.channel === "text" ? (drafts.length === 1 ? "reminder text" : "reminder texts") : drafts.length === 1 ? "email" : "emails"} drafted below, one per ${p.cols.person >= 0 ? norm1(p.table.headers[p.cols.person]!) : noun}${heldN ? `; ${heldN} ${heldN === 1 ? "waits" : "wait"} for sign-off` : ""}. Nothing is sent until you approve.`);
  }
  const closed = p.rows.filter((r) => closedRow(p, r, text));
  if (closed.length && wantsRowDrafts(text)) summary.push(`No draft for ${closed.map(nameOf).join(", ")}: the status says the policy or account is closed.`);
  if (p.noContact.length) summary.push(`No draft for ${p.noContact.map((x) => nameOf(x.row)).join(", ")} — ${[...new Set(p.noContact.map((x) => x.why))].join("; ")}`.replace(/([^.”])$/, "$1."));
  if (p.excluded.length) summary.push(`Left out: ${p.excluded.map((e) => nameOf(e.row)).join(", ")} — ${[...new Set(p.excluded.map((e) => e.why))].join("; ")}`.replace(/([^.”])$/, "$1."));
  lines.push("## Summary", "", summary.join(" "));
  if (p.unmapped.length) lines.push("", `_Note: ${cap(p.unmapped[0]!)}${p.applied.length ? "" : "; showing every row"}._`);
  lines.push("", `## ${p.rows.length ? cap(plural(noun)) : "Result"}`, "");
  if (p.rows.length) lines.push(...planTable(p, text));
  else lines.push(`No ${plural(noun)} in ${p.table.title} match${p.applied.length ? ` ${p.applied.join(", ")}` : ""}.`);
  if (drafts.length) {
    lines.push("", `## ${drafts[0]!.channel === "text" ? "Reminder texts" : "Emails"}`, "");
    for (const d of drafts) lines.push(...renderDraft(d));
    if (drafts[0]!.channel === "email" && input.kind !== "workflow") lines.push("_Not addressed yet: the addresses are in the table. Name one person in your request, or run this as a workflow, and I'll address the drafts for approval._", "");
    const undrafted = p.rows.length - p.noContact.length - drafts.length;
    if (undrafted > 0) lines.push(`_${undrafted} more rows are in the table above; I draft the first ${drafts.length} per run._`, "");
  }
  for (const h of p.held) decisions.push(`${nameOf(h.row)}: ${h.why}${h.who ? "" : ""} — the draft is ready but stays with you until it is signed off.`);
  const fb = forbiddenTopics(rules);
  if (drafts.length && rules.length) decisions.push(`Checked against your rules${fb.length ? ` (nothing about ${fb.join(" or ")})` : ""}: ${rules.slice(0, 3).map((r) => `“${truncate(r, 110)}”`).join(" ")}`);
  if (decisions.length) lines.push("", "## Needs your decision", "", ...decisions.map((d) => `- ${d}`));
  const preview = truncate(
    `${p.rows.length} ${p.rows.length === 1 ? noun : plural(noun)}${p.applied.length ? ` where ${p.applied[0]}` : ""}${p.sortedBy ? `, ${p.sortedBy}` : ""}${drafts.length ? `, with ${drafts.length} ${drafts[0]!.channel === "text" ? "texts" : "emails"} drafted` : ""}.`,
    200,
  );
  const trace = [
    "| # | Step | Status | Based on |",
    "|---|---|---|---|",
    `| 1 | Read ${cell(p.table.title)} | ${p.table.rows.length} of ${p.table.total ?? p.table.rows.length} rows | ${cell(p.table.title)} |`,
    `| 2 | Filter and sort | ${cell(p.applied.join(", ") || "none")}${p.sortedBy ? `; ${cell(p.sortedBy)}` : ""} | The instructions |`,
    `| 3 | Drafts | ${drafts.length} | ${cell(p.cols.person >= 0 ? p.table.headers[p.cols.person]! : "—")} column |`,
  ].join("\n");
  return { title: input.title, kind: input.output === "email_draft" ? "document" : input.output, body: lines.join("\n").replace(/\n{3,}/g, "\n\n"), preview, trace, data: { substantive: true, basis: p.table.title, rows: p.rows.length, sorted: !!p.sortedBy && p.rows.length > 1, excluded: p.excluded.length + p.noContact.length } };
}

const norm1 = (h: string) => h.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+name$/, "").trim();

// ───────────────────────────────────────────── main ─────────────────────────────────────────────

export function compose(input: ComposeInput): Composed {
  const now = input.now ?? new Date();
  const who = whoAmI(input.system);
  const facts = input.memories.filter((m) => m.kind !== "preference");
  const pool = sentencesFrom([...input.knowledge, ...facts]);
  if (input.kind === "revision") return revise(input, pool);

  const own = ownWordsOf(input.body);
  const ev = eventOf(input.body);
  const steps = stepsOf(own).filter((s) => !/^(?:deliver it as one document|lead with|hard rules? from the call|rules? from the call)/i.test(s));
  const rules = rulesFrom(input.memories);
  const people = peopleFrom(input.memories);
  const recipient = recipientFrom(input.memories);
  const prefs = input.memories.filter((m) => m.kind === "preference").map(memText).filter((p) => p.split(/\s+/).length >= 4).slice(0, 3);
  const tables = tablesIn(input.knowledge).map((t) => analyze(t, now));
  const used = new Set<string>();

  // A direct request is answered as asked.
  const req = input.kind === "message" || input.kind === "task" ? own : "";
  // A proposal or bid is a document (scope, pricing, terms), not an email — even when the workflow says "draft".
  const wantsProposal = /\b(?:proposals?|bids?|quotes? for)\b/i.test(`${input.title} ${req}`) && !/\b(?:email|reply)\b/i.test(req) && input.kind !== "first_deliverable";
  const wantsEmail = !wantsProposal && (/\b(?:draft|write|compose|prepare)\b[^.]*\b(?:email|e-mail|letter|reply|message|text)\b/i.test(req) || (input.output === "email_draft" && !/template|kit|playbook|queue/i.test(input.title)));
  const wantsSummary = /\bsummari[sz]e|\bsummary of\b|\brecap\b/i.test(req);
  // Work over an uploaded table (filter, sort, one draft per row) is done on the rows themselves.
  const prefersText = input.memories.some((m) => m.kind === "preference" && /\btexts?\b|\balways text\b/i.test(m.text));
  const procedurePlans = input.kind !== "message" && input.kind !== "task" && collectTables(input.knowledge).some((t) => {
    const pl = planRows(t, taskTextOf(input, own), rules, now);
    return pl.applied.length > 0 || !!pl.sortedBy;
  });
  if (!wantsProposal && !(wantsEmail && (namedIn(req, who).length || /#?\b[A-Z]{2,}-?\d{3,}\b/.test(req) || (input.kind !== "message" && input.output === "email_draft" && !procedurePlans)))) {
    const tw = tableWork(input, own, rules, who, now, prefersText);
    if (tw) return tw;
  }
  const decisions: string[] = [];
  const needs: string[] = [];
  const lines: string[] = [];
  const sources: Array<{ step: string; status: string; basis: string }> = [];

  // Time / money context the owner gave on the call.
  const hours = facts.map((f) => /~(\d+(?:\.\d+)?) hours\/week/.exec(f.text)?.[1]).find(Boolean);
  const timeLine = (() => {
    const own1 = facts.map((f) => new RegExp(`^${input.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: currently ~(\\d+(?:\\.\\d+)?) hours/week`).exec(f.text)?.[1]).find(Boolean);
    if (own1) return `about ${own1} hours a week of manual work today`;
    if (input.kind === "workflow") return null;
    const s = pool.find((p) => /\b\d+(?:\.\d+)? hours? (?:a|per|every) (?:week|day|month)\b/i.test(p.text) && relevant([p], `${input.title} ${own}`, 1, new Set()).length);
    return s?.text ?? (hours ? `about ${hours} hours a week of manual work today` : null);
  })();

  if (wantsProposal) {
    lines.push(...proposalDoc(input, who, tables, pool, steps, own));
    decisions.push("Review the scope and pricing, then send it to the client yourself or ask me to draft the cover email.");
    sources.push({ step: "Proposal", status: tables.some(isRateTable) ? "Priced from your rate guide" : "Scope from your materials", basis: tables.find(isRateTable)?.table.title ?? "Your materials" });
  } else if (wantsEmail) {
    // Who it goes to: the triggering sender, a named party in the request, or each stale row in the data.
    const ref = /#?\b([A-Z]{2,}-?\d{3,})\b/.exec(req || own)?.[1] ?? null;
    const party = /\bto (?:the |our )?([A-Z][\w&.-]*(?: [A-Z][\w&.-]*)?)?\s*(adjuster|owner|client|customer|patient|tenant|vendor|homeowner|buyer|carrier)\b/i.exec(req);
    const drafts: Array<{ label: string; e: EmailDraft; text?: string }> = [];
    let noDraftReason: string | null = null;
    let targetedFrom: string | null = null;
    const data = tables.find((t) => t.rows.length && (!ref || t.rows.some((r) => r.join(" ").includes(ref))));
    const rowsFor = data ? (ref ? data.rows.filter((r) => r.join(" ").includes(ref)) : data.staleCol != null ? data.rows.filter((r) => Number(r[data.staleCol!]) >= 5) : data.rows).slice(0, 5) : [];
    const col = (t: Analysis, re: RegExp) => t.headers.findIndex((h) => re.test(h));
    // A request that names someone ("a reply to Lorna Fitch at Bayside") goes to that match only, or to nobody.
    const named = !ref && !ev?.from ? namedIn(req, who) : [];
    const explicit = EMAIL_IN.exec(req)?.[0] ?? null;
    if (named.length || (explicit && !ev?.from)) {
      const target = findRecipient(named, explicit, tables, input.knowledge);
      const answer = answerFromTables(req, tables, named);
      const barred = target ? exclusionsFrom("", rules).find((x) => x.names.some((n) => mentions([target.person ?? "", target.label ?? "", ...(target.row?.r ?? [])].join(" | "), [n]))) : undefined;
      if (target && barred) {
        noDraftReason = `${barred.why.replace(/^your rule/, "Your rule")}, so I haven't drafted anything to ${target.person ?? target.email}.`;
      } else if (!target) {
        noDraftReason = `I couldn't find ${listJoin(named.slice(0, 2).map((n) => `“${n}”`)) || "that recipient"} in your knowledge base or contacts, so there is no email address to draft to.`;
        if (answer.length) lines.push("## What your data says", "", ...answer.map((a) => `- ${a}`), "");
        needs.push(`${named[0] ?? "The recipient"}'s email: add it to your contacts or to a tracker in the knowledge base (or put the address in your request) and ask again.`);
      } else {
        const first = target.person ? firstName(target.person) : null;
        const reminder = target.row ? rowReminder(target.row.t, target.row.r, req, who, input.knowledge, rules, now) : null;
        if (reminder) {
          drafts.push({ label: reminder.label, e: { to: reminder.channel === "text" ? "" : reminder.to, subject: reminder.subject ?? "", body: reminder.body }, text: reminder.channel === "text" ? reminder.to : undefined });
        } else {
          const facts = target.facts.length ? ["", `Here is where things stand${target.label ? ` for ${target.label}` : ""}:`, "", ...target.facts.map((f) => `- ${f}`)] : [];
          const body = [
            first ? `Hi ${first},` : "Hello,",
            "",
            ev?.text ? `Thanks for your note${target.label ? ` about ${target.label}` : ""}.` : `A quick note${target.label ? ` about ${target.label}` : ""} from ${who.org}.`,
            ...facts,
            "",
            "Let me know if you have any questions or need anything else from us.",
            "",
            "Thank you,",
            who.agent,
            who.org,
          ].join("\n");
          drafts.push({ label: `To ${target.person ?? target.email}`, e: { to: target.person ? `${target.person} <${target.email}>` : target.email, subject: `${ev?.text ? "Re: " : ""}${target.label ?? truncate(input.title, 80)}`, body } });
        }
        if (answer.length) lines.push("## What your data says", "", ...answer.map((a) => `- ${a}`), "");
        targetedFrom = target.source;
      }
    } else if (data && rowsFor.length) {
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
        const nm = nameC >= 0 && r[nameC] ? r[nameC]! : rowLabel(data, r);
        groups.set(nm, [...(groups.get(nm) ?? []), r]);
      }
      const noun = /claim/i.test(data.headers[idC] ?? "") || /claim/i.test(`${input.title} ${own}`) ? "claim" : "item";
      for (const [nm, rs] of groups) {
        const ids = rs.map((r) => (idC >= 0 ? r[idC]! : ref ?? "")).filter(Boolean);
        const lineFor = (r: string[]) => {
          const id = idC >= 0 ? r[idC] : ref;
          const days = data.staleCol != null ? r[data.staleCol] : null;
          return `${id ? `${noun === "claim" ? "Claim " : ""}${id}` : rowLabel(data, r)}${whatC >= 0 && r[whatC] ? ` — ${r[whatC]!.toLowerCase()}` : ""}${days && days !== "—" ? `, ${days} days since we last heard back` : ""}`;
        };
        const body = [
          nameC >= 0 && r0Name(rs, nameC) ? `Hi ${firstName(nm)},` : "Hello,",
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
          e: { to: mail ? `${nm} <${mail}>` : nm, subject: ids.length ? `${`${noun === "claim" ? (ids.length > 1 ? "Claims" : "Claim") : ""} ${ids.join(", ")}`.trim()}: next steps` : `${rowLabel(data, rs[0]!)}: next steps`, body },
        });
      }
    } else if (!ev?.from) {
      // Nobody to write to: no sender, no one named in the data. Say what's missing instead of drafting to a guess.
      noDraftReason = data
        ? `None of the rows in ${data.table.title} match this request, so there is no one to draft to yet.`
        : "There is no recipient to draft to yet: the request doesn't name anyone I can find in your files.";
      needs.push(`Who it goes to: name the person (as they appear in your tracker or contacts) or include their email${ref ? ` for ${ref}` : ""}.`);
    } else {
      const to = ev.from;
      const about = ev?.subject ?? (ref ? `${ref}` : input.title.replace(/^Message:\s*/i, ""));
      const facts2 = relevant(pool, `${about} ${req || own}`, 2, used);
      facts2.forEach((f) => used.add(f.text));
      const body = [
        (() => {
          const nm = String(to).replace(/<.*>/, "").trim();
          return nm && !nm.includes("@") ? `Hi ${firstName(nm)},` : "Hello,";
        })(),
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
    }
    lines.unshift(
      "## Summary",
      "",
      drafts.length
        ? `${drafts.length} ${drafts.some((d) => d.text != null) ? (drafts.length === 1 ? "text is" : "texts are") : drafts.length === 1 ? "email is" : "emails are"} drafted and ready for your approval${targetedFrom ? `, addressed from ${targetedFrom}` : data ? `, built from ${data.table.title} (${data.facts.slice(0, 2).join("; ")})` : ""}. Nothing is sent until you approve it.`
        : `No email drafted. ${noDraftReason ?? "There is no recipient to draft to yet."}`,
      "",
    );
    if (drafts.length) {
      lines.push("", "## The work");
      for (const d of drafts) lines.push("", ...(d.text != null ? [`### ${d.label}`, "", `Text to ${d.text}`, "", ...d.e.body.split("\n").map((l) => (l ? `> ${l}` : ">"))] : renderEmail(d.e, d.label)));
    }
    if (rules.length && drafts.length) {
      const kept = [/dollar|amount|price/i.test(rules.join(" ")) ? "dollar amounts" : null, /\bdates?\b/i.test(rules.join(" ")) ? "dates" : null, /deductible/i.test(rules.join(" ")) ? "deductibles" : null].filter((x): x is string => !!x);
      decisions.push(`Check the ${drafts.length === 1 ? "draft" : "drafts"} against your rules: ${rules.slice(0, 3).map((r) => `“${truncate(r, 120)}”`).join(" ")}${kept.length ? ` — I kept out ${listJoin(kept)}.` : ""}`);
    }
    sources.push({ step: "Email drafts", status: drafts.length ? (targetedFrom || data ? "Built from your data" : "Drafted from your request") : "Not drafted: no recipient", basis: targetedFrom ?? (data ? data.table.title : "Your request") });
  } else {
    // Report / document / table: summary, the work products the steps ask for, what was checked, decisions, needs.
    const work: string[] = [];
    const did: string[] = [];
    const outputs: string[] = [];
    // Things a report covers / a check captures ("cover: rent collected, delinquencies, …").
    const coverStep = steps.find((st) => /\b(?:cover|capture|covering|including|include)\b[^:]*:\s*\S/i.test(st));
    const items = coverStep ? (/:\s*(.+?)\.?$/.exec(coverStep)?.[1] ?? "").split(/,\s*(?:and\s+)?|\s+and\s+(?=[a-z]+$)/).map((x) => x.trim()).filter((x) => x.length > 1 && x.length < 60) : [];
    for (const step of steps) {
      const head = headingOf(step);
      if (/\b(?:list exactly|list the exact|what (?:access|data) you (?:still )?need|say exactly which|what you need to|exact data you still need)\b/i.test(step)) {
        needs.push(...needsFrom(step, input.memories));
        const dec = /needs? a decision\s*\(([^)]+)\)/i.exec(step)?.[1];
        if (dec) for (const x of dec.split(/,\s*(?:and\s+)?/)) decisions.push(`Decide: ${x.trim()}.`);
        continue;
      }
      if (/\brequest approval\b/i.test(step)) {
        const what = /\bbefore ([^(;]+?)(?:\s*\(|;|\.$|$)/i.exec(step.slice(step.search(/request approval/i)))?.[1];
        decisions.push(`Approve ${what ? `before ${what.trim()}` : "each draft before it goes out"} — nothing is sent until you do.`);
        if (!/\b(?:write|draft|build|deliver)\b/i.test(step.replace(/request approval[\s\S]*$/i, ""))) continue;
      }
      const ev2 = relevant(pool, step, 2, used);
      ev2.forEach((e) => used.add(e.text));
      const cols = columnsOf(step);
      const isLetter = /\b(?:write|draft)\b/i.test(step) && /\b(?:letter|report|summary|update)\b/i.test(step) && !/\btemplate\b/i.test(step);
      if (isLetter) {
        const aud = /\beach ([a-z]+)'?s?\b/i.exec(step)?.[1] ?? "client";
        const rowsOf = items.length ? items : ["Key figure 1", "Key figure 2", "Key figure 3"];
        work.push("", `### ${head}`, "", `> Hi {${aud} first name},`, ">", `> Here is your summary for {period}. {One-sentence headline: the biggest change and whether anything needs you.}`, ">");
        work.push(...gfm(["", "This period", "Last period", "Change"], rowsOf.map((r) => [cap(r), "{from records}", "{from records}", "—"])).map((l) => `> ${l}`));
        const voice = /\bin ([A-Z][a-z]+)'s voice\b/.exec(step)?.[1];
        work.push(">", "> **Worth knowing:** {1–3 short points — anything unusual or that needs a decision}", ">", `> Best,\n> ${voice ?? who.agent}`, "", `_One letter per ${aud}; the figures fill in from the records each run._`);
        outputs.push(head);
        sources.push({ step: head, status: "Drafted — figures fill from your records", basis: items.length ? "Sections named on the call" : "The call" });
      } else if (/\btemplate\b/i.test(step) && /\(([^)]+)\)/.test(step) && !/\bemail|text|message\b/i.test(step)) {
        const parts = /\(([^)]+)\)/.exec(step)![1]!.split(/,\s*(?:and\s+)?/).map((x) => x.trim()).filter(Boolean);
        work.push("", `### ${head}`);
        for (const part of parts) {
          work.push("", `**${cap(part)}**`, "");
          if (/table|options|line items/i.test(part)) work.push(...gfm(["Option", "Description", "Unit price", "Quantity", "Total", "Lead time"], [["Good", "{item}", "{price}", "{qty}", "{total}", "{days}"], ["Better", "{item}", "{price}", "{qty}", "{total}", "{days}"], ["Best", "{item}", "{price}", "{qty}", "{total}", "{days}"]]));
          else if (/terms/i.test(part)) work.push("- Prices valid for 30 days · {minimums} · {payment terms}", "- Lead times start when the order and any artwork or specs are approved");
          else if (/intro|summary|greeting/i.test(part)) work.push(`Hi {first name}, thanks for the request. Below are three options for {what they asked for}, from best value to premium, with pricing and lead times. — ${who.agent}, ${who.org}`);
          else work.push(`{${part}}`);
        }
        outputs.push(head);
        sources.push({ step: head, status: "Drafted", basis: "Your format from the call" });
      } else if (cols.length || /\bGFM table\b/i.test(step)) {
        const many = /\b(three|two|four|3|2|4) sample\b/i.exec(step)?.[1];
        const count = many ? ({ two: 2, three: 3, four: 4 } as Record<string, number>)[many.toLowerCase()] ?? Number(many) : 0;
        if (count && !tables.length) {
          const c = cols.length ? cols : ["Item", "Quantity", "Unit price", "Total"];
          work.push("", `### ${head}`);
          const kinds = relevant(pool, step, count, used).map((e) => truncate(e.text, 140));
          for (let i = 0; i < count; i++) {
            work.push("", `**Sample ${i + 1}${kinds[i] ? ` — based on: “${kinds[i]}”` : ""}**`, "", ...gfm(c, exampleRows(c, [], people)));
          }
          work.push("", "_Prices stay as placeholders until I have your price lists; the structure is final._");
          outputs.push(head);
          sources.push({ step: head, status: "Format ready — needs your price lists", basis: kinds[0] ?? "The call" });
          continue;
        }
        const matched = tables.find((t) => cols.some((c) => t.headers.some((h) => tokenize(h).some((w) => tokenize(c).includes(w)))) || (!cols.length && t.rows.length));
        // Real rows on file always beat example rows: show the file, and say which columns it lacks.
        const data = matched ?? tables.find((t) => t.rows.length);
        work.push("", `### ${head}`);
        if (data) {
          const missing = matched ? [] : cols.filter((c) => !data.headers.some((h) => tokenize(h).some((w) => tokenize(c).includes(w))));
          work.push("", `From **${data.table.title}**: ${data.facts.join("; ")}.${missing.length ? ` It has no ${listJoin(missing.map((m) => m.toLowerCase()))} column, so those are left out — add them to the file and I'll fill them in.` : ""}`, "", ...gfm(data.headers, data.rows.slice(0, 25)));
          if (data.flagged) decisions.push(`${data.flagged} ${data.flagged === 1 ? "item needs" : "items need"} a follow-up today (flagged in “${head}”).`);
          sources.push({ step: head, status: "Built from your data", basis: data.table.title });
        } else {
          const c = cols.length ? cols : ["Item", "Detail", "Status", "Next step"];
          work.push("", ...gfm(c, exampleRows(c, ev2, people)), "", "_Rows marked “example” show the format; real rows fill in as soon as I can read the source data._");
          sources.push({ step: head, status: "Format ready — needs your data", basis: ev2[0] ? truncate(ev2[0].text, 80) : "The call" });
        }
        outputs.push(head);
      } else if (/\bdraft\b|\bscript\b|\btemplate\b|\bmessages?\b|\bemails?\b|\btexts?\b/i.test(step) && /\b(?:draft|write|build|prepare)\b/i.test(step)) {
        const textPref = input.memories.some((m) => m.kind === "preference" && /\btexts?\b|\balways text\b/i.test(m.text));
        work.push("", `### ${head}`, "", ...draftBlock(step, who, people, recipient, rules, textPref ? [...prefs, "prefers texts"] : prefs));
        outputs.push(head);
        sources.push({ step: head, status: "Drafted", basis: ev2[0] ? truncate(ev2[0].text, 80) : "The call" });
      } else if (/\bchecklist\b|\brules?\b|\bplaybook\b|\brunbook\b/i.test(step) && /\b(?:write|build|draft)\b/i.test(step)) {
        work.push("", `### ${head}`, "", ...checklistFrom(step, ev2).map((i) => `- [ ] ${i}`));
        outputs.push(head);
        sources.push({ step: head, status: "Written from the call", basis: ev2[0] ? truncate(ev2[0].text, 80) : "The call" });
      } else if (step === coverStep || /^deliver\b/i.test(step)) {
        continue;
      } else {
        // A process step (pull, compare, check…): report what happened this run instead of padding a section.
        const known = (input.memories.map((m) => /^Systems and tools mentioned: (.+)\.$/.exec(m.text)?.[1]).find(Boolean) ?? "").split(/,\s*/).filter(Boolean);
        const sys = known.find((k) => step.includes(k));
        // Only a step the data on file actually covers (its words match a file's columns) counts as checked.
        const covering = tables.find((t) => t.headers.filter((h) => tokenize(h.replace(/_/g, " ")).some((w) => w.length >= 4 && new RegExp(`\\b${w}`, "i").test(step))).length >= 2);
        const short = truncate(step.split(/\s*[(:;]|\s+—\s+/)[0]!.replace(/[.,]+$/, ""), 90);
        const wantedFile = /\b[\w.-]+\.(?:csv|tsv|xlsx?|docx|pdf)\b/i.exec(step)?.[0];
        if (wantedFile && !covering) needs.push(`${wantedFile}: upload it to the knowledge base and the next run works on its rows.`);
        did.push(`${short}: ${covering ? `checked against ${covering.table.title} (${covering.table.rows.length} rows)` : wantedFile ? `waiting for ${wantedFile} (it isn't in your files yet)` : sys ? `ready — runs as soon as I have access to ${sys}` : "ready — runs on the next scheduled pass"}.`);
        sources.push({ step: short, status: covering ? "Checked against your data" : "Waiting on access", basis: covering?.table.title ?? sys ?? "—" });
      }
    }
    if (did.length) work.push("", "### What I checked this run", "", ...did.map((x) => `- ${x}`));
    if (wantsSummary || !outputs.length) {
      const top = relevant(pool, own || input.title, 5, used);
      if (top.length || !did.length) {
        work.push("", "### What I found", "", ...(top.length ? top.map((t) => `- ${truncate(t.text, 260)}`) : ["- I don't have anything on file about this yet. Send me the details or a document and I'll take it from there."]));
        sources.push({ step: "Summary", status: top.length ? "Grounded in your materials" : "Needs your data", basis: top[0]?.source ?? "—" });
      }
    }
    const dataNote = tables.length ? ` I used ${tables.map((t) => `${t.table.title} (${t.facts[0]})`).join(", ")}.` : "";
    lines.push(
      "## Summary",
      "",
      `${outputs.length ? `Inside: ${listJoin(outputs.map((x) => x.charAt(0).toLowerCase() + x.slice(1)).slice(0, 4))}.` : `${cap(input.title)}: ${did.length} checks set up.`}${timeLine ? ` This is built to take over ${/^about/.test(timeLine) ? timeLine : `the work you described on the call (“${truncate(timeLine, 160)}”)`}.` : ""}${dataNote}${decisions.length ? ` ${decisions.length} ${decisions.length === 1 ? "item needs" : "items need"} your decision below.` : ""}`,
    );
    if (prefs.length) lines.push("", `**Shaped by your preferences:** ${prefs.map((p) => truncate(p, 140)).join(" · ")}`);
    lines.push("", "## The work", ...work);
  }

  if (!decisions.length && rules.length) decisions.push(`Nothing goes out without approval, per your rule: “${truncate(rules[0]!, 160)}”.`);
  if (decisions.length) lines.push("", "## Needs your decision", "", ...[...new Set(decisions)].map((d) => `- ${d}`));
  if (needs.length) lines.push("", "## What I need from you", "", ...[...new Set(needs)].slice(0, 6).map((n) => `- ${n}`));
  const trace = ["| # | Step | Status | Based on |", "|---|---|---|---|", ...sources.map((s, i) => `| ${i + 1} | ${cell(s.step)} | ${cell(s.status)} | ${cell(s.basis)} |`)].join("\n");

  const preview = truncate(
    wantsEmail
      ? /^No email drafted/.test(lines[2] ?? "")
        ? `${input.title}: no email drafted yet — I need to know who it goes to.`
        : `${input.title}: ${sources.length && /data/.test(sources[0]!.status) ? "emails drafted from your data" : "email drafted"} and waiting for your approval.`
      : `${input.title} is ready${decisions.length ? ` — ${decisions.length} ${decisions.length === 1 ? "item needs" : "items need"} your decision` : ""}.`,
    200,
  );
  const body = noPlaceholders(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
  // Real content: something built from data, a drafted message or a priced document — not a format waiting for data.
  const placeholder = /\(example\)|Format ready|needs your data|Not drafted|Waiting on access|figures fill/i;
  const real = sources.filter((x) => !placeholder.test(x.status) && /data|Priced|Scope from|Grounded|Checked against|Drafted from your request/i.test(x.status));
  const substantive = real.length > 0 && !/\(example\)/.test(body) && !/^No email drafted/m.test(body);
  return { title: input.title, kind: wantsProposal ? "document" : input.output, body, preview, ...(sources.length ? { trace } : {}), data: { substantive } };
}

/** No literal `{customer first name}` / `{price}` in client-facing output: greetings become "Hello,", blanks "—". */
export function noPlaceholders(body: string): string {
  return body
    .replace(/\bHi \{[^{}\n]*\},/g, "Hello,")
    .replace(/\{(?:period|this period)\}/gi, "this period")
    .replace(/\{[^{}\n]{1,80}\}/g, "—");
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
      if (/lead time|turnaround/i.test(c)) return "{days}";
      if (/appointment|start|arriv/i.test(c) && /\btime\b/i.test(c)) return r === 0 ? "8:00 AM" : "9:30 AM";
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
  // What the message is about, from the step itself ("a reminder for each overdue invoice" → "overdue invoice").
  const topic = /\b(?:about|for|on|regarding)\s+(?:each |every |the |a |an |any |their |your )?([a-z][a-z' -]{3,50}?)(?:\s+(?:that|which|who|with|in|to|before|after|by|and)\b|[.,;:(—–]|$)/i.exec(step.replace(/\bone for\b.*$/i, ""))?.[1]?.trim() ?? null;
  // Never write about a topic a rule forbids ("Never quote a price for surgery or dental work").
  const banned = forbiddenTopics(rules);
  const about0 = topic && !/^(?:a|an|the|each|every)$/i.test(topic) ? topic.replace(/s$/, "") : null;
  const about = about0 && !banned.some((w) => new RegExp(`\\b${w}`, "i").test(about0)) && !/\b(?:rules?|price|quote)\b/i.test(about0) ? about0 : null;
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
          : about
            ? `This is ${who.agent} from ${who.org} about your ${about}. Could you let us know the next step that works for you? Reply here and we'll take care of the rest.`
            : `This is ${who.agent} from ${who.org}. Reply here with any questions, or with a time that suits you, and we'll take it from there.`
        : i === 1
          ? `Following up on my note${about ? ` about your ${about}` : ""}: if anything is holding it up, tell me what you need from us and I'll sort it out today.`
          : `A last note${about ? ` on your ${about}` : ""} from me. If now isn't the right time, reply whenever you're ready and we'll pick it up from there.`;
    out.push(`**${v} (${isText ? "text" : "email"})**`, "", `> ${greet}`, ">", `> ${msg}`, ">", `> ${isText ? `— ${who.org}` : `Best,\n> ${who.agent}\n> ${who.org}`}`, "");
  });
  if (rules.length) out.push(`_Checked against your rules: ${rules.slice(0, 2).map((r) => `“${truncate(r, 150)}”`).join(" ")}_`);
  void people;
  void recipient;
  return out;
}

/** A reminder for one row (when the row is about something due / overdue), to the person behind it. */
function rowReminder(t: Analysis, r: string[], req: string, who: Who, knowledge: Snip[], rules: string[], now: Date) {
  const ft: FileTable = { title: t.table.title, headers: t.table.headers, rows: t.table.rows, total: null };
  const plan = planRows(ft, "", rules, now);
  if (plan.cols.due < 0 && plan.cols.overdue < 0) return null;
  if (!/\b(?:remind|reminder|overdue|due|booster|renew\w*|book|follow up|follow-up)\b/i.test(req)) return null;
  const channel = /\btexts?\b|\bsms\b/i.test(req) ? "text" : "email";
  return rowDraft({ ...plan, rows: [r] }, r, { org: who.org, agent: who.agent, channel, link: linkFrom(knowledge), topic: null, forbidden: forbiddenTopics(rules), now });
}

// ───────────────────────────────────────────── named recipients & answers ─────────────────────────────────────────────

const EMAIL_IN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** People, companies and sites the request names, minus the agent and the business itself. */
function namedIn(req: string, who: Who): string[] {
  const own = `${who.agent} ${who.org}`.toLowerCase();
  return namedInTask(req).filter((n) => !own.includes(n.toLowerCase()) && !/^(?:csv|pdf|email|reply|summary|report)$/i.test(n));
}

const LABEL_COL = /^(?:property|site|location|account|client|customer|company|building|facility|business|practice|office)(?: name)?$/i;
const PERSON_COL = /^(?:contact|name|person|manager|property manager|owner|adjuster|homeowner|patient|tenant)(?: name)?$|contact name|manager name/i;

/** What a row is about ("Bayside Medical Plaza"), never "Our open item". */
function rowLabel(t: { headers: string[] }, r: string[]): string {
  const i = t.headers.findIndex((h) => LABEL_COL.test(h.trim()));
  if (i >= 0 && r[i]) return r[i]!;
  const firstText = r.find((c) => /[A-Za-z]{3}/.test(c) && !EMAIL_IN.test(c));
  return firstText ?? r[0] ?? "this item";
}

function r0Name(rs: string[][], nameC: number): boolean {
  return !!rs[0]?.[nameC] && /[A-Za-z]{2}/.test(rs[0][nameC]!) && !EMAIL_IN.test(rs[0][nameC]!);
}

type Target = { email: string; person: string | null; label: string | null; facts: string[]; source: string; row?: { t: Analysis; r: string[] } };

/** The one recipient a request names: an address in it, or a row/line in the knowledge base that names them. */
function findRecipient(named: string[], explicit: string | null, tables: Analysis[], knowledge: Snip[]): Target | null {
  const hits = tables
    .flatMap((t) => t.rows.map((r) => ({ t, r, score: named.filter((n) => mentions(r.join(" | "), [n])).length + named.filter((n) => n.includes(" ") && mentions(r.join(" | "), [n])).length })))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  const mailOf = (t: Analysis, r: string[]) => {
    const cols = t.headers.map((h, i) => i).filter((i) => /email/i.test(t.headers[i]!) && EMAIL_IN.test(r[i] ?? ""));
    if (!cols.length) return null;
    // With several email columns, take the one next to the column that names the person asked for.
    const nameAt = r.findIndex((c) => named.some((n) => n.includes(" ") && mentions(c, [n])));
    const best = nameAt >= 0 ? cols.sort((a, b) => Math.abs(a - nameAt) - Math.abs(b - nameAt))[0]! : cols[0]!;
    return EMAIL_IN.exec(r[best]!)![0];
  };
  const factsOf = (t: Analysis, r: string[], label: string | null, person: string | null) =>
    t.headers
      .map((h, i) => ({ h, v: r[i] ?? "" }))
      .filter(({ h, v }) => v && v !== "—" && !/email|phone/i.test(h) && !/premium|price|amount|cost|fee|rate|balance/i.test(h) && v !== label && v !== person)
      .slice(0, 5)
      .map(({ h, v }) => `${h}: ${v}`);
  if (explicit) {
    const h = hits.find((x) => x.r.some((c) => c.toLowerCase().includes(explicit.toLowerCase()))) ?? hits[0];
    const person = h ? personOf(h.t, h.r, named) : (named.find((n) => n.includes(" ")) ?? null);
    const label = h ? rowLabel(h.t, h.r) : null;
    return { email: explicit, person, label, facts: h ? factsOf(h.t, h.r, label, person) : [], source: "your request", ...(h ? { row: { t: h.t, r: h.r } } : {}) };
  }
  for (const h of hits) {
    const email = mailOf(h.t, h.r);
    if (!email) continue;
    const person = personOf(h.t, h.r, named);
    const label = rowLabel(h.t, h.r);
    // Facts about the same site from the other tables too (e.g. the inspection score).
    const extra = hits.filter((x) => x.t !== h.t && mentions(x.r.join(" | "), [label])).flatMap((x) => factsOf(x.t, x.r, label, person));
    return { email, person, label: label === person ? null : label, facts: [...new Set([...factsOf(h.t, h.r, label, person), ...extra])].slice(0, 6), source: h.t.table.title, row: { t: h.t, r: h.r } };
  }
  for (const k of knowledge) {
    for (const line of k.text.split(/\r?\n/)) {
      const m = EMAIL_IN.exec(line);
      if (m && named.some((n) => mentions(line, [n]))) return { email: m[0], person: named.find((n) => n.includes(" ") && mentions(line, [n])) ?? null, label: null, facts: [], source: k.title };
    }
  }
  return null;
}

function personOf(t: Analysis, r: string[], named: string[]): string | null {
  const cols = tableColumns({ title: t.table.title, headers: t.table.headers, rows: t.table.rows, total: null });
  const full = r.find((c, i) => named.some((n) => n.includes(" ") && mentions(c, [n])) && !EMAIL_IN.test(c) && i !== cols.subject);
  if (full) return full;
  if (cols.person >= 0 && r[cols.person] && !EMAIL_IN.test(r[cols.person]!)) return r[cols.person]!;
  const i = t.headers.findIndex((h, k) => PERSON_COL.test(h.trim()) && k !== cols.subject);
  return i >= 0 && r[i] && !EMAIL_IN.test(r[i]!) ? r[i]! : null;
}

const stem = (w: string) => w.replace(/(?:es|s)$/, "");

/** Answers from the data for what the request asks ("Bayside's score" → "Bayside Medical Plaza — Score: 81"). */
export function answerFromTables(question: string, tables: Analysis[], named: string[]): string[] {
  if (!named.length) return [];
  const q = new Set(tokenize(question).map(stem));
  const out: string[] = [];
  for (const t of tables) {
    const cols = t.headers.map((h, i) => ({ h, i })).filter(({ h }) => !/email|phone/i.test(h) && tokenize(h).some((w) => q.has(stem(w))) && !LABEL_COL.test(h.trim()) && !PERSON_COL.test(h.trim()));
    if (!cols.length) continue;
    for (const r of t.rows) {
      if (!named.some((n) => mentions(r.join(" | "), [n]))) continue;
      out.push(`${rowLabel(t, r)} — ${cols.map(({ h, i }) => `${h}: ${r[i] ?? "—"}`).join(", ")} (from ${t.table.title})`);
    }
  }
  return [...new Set(out)].slice(0, 5);
}

/** Offline chat answers: named rows in the data that hold what was asked. */
export function answerQuestion(question: string, knowledge: Snip[], now = new Date()): string[] {
  // "Which patients are more than 100 days overdue?" is answered from the rows (filtered, sorted, counted).
  const fromRows = answerFromRows(question, collectTables(knowledge), [], now);
  if (fromRows) return [fromRows.replace(/\.$/, "")];
  const tables = tablesIn(knowledge).map((t) => analyze(t, now));
  return answerFromTables(question, tables, namedInTask(question));
}

// ───────────────────────────────────────────── proposals ─────────────────────────────────────────────

function isRateTable(t: Analysis): boolean {
  return /rate|pric|fee|cost|menu|tariff/i.test(t.table.title) || t.headers.some((h) => /rate|price|fee|cost|per (?:sq|hour|visit)/i.test(h));
}

/** A proposal document: who it's for, scope, pricing (from a rate guide when one is on file), terms, next steps. */
function proposalDoc(input: ComposeInput, who: Who, tables: Analysis[], pool: Sent[], steps: string[], own: string): string[] {
  const named = namedIn(own, who);
  const client = named.find((n) => n.includes(" ")) ?? named[0] ?? null;
  const rate = tables.find(isRateTable) ?? null;
  const rateLines = rate
    ? []
    : pool.filter((p) => /\$\s?\d/.test(p.text) && /rate|price|per |sq\.? ?f|hour|visit|month|minimum/i.test(p.text)).slice(0, 8);
  const scope = steps
    .filter((st) => !/\b(?:request approval|deliver|lead with|list exactly)\b/i.test(st))
    .map((st) => truncate(st.replace(/^(?:\d+\.\s*)/, "").replace(/\.$/, ""), 200))
    .slice(0, 6);
  const termLines = pool.filter((p) => /\bnet \d+|deposit|valid for|payment terms|cancel|minimum|invoice/i.test(p.text)).slice(0, 4);
  const out = [
    "## Summary",
    "",
    `A proposal${client ? ` for ${client}` : ""} from ${who.org}: scope, pricing and terms, ready for your review.${rate ? ` Pricing comes from ${rate.table.title}.` : rateLines.length ? " Pricing comes from the rates in your files." : ""}`,
    "",
    "## Proposal",
    "",
    `**Prepared for:** ${client ?? "the client named in the request"}  `,
    `**Prepared by:** ${who.agent}, ${who.org}`,
    "",
    "### Scope of work",
    "",
    ...(scope.length ? scope.map((x) => `- ${cap(x)}`) : ["- The services discussed, as described in your materials."]),
    "",
    "### Pricing",
    "",
  ];
  if (rate) out.push(...gfm(rate.headers, rate.rows.slice(0, 15)), "", `_From ${rate.table.title}; final figures depend on the site walk-through._`);
  else if (rateLines.length) out.push(...rateLines.map((l) => `- ${truncate(l.text, 220)}`));
  else out.push("Pricing isn't on file yet. Add your rate guide to the knowledge base and I'll price every line.");
  out.push("", "### Terms", "");
  out.push(...(termLines.length ? termLines.map((l) => `- ${truncate(l.text, 220)}`) : ["- Prices valid for 30 days from the date of this proposal.", "- Invoiced monthly; payment due within 30 days.", "- Either party may end the agreement with 30 days' written notice."]));
  out.push("", "### Next steps", "", "- Confirm the scope and schedule.", "- Sign and return; we start on the agreed date.");
  void input;
  return out;
}
