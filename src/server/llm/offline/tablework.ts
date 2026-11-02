/**
 * Offline table work: the rows of a CSV / TSV the client uploaded, filtered, sorted and acted on the way the task
 * asks ("every patient more than 90 days overdue for rabies or DHPP, most overdue first, a reminder text per owner").
 *
 * - `collectTables` reassembles a file's table from the retrieved chunks (the extractor writes blocks that each
 *   repeat the header with a "name, rows a–b of N" caption; the chunker can cut a block mid-row).
 * - `planRows` reads simple criteria from the instructions against the headers: value filters ("rabies or DHPP"),
 *   thresholds ("> 90 days", "over $500"), "overdue / past due / unpaid", date windows ("this week"), top N, sort
 *   by a named column, exclusions ("skip Biscuit"), never-contact rules and sign-off holds.
 * - `rowDraft` writes one reminder per row to the right person (owner / client / contact, never the pet).
 * Deterministic, no model. Never claims a row count it did not read.
 */
import { cell, normalizeWhitespace, splitSentences as baseSplit, tokenize, truncate } from "../text";

export type Snip = { title: string; text: string; kind?: string };
export type FileTable = { title: string; headers: string[]; rows: string[][]; total: number | null };

// ───────────────────────────────────────────── sentences ─────────────────────────────────────────────

const DOT = "․";
/** Abbreviation-aware sentence split ("Elm St. Rescue", "Dr. Okafor", "7 a.m. shift" stay whole). */
export function splitSentences(text: string): string[] {
  const guarded = text
    .replace(/\b(St|Dr|Mr|Mrs|Ms|Mt|Jr|Sr|Prof|Rev|Capt|Sgt|Lt|Ft|Hon|Gov|Gen|Messrs)\.(?=\s+[A-Z0-9])/g, `$1${DOT}`)
    .replace(/\b(Inc|Co|Corp|Ltd|LLC|Bros|Ave|Blvd|Rd|Ste|Bldg|Dept|Mfg|etc|vs|approx|est|incl|ext)\.(?=\s*[a-z0-9,;:)]|\s+&)/g, `$1${DOT}`)
    .replace(/\bNo\.(?=\s?\d)/g, `No${DOT}`)
    .replace(/\b((?:[A-Za-z]\.){1,3}[A-Za-z])\.(?=\s*[a-z0-9,;:)])/g, (_m, a: string) => `${a.replace(/\./g, DOT)}${DOT}`)
    .replace(/\b((?:[A-Za-z]\.){1,3}[A-Za-z])\.(?=\s|$)/g, (_m, a: string) => `${a.replace(/\./g, DOT)}.`)
    .replace(/(^|\s)([A-Z])\.(?=\s+[A-Z][a-z])/g, `$1$2${DOT}`);
  return baseSplit(guarded).map((x) => x.replace(/․/g, "."));
}

// ───────────────────────────────────────────── tables from chunks ─────────────────────────────────────────────

const CAPTION = /^(.+?), rows? (\d+)(?:[–-](\d+))? of (\d+)\s*$/;
const parseMd = (l: string) => l.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
const isSep = (l: string) => /^\|?[\s:|-]+\|?$/.test(l) && l.includes("-");

function splitDelimited(line: string, sep: string): string[] {
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

/**
 * Every table in the retrieved chunks, one per file: blocks of the same file and header are merged, rows deduped,
 * and `total` is the row count the file says it has (from the caption) so callers never report a partial count as whole.
 */
export function collectTables(snips: Snip[]): FileTable[] {
  const byKey = new Map<string, FileTable & { seen: Set<string> }>();
  const add = (title: string, headers: string[], rows: string[][], total: number | null) => {
    const key = `${title.toLowerCase()}|${headers.map((h) => h.toLowerCase()).join("|")}`;
    let t = byKey.get(key);
    if (!t) {
      t = { title, headers, rows: [], total, seen: new Set() };
      byKey.set(key, t);
    }
    if (total != null) t.total = Math.max(t.total ?? 0, total);
    for (const r of rows) {
      const k = r.join("\u0001").toLowerCase();
      if (r.length !== headers.length || t.seen.has(k) || r.every((c) => !c)) continue;
      t.seen.add(k);
      t.rows.push(r);
    }
  };
  for (const s of snips) {
    const lines = s.text.split(/\r?\n/).map((l) => l.trim());
    let found = false;
    // Markdown blocks: [caption] header, separator, rows. Rows before a header (chunk overlap) are skipped.
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!/^\|.*\|$/.test(lines[i]!) || !isSep(lines[i + 1]!)) continue;
      const headers = parseMd(lines[i]!);
      const cap = CAPTION.exec(lines[i - 1] ?? "");
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && /^\|.*\|$/.test(lines[j]!); j++) rows.push(parseMd(lines[j]!));
      add(cap ? cap[1]!.trim() : s.title, headers, rows, cap ? Number(cap[4]) : null);
      found = true;
      i = j - 1;
    }
    if (found) continue;
    // Raw CSV / TSV / semicolon text.
    const nonEmpty = lines.filter(Boolean);
    for (const sep of [",", "\t", ";"]) {
      const cand = nonEmpty.filter((l) => l.includes(sep));
      if (cand.length < 3) continue;
      const cells = cand.map((l) => splitDelimited(l, sep));
      const width = cells[0]!.length;
      if (width < 2 || cells.filter((c) => c.length === width).length < Math.max(3, cand.length * 0.8)) continue;
      const header = cells[0]!;
      if (header.filter((h) => /^[A-Za-z#][\w #/().%-]*$/.test(h)).length < width * 0.7) continue;
      add(s.title, header, cells.slice(1), null);
      break;
    }
  }
  return [...byKey.values()].map(({ seen: _seen, ...t }) => t);
}

/** Query that pulls every chunk of a table back (each block repeats its header). */
export function tableQuery(t: FileTable): string {
  return [...new Set(t.headers.flatMap((h) => tokenize(h.replace(/_/g, " "))))].slice(0, 12).join(" ");
}

export const isComplete = (t: FileTable) => t.total == null || t.rows.length >= t.total;

// ───────────────────────────────────────────── columns ─────────────────────────────────────────────

const norm = (h: string) => h.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+Z?)?$|^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
export function parseDate(v: string): Date | null {
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  if (m[1]) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const y = Number(m[6]!.length === 2 ? `20${m[6]}` : m[6]);
  return new Date(Date.UTC(y, Number(m[4]) - 1, Number(m[5])));
}
export const numVal = (v: string): number | null => {
  const t = v.trim().replace(/^\(\$?([\d,.]+)\)$/, "-$1");
  return /^-?\$?\s?-?[\d,]+(?:\.\d+)?%?$/.test(t) && /\d/.test(t) ? Number(t.replace(/[$,%\s]/g, "")) : null;
};
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /^\+?[\d\s().-]{7,}$/;

export type Cols = {
  subject: number;
  person: number;
  email: number;
  phone: number;
  due: number;
  overdue: number;
  numeric: number[];
  dates: number[];
  categorical: number[];
};

const PERSON_ORDER = [/^owner(?: name)?$/, /^(?:client|customer)(?: name)?$/, /^(?:contact|contact name|primary contact)$/, /^(?:guardian|parent|tenant|homeowner|policyholder|insured|member|resident)(?: name)?$/, /^(?:full name|first name)$/, /^name$/];
const SUBJECT = /^(?:patient|pet|animal|pet name|patient name|dog|cat|horse|item|product|property|site|unit|job|project|account|vehicle)$/;

export function columnsOf(t: FileTable): Cols {
  const H = t.headers.map(norm);
  const all = (i: number, f: (v: string) => boolean) => t.rows.length > 0 && t.rows.every((r) => !(r[i] ?? "").trim() || f(r[i]!));
  const email = (() => {
    const cs = H.map((h, i) => (/e-?mail/.test(h) ? i : -1)).filter((i) => i >= 0);
    return cs.find((i) => /owner|client|customer|contact|parent|guardian/.test(H[i]!)) ?? cs[0] ?? -1;
  })();
  const phone = H.findIndex((h) => /phone|mobile|cell|sms/.test(h));
  let person = -1;
  for (const re of PERSON_ORDER) {
    person = H.findIndex((h, i) => re.test(h) && i !== email && all(i, (v) => /[A-Za-z]/.test(v) && !EMAIL.test(v)));
    if (person >= 0) break;
  }
  let subject = H.findIndex((h, i) => SUBJECT.test(h) && i !== person);
  if (subject < 0) subject = H.findIndex((_, i) => i !== person && i !== email && i !== phone && all(i, (v) => /[A-Za-z]{2}/.test(v) && !EMAIL.test(v)));
  const numeric = H.map((_, i) => i).filter((i) => i !== phone && all(i, (v) => numVal(v) != null));
  const dates = H.map((_, i) => i).filter((i) => all(i, (v) => parseDate(v) != null));
  const due = dates.find((i) => /due|expir|renew|deadline|next/.test(H[i]!)) ?? -1;
  const overdue = numeric.find((i) => /overdue|late|past due|outstanding|aging|days? (?:out|open)/.test(H[i]!)) ?? -1;
  const categorical = H.map((_, i) => i).filter((i) => {
    if ([person, email, phone, subject].includes(i) || numeric.includes(i) || dates.includes(i)) return false;
    const vals = new Set(t.rows.map((r) => (r[i] ?? "").trim().toLowerCase()).filter(Boolean));
    return vals.size > 0 && vals.size <= Math.max(6, Math.ceil(t.rows.length * 0.6)) && [...vals].every((v) => v.length <= 40 && !EMAIL.test(v) && !PHONE.test(v));
  });
  return { subject, person, email, phone, due, overdue, numeric, dates, categorical };
}

/** Column whose header words best match a phrase ("days overdue" → days_overdue). */
function columnFor(t: FileTable, phrase: string, among?: number[]): number {
  const want = new Set(tokenize(phrase.replace(/_/g, " ")).map((w) => w.replace(/s$/, "")));
  let best = -1;
  let score = 0;
  t.headers.forEach((h, i) => {
    if (among && !among.includes(i)) return;
    const hw = tokenize(h.replace(/_/g, " ")).map((w) => w.replace(/s$/, ""));
    const s = hw.filter((w) => want.has(w)).length / Math.max(1, hw.length) + hw.filter((w) => want.has(w)).length;
    if (s > score) {
      score = s;
      best = i;
    }
  });
  return best;
}

// ───────────────────────────────────────────── rules & names ─────────────────────────────────────────────

const NOT_NAMES = new Set(
  "skip leave exclude except remove drop the a an and or of for to never contact do don't not any anything everything all every entirely completely out about family account rule rules sign-off signoff approval hard call from also only please list draft each owner owners".split(" "),
);

/** Capitalised names in a clause ("Biscuit and the Whitfield family" → Biscuit, Whitfield; "Elm St. Rescue" whole). */
export function namesIn(clause: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Z][\w'’-]*(?:\s+(?:St\.|Dr\.|[A-Z][\w'’-]*|&|of))*)/g;
  for (const m of clause.matchAll(re)) {
    const words = m[1]!.replace(/['’]s$/, "").split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
    const name = words.join(" ").replace(/\s+(?:&|of)$/, "").trim();
    if (name.length >= 3 && !NOT_NAMES.has(name.toLowerCase()) && !/^(?:I|We|You|They|He|She|It|This|That|Hi|Kayla's)$/.test(name)) out.push(name);
  }
  return [...new Set(out)];
}

const has = (hay: string, name: string) => new RegExp(`(?:^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}])`, "iu").test(hay);

export type Exclusion = { names: string[]; why: string };
export type Hold = { names: string[]; who: string | null; why: string };

/** "Skip Biscuit…", "Leave Biscuit out", "never contact the Whitfield family about Biscuit" → names to leave out. */
export function exclusionsFrom(text: string, rules: string[]): Exclusion[] {
  const out: Exclusion[] = [];
  for (const s of splitSentences(text)) {
    const m = /\b(?:skip|exclude|leave out|leave|except|omit|remove|drop|without|never (?:contact|text|email|call|message)|do not (?:contact|text|email|call)|don'?t (?:contact|text|email|call))\b\s+(.{2,120})/i.exec(s);
    if (!m) continue;
    const names = namesIn(m[1]!.replace(/\b(?:out|entirely|completely)\b.*$/i, "").replace(/\babout\b/i, " ") + (/\babout\b/i.test(m[1]!) ? ` ${m[1]!.split(/\babout\b/i)[1]}` : ""));
    if (names.length) out.push({ names, why: "you asked to leave them out" });
  }
  for (const r of rules) {
    if (!/\bnever (?:contact|text|email|call|message|reach out to)\b|\bdo not (?:contact|text|email|call)\b|\bdon'?t (?:contact|text|email|call)\b/i.test(r)) continue;
    const names = namesIn(r.replace(/^.*?\b(?:contact|text|email|call|message|reach out to)\b/i, ""));
    if (names.length) out.push({ names, why: `your rule: “${truncate(r.replace(/^[“"]|[”"]$/g, ""), 120)}”` });
  }
  return out;
}

/** "Anything for Elm St. Rescue waits for Kayla's sign-off" / "anything going to the X account needs Y's sign-off first". */
export function holdsFrom(text: string, rules: string[]): Hold[] {
  const out: Hold[] = [];
  for (const s of [...splitSentences(text), ...rules]) {
    const m = /\b(?:anything|everything|all|any (?:text|email|message)s?)\s+(?:for|going to|to|sent to|about)\s+(?:the\s+)?(.+?)\s+(?:account\s+)?(?:needs?|waits?|must|requires?|has to|should)\b(.*)$/i.exec(s);
    if (!m || !/sign-?off|approv|okay|\bok\b|review/i.test(m[2]!)) continue;
    const names = namesIn(m[1]!);
    const who = /\b([A-Z][a-z]+)['’]s (?:sign-?off|approval|ok|okay)/.exec(m[2]!)?.[1] ?? /\b(?:from|by) ([A-Z][a-z]+)\b/.exec(m[2]!)?.[1] ?? null;
    if (names.length) out.push({ names, who, why: `${who ? `waits for ${who}'s sign-off` : "needs sign-off first"}` });
  }
  return out;
}

/** Topic words a never-rule forbids drafting about ("Never quote a price for surgery or dental work" → surgery, dental). */
export function forbiddenTopics(rules: string[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const m = /\bnever (?:quote|discuss|mention|talk about|give|share|promise|send)\b[^.]*?\b(?:for|about|on|of)\s+(.+?)[.”"]*$/i.exec(r);
    if (m) out.push(...m[1]!.split(/\s*(?:,|\bor\b|\band\b)\s*/).map((w) => w.trim().split(/\s+/)[0]!.toLowerCase()).filter((w) => w.length >= 4));
  }
  return [...new Set(out)];
}

// ───────────────────────────────────────────── criteria ─────────────────────────────────────────────

export type Plan = {
  table: FileTable;
  cols: Cols;
  /** Rows after filters, exclusions and sort (holds stay in, flagged). */
  rows: string[][];
  /** Human-readable criteria actually applied ("vaccine is Rabies or DHPP", "days overdue > 90"). */
  applied: string[];
  /** Criteria the text asked for that no column could answer, with the column needed. */
  unmapped: string[];
  excluded: Array<{ row: string[]; why: string }>;
  held: Array<{ row: string[]; why: string; who: string | null }>;
  sortedBy: string | null;
  limit: number | null;
  /** Derived "days overdue" when the file has a due date but no such column. */
  derived: { header: string; values: Map<string[], number> } | null;
};

const DAY = 86_400_000;
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, fifty: 50 };

/** Does a request read as work over a table (list/filter/sort/count/draft per row)? */
export function asksForRows(text: string): boolean {
  return /\b(?:list|which|who|how many|every|each|all|sorted|sort|rank|top \d+|overdue|past due|unpaid|outstanding|more than|over \d|at least|filter|show me|table)\b/i.test(text);
}

/** Read the criteria in `text` against one table. `rules` are the client's hard / approval rules. */
export function planRows(table: FileTable, text: string, rules: string[], now: Date): Plan {
  const cols = columnsOf(table);
  const lower = ` ${text.toLowerCase()} `;
  let rows = table.rows.map((r) => r);
  const applied: string[] = [];
  const unmapped: string[] = [];
  let derived: Plan["derived"] = null;
  const H = table.headers;
  const label = (i: number) => norm(H[i]!);

  // Days overdue: a column, or derived from a due date.
  const overdueOf = (() => {
    if (cols.overdue >= 0) return (r: string[]) => numVal(r[cols.overdue] ?? "");
    if (cols.due >= 0) {
      const values = new Map<string[], number>();
      for (const r of table.rows) {
        const d = parseDate(r[cols.due] ?? "");
        if (d) values.set(r, Math.floor((now.getTime() - d.getTime()) / DAY));
      }
      derived = { header: "Days overdue", values };
      return (r: string[]) => values.get(r) ?? null;
    }
    return null;
  })();

  // 1. Value filters on categorical columns ("overdue for rabies or DHPP").
  const excludeClauses = splitSentences(text).filter((s) => /\b(?:skip|exclude|leave|except|omit|remove|drop|without|never|not)\b/i.test(s)).join(" ").toLowerCase();
  for (const c of cols.categorical) {
    const vals = [...new Set(table.rows.map((r) => (r[c] ?? "").trim()).filter(Boolean))];
    const hit = vals.filter((v) => {
      const re = new RegExp(`(?:^|[^a-z0-9])${v.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?(?:[^a-z0-9]|$)`);
      return re.test(lower) && !re.test(` ${excludeClauses} `);
    });
    if (!hit.length || hit.length === vals.length) continue;
    rows = rows.filter((r) => hit.some((v) => v.toLowerCase() === (r[c] ?? "").trim().toLowerCase()));
    applied.push(`${label(c)} is ${hit.length === 1 ? hit[0] : `${hit.slice(0, -1).join(", ")} or ${hit[hit.length - 1]}`}`);
  }

  // 2. Thresholds ("more than 90 days overdue", "> 100 days", "90+ days", "over $500", "at least 3 visits").
  const TH = /(more than|greater than|over|above|at least|no less than|>=|>|≥|under|less than|fewer than|below|at most|<=|<|≤)\s*\$?\s*(\d[\d,]*(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty)\s*(%|\+)?\s*([a-z_ ]{0,40})|(\d[\d,]*)\s*\+\s*([a-z_ ]{0,40})/g;
  for (const m of lower.matchAll(TH)) {
    const op = m[1] ?? ">=";
    const n = Number((m[2] ?? m[5] ?? "0").replace(/,/g, "")) || WORDNUM[m[2] ?? ""] || 0;
    const unit = (m[4] ?? m[6] ?? "").trim();
    if (!n && n !== 0) continue;
    const money = /\$/.test(m[0]);
    const cmp = (v: number) => (/more|greater|over|above|^>$/.test(op) ? v > n : /at least|no less|>=|≥|\+/.test(op) ? v >= n : /under|less|fewer|below|^<$/.test(op) ? v < n : v <= n);
    const sym = /more|greater|over|above|^>$/.test(op) ? ">" : /at least|no less|>=|≥/.test(op) ? "≥" : /under|less|fewer|below|^<$/.test(op) ? "<" : "≤";
    let col = -1;
    if (unit) col = columnFor(table, unit, cols.numeric);
    if (col < 0 && money) col = cols.numeric.find((i) => /amount|balance|total|owed|due|price|value|\$/.test(label(i))) ?? -1;
    if (col >= 0 && !(unit && /\bdays?\b/.test(unit) && !/day/.test(label(col)) && overdueOf)) {
      rows = rows.filter((r) => {
        const v = numVal(r[col] ?? "");
        return v != null && cmp(v);
      });
      applied.push(`${label(col)} ${sym} ${money ? "$" : ""}${n}`);
    } else if (/\bdays?\b/.test(unit) && overdueOf) {
      rows = rows.filter((r) => {
        const v = overdueOf(r);
        return v != null && cmp(v);
      });
      applied.push(`days overdue ${sym} ${n}`);
    } else if (unit && !/^(?:of|in|the|and|or)$/.test(unit)) {
      unmapped.push(`“${normalizeWhitespace(m[0])}” — I need a numeric column for ${unit.split(/\s+/).slice(0, 2).join(" ") || "it"}`);
    }
  }

  // 3. Overdue / past due / unpaid / outstanding (without a number).
  if (/\b(?:overdue|past due|late|unpaid|outstanding|delinquent)\b/.test(lower) && !applied.some((a) => /overdue|late|outstanding/.test(a))) {
    const statusCol = H.findIndex((h, i) => /status|stage|state|paid/.test(norm(h)) && cols.categorical.includes(i));
    const statusHit = statusCol >= 0 ? [...new Set(table.rows.map((r) => (r[statusCol] ?? "").trim()))].filter((v) => /overdue|past due|late|unpaid|outstanding|open|due|delinquent/i.test(v) && !/^paid$/i.test(v)) : [];
    if (overdueOf) {
      const before = rows.length;
      rows = rows.filter((r) => (overdueOf(r) ?? 0) > 0);
      if (rows.length !== before || cols.overdue >= 0 || cols.due >= 0) applied.push(cols.overdue >= 0 ? `${label(cols.overdue)} > 0` : `${label(cols.due)} before today`);
    } else if (statusHit.length) {
      rows = rows.filter((r) => statusHit.includes((r[statusCol] ?? "").trim()));
      applied.push(`${label(statusCol)} is ${statusHit.join(" or ")}`);
    } else unmapped.push("overdue / unpaid — I need a due-date, days-overdue or status column");
  }

  // 4. Date windows on the most relevant date column.
  const win = /\b(today|tomorrow|this week|next week|this month|next month|last month|(?:next|last|past|within(?: the next)?) (\d+) days)\b/.exec(lower);
  if (win) {
    const dc = cols.due >= 0 ? cols.due : (cols.dates.find((i) => /appoint|visit|date|start|sched/.test(label(i))) ?? cols.dates[0] ?? -1);
    if (dc >= 0) {
      const d0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dow = (d0.getUTCDay() + 6) % 7;
      const w = win[1]!;
      const N = Number(win[2] ?? 0);
      const [from, to] =
        w === "today" ? [d0, new Date(d0.getTime() + DAY)]
        : w === "tomorrow" ? [new Date(d0.getTime() + DAY), new Date(d0.getTime() + 2 * DAY)]
        : w === "this week" ? [new Date(d0.getTime() - dow * DAY), new Date(d0.getTime() + (7 - dow) * DAY)]
        : w === "next week" ? [new Date(d0.getTime() + (7 - dow) * DAY), new Date(d0.getTime() + (14 - dow) * DAY)]
        : w === "this month" ? [new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)), new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1))]
        : w === "next month" ? [new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)), new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 2, 1))]
        : w === "last month" ? [new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 1, 1)), new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1))]
        : /^(?:last|past)/.test(w) ? [new Date(d0.getTime() - N * DAY), new Date(d0.getTime() + DAY)]
        : [d0, new Date(d0.getTime() + (N + 1) * DAY)];
      rows = rows.filter((r) => {
        const d = parseDate(r[dc] ?? "");
        return !!d && d >= from && d < to;
      });
      applied.push(`${label(dc)} ${w}`);
    } else unmapped.push(`“${win[1]}” — I need a date column`);
  }

  // 5. Exclusions and never-contact rules.
  const excluded: Plan["excluded"] = [];
  for (const ex of exclusionsFrom(text, rules)) {
    rows = rows.filter((r) => {
      const line = r.join(" | ");
      if (!ex.names.some((n) => has(line, n))) return true;
      if (!excluded.some((e) => e.row === r)) excluded.push({ row: r, why: ex.why });
      return false;
    });
  }

  // 6. Sort.
  let sortedBy: string | null = null;
  const sortM =
    /\b(?:sorted|sort|ordered|order|ranked|rank)\s+(?:them\s+|it\s+)?by\s+(?:how\s+)?(?:the\s+)?([a-z_ ]{2,40}?)(?:\s*\((?:([a-z ]+?))\)|\s+(?:with|and|then|for|from|so|,)|[.,;]|\s*$|\s+(most|least|highest|lowest|largest|smallest|oldest|newest|earliest|latest)\b)/.exec(lower) ?? null;
  const firstM = /\b(most|least|highest|lowest|largest|smallest|biggest|oldest|newest|earliest|latest|soonest)\s+([a-z_ ]{0,30}?)\s*first\b/.exec(lower);
  const dirWord = (firstM?.[1] ?? sortM?.[2] ?? sortM?.[3] ?? "").trim();
  const sortPhrase = (sortM?.[1] ?? firstM?.[2] ?? "").trim();
  if (sortPhrase || firstM) {
    const overdueish = /overdue|late|past due|how overdue/.test(`${sortPhrase} ${firstM?.[0] ?? ""}`);
    let sc = sortPhrase ? columnFor(table, sortPhrase) : -1;
    if (overdueish && cols.overdue >= 0) sc = cols.overdue;
    const asc = /least|lowest|smallest|soonest|earliest/.test(dirWord) || (/oldest/.test(dirWord) && sc >= 0 && cols.dates.includes(sc));
    const keyOf = (r: string[]): number | string | null => {
      if (sc < 0 && overdueish && overdueOf) return overdueOf(r);
      if (sc < 0) return null;
      const v = r[sc] ?? "";
      const d = parseDate(v);
      if (d) return d.getTime();
      return numVal(v) ?? v.toLowerCase();
    };
    if (sc >= 0 || (overdueish && overdueOf)) {
      const desc = !asc && (sc < 0 || cols.numeric.includes(sc) || /most|highest|largest|biggest|newest|latest/.test(dirWord) || overdueish) && !(cols.dates.includes(sc) && overdueish);
      const dateAscForOverdue = sc >= 0 && cols.dates.includes(sc) && overdueish;
      rows = [...rows].sort((a, b) => {
        const ka = keyOf(a);
        const kb = keyOf(b);
        if (ka == null || kb == null) return ka == null ? 1 : -1;
        const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
        return dateAscForOverdue ? c : desc ? -c : c;
      });
      sortedBy = `${sc >= 0 ? label(sc) : "days overdue"}${dateAscForOverdue || desc ? (cols.dates.includes(sc) ? ", oldest first" : ", highest first") : ", lowest first"}`;
      if (overdueish) sortedBy = "most overdue first";
    } else unmapped.push(`sort by “${sortPhrase}” — no column called that (columns: ${H.join(", ")})`);
  } else if (applied.some((a) => /overdue/.test(a)) && overdueOf) {
    rows = [...rows].sort((a, b) => (overdueOf(b) ?? -1e9) - (overdueOf(a) ?? -1e9));
    sortedBy = "most overdue first";
  }

  // 7. Top N.
  const topM = /\btop (\d+|ten|five|three)\b|\b(?:the )?(\d+|ten|five|three) (?:most|highest|largest|biggest|oldest)\b/.exec(lower);
  const limit = topM ? Number(topM[1] ?? topM[2]) || WORDNUM[topM[1] ?? topM[2] ?? ""] || null : null;
  if (limit) rows = rows.slice(0, limit);

  // 8. Holds (sign-off before anything goes out): rows stay, flagged.
  const held: Plan["held"] = [];
  for (const h of holdsFrom(text, rules)) for (const r of rows) if (h.names.some((n) => has(r.join(" | "), n)) && !held.some((x) => x.row === r)) held.push({ row: r, why: h.why, who: h.who });

  return { table, cols, rows, applied, unmapped, excluded, held, sortedBy, limit, derived };
}

// ───────────────────────────────────────────── rendering ─────────────────────────────────────────────

export function gfm(headers: string[], rows: string[][]): string[] {
  return [`| ${headers.map(cell).join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${headers.map((_, i) => cell(r[i] ?? "") || "—").join(" | ")} |`)];
}

/** The rows as a table: the useful columns first, contact details last; a derived "Days overdue" when computed. */
export function planTable(p: Plan): string[] {
  const { subject, person, email, phone } = p.cols;
  const front = [subject, person].filter((i) => i >= 0);
  const back = [phone, email].filter((i) => i >= 0 && !front.includes(i));
  const keep = [...front, ...p.table.headers.map((_, i) => i).filter((i) => !front.includes(i) && !back.includes(i)), ...back];
  const headers = keep.map((i) => p.table.headers[i]!);
  const rows = p.rows.map((r) => keep.map((i) => r[i] ?? ""));
  const derived = p.derived;
  if (derived && p.cols.overdue < 0) {
    headers.push(derived.header);
    p.rows.forEach((r, k) => rows[k]!.push(String(derived.values.get(r) ?? "—")));
  }
  if (p.held.length) {
    headers.push("Note");
    p.rows.forEach((r, k) => rows[k]!.push(p.held.find((h) => h.row === r)?.why ?? ""));
  }
  return gfm(["#", ...headers], rows.map((r, k) => [String(k + 1), ...r]));
}

const ORGISH = /\b(?:rescue|shelter|inc|llc|ltd|co|corp|company|clinic|group|foundation|society|services|association|partners|hospital|school|church|team)\b\.?/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;

export type RowDraft = { label: string; to: string; channel: "text" | "email"; subject: string | null; body: string; held: string | null };

/** A booking / payment / scheduling link from the knowledge base, if one is written down. */
export function linkFrom(snips: Snip[], kind: "book" | "pay" = "book"): string | null {
  const want = kind === "book" ? /book|schedul|appoint/i : /pay|invoice|billing/i;
  for (const s of snips) {
    for (const line of s.text.split(/\n/)) {
      if (!want.test(line)) continue;
      const m = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[\w\-./?=&%#]*)?)/i.exec(line.replace(EMAIL, " "));
      if (m && /\/|https?:/.test(m[1]!)) return m[1]!.replace(/[.,;)]+$/, "");
    }
  }
  return null;
}

/** One reminder to the person behind a row (owner/client/contact; never the pet or the item). */
export function rowDraft(p: Plan, r: string[], o: { org: string; agent: string; channel: "text" | "email"; link: string | null; topic: string | null; forbidden: string[]; now?: Date }): RowDraft {
  const { cols } = p;
  const H = p.table.headers;
  const personRaw = cols.person >= 0 ? (r[cols.person] ?? "").trim() : "";
  const subject = cols.subject >= 0 ? (r[cols.subject] ?? "").trim() : "";
  const isOrg = ORGISH.test(personRaw);
  const first = personRaw && !isOrg ? (personRaw.startsWith("Dr.") ? personRaw : personRaw.split(/\s+/)[0]!) : null;
  const greet = first ? `Hi ${first},` : personRaw ? `Hi ${personRaw} team,` : "Hello,";
  // What it is about: the filtered category ("Rabies"), a service/item/vaccine column, or the topic of the task.
  const itemCol = cols.categorical.find((i) => /vaccine|service|item|product|plan|treatment|invoice|type|policy|reason/.test(norm(H[i]!))) ?? -1;
  const item = itemCol >= 0 ? (r[itemCol] ?? "").trim() : (o.topic ?? "");
  const due = cols.due >= 0 ? parseDate(r[cols.due] ?? "") : null;
  const od = cols.overdue >= 0 ? numVal(r[cols.overdue] ?? "") : (p.derived?.values.get(r) ?? (due ? Math.floor(((o.now ?? new Date()).getTime() - due.getTime()) / DAY) : null));
  const itemHead = itemCol >= 0 ? norm(H[itemCol]!) : "";
  const itemPhrase0 = item ? (/^[A-Z]{2,}/.test(item) ? item : item.toLowerCase()) : "";
  const itemPhrase = itemPhrase0 && /^(?:vaccine|vaccination|service|treatment|plan|policy|invoice)$/.test(itemHead) && !itemPhrase0.toLowerCase().includes(itemHead) ? `${itemPhrase0} ${itemHead}` : itemPhrase0;
  const poss = (n: string) => (/s$/i.test(n) ? `${n}'` : `${n}'s`);
  const what = subject && subject !== personRaw ? `${poss(subject)} ${itemPhrase || "next visit"}` : itemPhrase ? `your ${itemPhrase}` : "your next visit";
  const status = od != null && od > 0 ? ` is overdue${due ? ` (it was due ${fmtDate(due)})` : ` by ${od} days`}` : due ? ` is due ${fmtDate(due)}` : " is coming up";
  const act = o.link ? `You can book a time at ${o.link}, or reply and we'll find one that works.` : "Reply with a day and time that works and we'll get it booked.";
  let lines = [`${greet} this is ${o.org}. ${cap(what)}${status}. ${act}`];
  if (o.channel === "email") lines = [greet, "", `${cap(what)}${status}. ${act}`, "", "Thank you,", o.agent, o.org];
  // Never write about a topic a rule forbids.
  const clean = (s: string) => o.forbidden.reduce((x, w) => x.replace(new RegExp(`[^.]*\\b${w}[^.]*\\.\\s*`, "gi"), ""), s);
  const body = lines.map(clean).join(o.channel === "email" ? "\n" : " ");
  const phone = cols.phone >= 0 ? (r[cols.phone] ?? "").trim() : "";
  const mail = cols.email >= 0 ? (r[cols.email] ?? "").trim() : "";
  const who = personRaw || subject || "the contact";
  const to = o.channel === "text" ? `${who}${phone ? ` · ${phone}` : ""}` : mail ? `${who} <${mail}>` : who;
  const held = p.held.find((h) => h.row === r)?.why ?? null;
  const label = `${subject && subject !== personRaw ? `${subject} — ` : ""}${who}`;
  return { label, to, channel: o.channel, subject: o.channel === "email" ? `${cap(what)}${status.replace(/ \(it was due [^)]+\)/, "")}` : null, body, held };
}

export function renderDraft(d: RowDraft): string[] {
  const head = [`#### ${d.label}${d.held ? ` · ${d.held}` : ""}`, "", d.channel === "text" ? `Text to ${d.to}` : `**To:** ${d.to}  `];
  if (d.subject) head.push(`**Subject:** ${d.subject}`);
  return [...head, "", ...d.body.split("\n").map((l) => (l ? `> ${l}` : ">")), ""];
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Criteria as prose: "days overdue > 100" → "more than 100 days overdue"; "days overdue > 0" → "overdue". */
export function criteriaProse(applied: string[]): string {
  const one = (a: string) =>
    a
      .replace(/^days overdue > 0$|^.+ before today$/, "overdue")
      .replace(/^days overdue ([>≥<≤]) (\d+)$/, (_m, op: string, n: string) => `${op === ">" ? "more than" : op === "≥" ? "at least" : op === "<" ? "less than" : "at most"} ${n} days overdue`)
      .replace(/^(.+?) ([>≥<≤]) (\$?[\d.]+)$/, (_m, c: string, op: string, n: string) => `${c} ${op === ">" ? "over" : op === "≥" ? "at least" : op === "<" ? "under" : "at most"} ${n}`);
  const xs = applied.map(one);
  // "overdue" is implied by "more than 90 days overdue".
  const ys = xs.filter((x) => !(x === "overdue" && xs.some((y) => y !== x && /overdue/.test(y))));
  return ys.length <= 1 ? (ys[0] ?? "") : `${ys.slice(0, -1).join(", ")} and ${ys[ys.length - 1]}`;
}

/** One-line description of what was done to the rows. */
export function describePlan(p: Plan, noun: string): string {
  const n = p.rows.length;
  const total = p.table.total ?? p.table.rows.length;
  const crit = p.applied.length ? ` (${criteriaProse(p.applied)})` : "";
  const sort = p.sortedBy ? `, ${p.sortedBy}` : "";
  const read = p.table.rows.length < total ? ` I could only read ${p.table.rows.length} of the ${total} rows in ${p.table.title}, so this may be incomplete.` : "";
  return `${n} ${n === 1 ? noun : plural(noun)}${crit}${sort} — from ${p.table.title} (${total} ${total === 1 ? "row" : "rows"}).${read}`;
}

export function plural(w: string): string {
  return /(?:s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
}

/** What one row is called in prose ("patient", "invoice", "claim"), from the subject column or the file name. */
export function nounOf(p: Plan): string {
  const h = p.cols.subject >= 0 ? norm(p.table.headers[p.cols.subject]!) : "";
  if (/^(?:patient|pet|animal|item|product|property|site|unit|job|project|account|vehicle|invoice|claim|order)$/.test(h)) return h;
  const t = p.table.title.toLowerCase();
  const m = /(patient|invoice|claim|order|customer|client|lead|job|property|tenant|account)s?/.exec(t);
  return m?.[1] ?? "row";
}

/** Chat answer from the rows: "2 patients more than 100 days overdue: Hazel (125 days, Nora Patel), Juniper (105 days, Alicia Moreno)." */
export function answerFromRows(question: string, tables: FileTable[], rules: string[], now: Date): string | null {
  if (!asksForRows(question)) return null;
  let best: Plan | null = null;
  for (const t of tables) {
    const p = planRows(t, question, rules, now);
    if (!p.applied.length && !p.sortedBy && !p.limit) continue;
    if (!best || p.applied.length > best.applied.length) best = p;
  }
  if (!best) return null;
  const p = best;
  const noun = nounOf(p);
  const show = p.rows.slice(0, 12).map((r) => {
    const name = p.cols.subject >= 0 ? r[p.cols.subject] : r[0];
    const od = p.cols.overdue >= 0 ? r[p.cols.overdue] : p.derived?.values.get(r);
    const who = p.cols.person >= 0 && r[p.cols.person] !== name ? r[p.cols.person] : null;
    return `${name}${od != null && od !== "" ? ` — ${od} days` : ""}${who ? ` (${who})` : ""}`;
  });
  const crit = p.applied.length ? criteriaProse(p.applied) : "";
  const total = p.table.total ?? p.table.rows.length;
  if (!p.rows.length) return `None: no ${plural(noun)} in ${p.table.title} are ${crit || "a match"} (${total} rows checked).`;
  const many = p.rows.length === 1 ? `1 ${noun}` : `${p.rows.length} ${plural(noun)}`;
  const partial = p.table.total != null && p.table.rows.length < p.table.total ? ` (I could only read ${p.table.rows.length} of ${p.table.total} rows)` : "";
  const verb = crit ? ` ${p.rows.length === 1 ? "is" : "are"} ${/^[a-z ]+ (?:is|over|under|at)/.test(crit) ? `a match (${crit})` : crit}` : "";
  const order = p.sortedBy && !crit ? `, ${p.sortedBy}` : "";
  return `${many} in ${p.table.title}${verb}${order}${partial}: ${show.join("; ")}${p.rows.length > 12 ? `; and ${p.rows.length - 12} more` : ""}.`;
}
