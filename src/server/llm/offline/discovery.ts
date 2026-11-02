/**
 * Offline discovery-call reader: transcript → structured facts the Architect designs from.
 *
 * Deterministic, no model. It segments the call into speaker turns and sentences, scores each client sentence for
 * "pain" (stated time costs, money at stake, manual/chasing language), and groups pain sentences into distinct
 * topics — one per task the owner described — by following the conversation: a topic starts where the owner
 * introduces a task ("The other thing is unscheduled treatment."), and the sentences after it (hours, dollars,
 * systems, rules) attach to that topic until the next one starts. A word that only appears in passing ("my front
 * desk lead, Rosa", "we have a report in Dentrix") never starts a topic.
 */
import { normalizeWhitespace, splitSentences as baseSplit, truncate } from "../text";

const DOT = "\u2024";
/**
 * Sentence split that knows abbreviations: "St. Luke's", "Dr. Patel", "Acme Inc., our biggest", "e.g. the trash",
 * "7 a.m. shift" stay inside their sentence. A dot that ends an abbreviation still ends the sentence when a capital
 * follows and the abbreviation is not a title ("at 7 a.m. Then I…").
 */
export function splitSentences(text: string): string[] {
  const guarded = text
    // Titles and place words are always followed by a name: never a sentence end.
    .replace(/\b(St|Dr|Mr|Mrs|Ms|Mt|Jr|Sr|Prof|Rev|Capt|Sgt|Lt|Ft|Hon|Gov|Gen|Messrs)\.(?=\s+[A-Z0-9])/g, `$1${DOT}`)
    // Company and street words, and "etc."/"vs."/"approx.", when the sentence clearly goes on.
    .replace(/\b(Inc|Co|Corp|Ltd|LLC|Bros|Ave|Blvd|Rd|Ste|Bldg|Dept|Mfg|etc|vs|approx|est|incl|ext)\.(?=\s*[a-z0-9,;:)]|\s+&)/g, `$1${DOT}`)
    .replace(/\bNo\.(?=\s?\d)/g, `No${DOT}`)
    // Dotted short forms: e.g. i.e. a.m. p.m. U.S. — inner dots always, the last one when the sentence goes on.
    .replace(/\b((?:[A-Za-z]\.){1,3}[A-Za-z])\.(?=\s*[a-z0-9,;:)])/g, (_m, a: string) => `${a.replace(/\./g, DOT)}${DOT}`)
    .replace(/\b((?:[A-Za-z]\.){1,3}[A-Za-z])\.(?=\s|$)/g, (_m, a: string) => `${a.replace(/\./g, DOT)}.`)
    // Initials before a surname: "J. Smith".
    .replace(/(^|\s)([A-Z])\.(?=\s+[A-Z][a-z])/g, `$1$2${DOT}`);
  return baseSplit(guarded).map((x) => x.replace(/\u2024/g, "."));
}

// ───────────────────────────────────────────── shapes ─────────────────────────────────────────────

export type Action =
  | "verify"
  | "chase"
  | "report"
  | "triage"
  | "urgent"
  | "deadline"
  | "packet"
  | "close"
  | "quote"
  | "entry"
  | "schedule"
  | "coverage"
  | "reviews"
  | "sync"
  | "invoice"
  | "inbox"
  | "manual";

export type Sentence = {
  text: string;
  turn: number;
  idx: number;
  speaker: string | null;
  afterItch: boolean;
  question?: string | null;
  asked?: boolean;
  /** The owner's explicit ask: the answer to "if you woke up tomorrow and one thing was done…", or "what I really want is…". */
  ask?: boolean;
};

export type Cadence =
  | { kind: "daily"; days: "1-5" | "1-6" | "*" }
  | { kind: "weekly"; dow: number; months?: number[]; dows?: number[] }
  | { kind: "monthly"; day: number; deadlineDay: number | null }
  | { kind: "event"; channel: "email" | "sms" };

export type Topic = {
  action: Action;
  /** The task object as the owner said it ("insurance verifications", "owner reports"). */
  phrase: string;
  /** Qualifier captured with the object ("insurance", "owner", "lease"). */
  qualifier: string;
  sentences: Sentence[];
  first: Sentence;
  hoursPerWeek: number | null;
  money: number | null;
  moneyText: string | null;
  score: number;
  cadence: Cadence | null;
  items: string[];
  /** Every "A, B, C" list said about this task, with its sentence. */
  lists: Array<{ text: string; items: string[] }>;
  systems: string[];
  people: string[];
  rules: string[];
  leadDays: number | null;
  /** The speaker's own name for the job ("Vaccine recalls", "Post-surgery check-ins"), when they named it. */
  label?: string;
};

export type Person = { name: string; role: string | null };

export type Discovery = {
  owner: string | null;
  turns: number;
  sentences: Sentence[];
  topics: Topic[];
  people: Person[];
  systems: string[];
  rules: string[];
  /** "Never promise a homeowner a dollar amount." — hard rules the agent must follow. */
  guardrails: string[];
  channels: { sms: boolean; slack: boolean; email: boolean };
  /** Who wants the morning output, how, and by when. */
  recipient: { name: string | null; channel: "email" | "sms" | null; by: { h: number; m: number } | null };
  compliance: string[];
  facts: string[];
  preferences: string[];
  resale: string | null;
  vertical: string | null;
  /** Topics the owner explicitly asked for first, in the order asked. */
  askTopics: Topic[];
  /** Hours a week the owner described across every pain (the sum of what they said). */
  statedHours: number;
  /** How the owner wants the agent to sound ("Warm but short. No fluff."), when asked. */
  tone: string | null;
};

// ───────────────────────────────────────────── segmentation ─────────────────────────────────────────────

const AGENCY_SPEAKERS = /^(?:agency|host|interviewer|consultant|operator|me|q|us|rep|sales|advisor|aj)$/i;
const NOT_A_SPEAKER = /^(?:note|notes|update|example|subject|re|ps|transcript|summary|agenda|action items?)$/i;

type Turn = { speaker: string | null; text: string; agency: boolean };

function cleanLine(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\\[[^\]]*\\\]/g, " ")
    .replace(/\[(?:music|laughter|applause|crosstalk|inaudible)\]/gi, " ")
    .replace(/\*\*/g, "")
    .replace(/\b(?:uh|um|you know),?\s+/gi, "")
    .replace(/\b(\w+) \1\b/gi, "$1");
}

export function parseTurns(raw: string): Turn[] {
  let t = raw.replace(/^---[\s\S]*?\n---\n/, "");
  const marker = t.search(/^##\s+Transcript\s*$/im);
  if (marker >= 0) t = t.slice(marker);
  t = t.replace(/^#+\s.*$/gm, "");
  // A new turn starts at a timestamp, a "Name:" label at line start, or a blank line.
  const blocks = t
    .replace(/\r/g, "")
    .split(/\n\s*\n|\n(?=\s*(?:\*\*)?\[?\d{1,2}:\d{2}(?::\d{2})?\]?(?:\*\*)?)|\n(?=[A-Z][A-Za-z.'-]{1,20}(?: [A-Z][A-Za-z.'-]{1,20})?:\s)/)
    .map((b) => b.trim())
    .filter(Boolean);
  const turns: Turn[] = [];
  for (const b0 of blocks) {
    const b = b0.replace(/^(?:\*\*)?\[?\d{1,2}:\d{2}(?::\d{2})?\]?(?:\*\*)?\s*·?\s*/, "");
    const m = /^([A-Z][A-Za-z.'-]{1,20}(?: [A-Z][A-Za-z.'-]{1,20})?):\s+([\s\S]*)$/.exec(b);
    const speaker = m && !NOT_A_SPEAKER.test(m[1]!) ? m[1]! : null;
    const text = normalizeWhitespace(cleanLine(speaker ? m![2]! : b));
    if (text.length < 2) continue;
    turns.push({ speaker, text, agency: speaker ? AGENCY_SPEAKERS.test(speaker) : false });
  }
  // "Attendees: Marco Delgado (Ridgeline AI), Rick Alvarez (owner, Summit Peak Roofing)": anyone not marked as the
  // client's owner/staff is on the agency side.
  const att = /\b(?:attendees|participants|on the call)\s*:\s*([^\n]+)/i.exec(t)?.[1];
  if (att) {
    for (const m of att.matchAll(/([A-Z][a-z]+)(?: [A-Z][a-z]+)?\s*\(([^)]*)\)/g)) {
      const clientSide = new RegExp(`\\b(?:owner|founder|ceo|president|manager|office|staff|lead|partner|bookkeeper|coordinator|accountant|admin|${ROLE_WORDS})\\b`, "i").test(m[2]!);
      if (!clientSide) for (const x of turns) if (x.speaker === m[1] || x.speaker?.startsWith(`${m[1]} `)) x.agency = true;
    }
  }
  // Named interviewer ("AJ:", "Sarah:"): the labelled speaker who mostly asks questions.
  const speakers = [...new Set(turns.map((x) => x.speaker).filter((s): s is string => !!s))];
  if (speakers.length >= 2 && !turns.some((x) => x.agency && x.speaker)) {
    const qRatio = (s: string) => {
      const mine = turns.filter((x) => x.speaker === s);
      return mine.filter((x) => /\?\s*$/.test(x.text)).length / Math.max(1, mine.length);
    };
    const asker = [...speakers].sort((a, b) => qRatio(b) - qRatio(a))[0]!;
    if (qRatio(asker) >= 0.4) for (const x of turns) if (x.speaker === asker) x.agency = true;
  }
  // In a labelled call, unlabelled lines are headers and stage directions, not the client talking.
  return speakers.length ? turns.filter((x) => x.speaker) : turns;
}

// ───────────────────────────────────────────── numbers ─────────────────────────────────────────────

const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "a couple": 2, "a couple of": 2, "a few": 3, several: 4, half: 0.5,
};
const NUM = String.raw`(\d+(?:\.\d+)?|a couple(?: of)?|a few|several|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|half an?)`;
const toNum = (s: string): number | null => {
  const k = s.toLowerCase().replace(/^half an?$/, "half");
  if (Number.isFinite(Number(k))) return Number(k);
  return WORD_NUM[k] ?? null;
};

/** "two or three" / "three, four" / "3-4" → 2.5 / 3.5 / 3.5. A comma pair only counts when it reads as a range. */
const RANGE = String.raw`${NUM}(?:\s*(?:-|–|to|or|,)\s*${NUM})?`;
const rangeOf = (a: string | undefined, b: string | undefined): number | null => {
  const x = toNum(a ?? "");
  if (x == null) return null;
  const y = b ? toNum(b) : null;
  // "38, two hours" is not a range: the number next to "hours" counts.
  return y == null ? x : y > x && y <= x * 2 + 2 ? (x + y) / 2 : y;
};
const DOWS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const RE_HOURS_PER = new RegExp(
  String.raw`\b${RANGE}\s*(?:hours?|hrs?)\b(?:\s+and a half)?(?:,?\s+(?:easy|tops|or so|at least|minimum|probably|maybe|total))?,?\s+(?:once\s+)?(?:a|per|each|every|on)\s+(week|weekday|day|month|morning|night|evening|afternoon|(?:${DOWS})s?)\b`,
  "i",
);
const RE_HOURS_DAILY = new RegExp(String.raw`\b${RANGE}\s+(and a half\s+)?hours?(\s+and a half)?\b(?!,?\s+(?:a|per|each|every)\s+(?:week|month))[^.]{0,40}?\b(?:every|each) (?:single )?(morning|day|night|evening|afternoon|weekday|${DOWS})`, "i");
const RE_DAILY_HOURS_REV = new RegExp(String.raw`\b(?:every|each) (?:single )?(morning|day|night|evening|afternoon|${DOWS})\b[^.]{0,40}?\b${RANGE}\s+(and a half\s+)?hours?(\s+and a half)?`, "i");
const RE_DAYS_REV = new RegExp(String.raw`\b(?:every|each) (week|month|quarter)(?:[- ]end)?\b[^.]{0,40}?\b${NUM}\s+(?:full\s+|whole\s+)?(?:work\s*)?days?\b`, "i");
const RE_DAYS_PER = new RegExp(String.raw`\b${NUM}\s+(?:full\s+|whole\s+)?(?:work\s*)?days?\b[^.]{0,30}?\b(?:a|per|each|every)\s+(week|month|quarter)`, "i");
/** "That's three, four hours when I do it." — a time cost with no period; the task's cadence supplies it. */
const RE_HOURS_BARE = new RegExp(String.raw`\b(?:that'?s|it'?s|takes?|took|spend\w*|eats?|costs?|about|maybe|probably|easily|like)\s+(?:me\s+|us\s+|her\s+|him\s+)?(?:\w+\s+){0,2}?${RANGE}\s+(?:hours?|hrs?)\b(?!\s+(?:a|per|each|every|ago|later|before|after|notice|away|out)\b)`, "i");

type HoursKind = "week" | "dow" | "day" | "month" | "days";
/** A time cost stated in a sentence, per week, with what kind of statement it was (so restatements aren't summed). */
function hoursStatement(s: string): { hours: number; kind: HoursKind } | null {
  const perDay = (unit: string) => (new RegExp(`^(?:${DOWS})s?$`, "i").test(unit) ? 1 : 5);
  const d = RE_HOURS_DAILY.exec(s);
  if (d) {
    const n = rangeOf(d[1], d[2]) ?? 1;
    const unit = d[5] ?? "day";
    return { hours: round1((n + (d[3] || d[4] ? 0.5 : 0)) * perDay(unit)), kind: perDay(unit) === 1 ? "dow" : "day" };
  }
  const r = RE_DAILY_HOURS_REV.exec(s);
  if (r) {
    const n = rangeOf(r[2], r[3]) ?? 1;
    const unit = r[1] ?? "day";
    return { hours: round1((n + (r[4] || r[5] ? 0.5 : 0)) * perDay(unit)), kind: perDay(unit) === 1 ? "dow" : "day" };
  }
  const h = RE_HOURS_PER.exec(s);
  if (h?.[1] && h[3]) {
    const n = rangeOf(h[1], h[2]);
    if (n == null) return null;
    const half = /and a half/i.test(h[0]) ? 0.5 : 0;
    const unit = h[3].toLowerCase();
    if (unit === "week") return { hours: round1(n + half), kind: "week" };
    if (unit === "month") return { hours: round1((n + half) / 4.33), kind: "month" };
    if (new RegExp(`^(?:${DOWS})s?$`).test(unit)) return { hours: round1(n + half), kind: "dow" };
    return { hours: round1((n + half) * 5), kind: "day" };
  }
  const dr = RE_DAYS_REV.exec(s);
  if (dr?.[1] && dr[2]) {
    const n = toNum(dr[2]);
    const unit = dr[1].toLowerCase();
    if (n != null) return { hours: round1(n * 8 * (unit === "week" ? 1 : unit === "month" ? 1 / 4.33 : 1 / 13)), kind: "days" };
  }
  const dd = RE_DAYS_PER.exec(s);
  if (dd?.[1] && dd[2]) {
    const n = toNum(dd[1]);
    if (n == null) return null;
    const unit = dd[2].toLowerCase();
    return { hours: round1(n * 8 * (unit === "week" ? 1 : unit === "month" ? 1 / 4.33 : 1 / 13)), kind: "days" };
  }
  return null;
}

/** Hours per week of human time stated in a sentence, or null. */
export function hoursPerWeekIn(s: string): number | null {
  return hoursStatement(s)?.hours ?? null;
}

/** Hours with no period ("three, four hours when I do it"), or null. */
export function bareHoursIn(s: string): number | null {
  if (hoursStatement(s)) return null;
  const m = RE_HOURS_BARE.exec(s);
  if (!m) return null;
  const n = rangeOf(m[1], m[2]);
  if (n == null) return null;
  // "40 hours spread across December and January" is a season's total, not a week's.
  const rest = s.slice((m.index ?? 0) + m[0].length);
  if (/^\s*(?:spread |in total|total|all told)?\s*(?:across|over|between|during|in)\b/i.test(rest) || /\b(?:a|per|every|each) (?:single )?year\b|\bannually\b/i.test(s)) {
    const months = (rest.match(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi) ?? []).length;
    const nm = /\b(two|three|four|six|\d+) months\b/i.exec(rest);
    const span = months || (nm ? (toNum(nm[1]!) ?? 0) : 0);
    return span ? round1(n / (span * 4.33)) : null;
  }
  return n;
}

/**
 * One task's weekly hours from everything the owner said about it: the largest statement of each kind, summed across
 * kinds ("two hours every Monday" + "an hour a day" = 7), but a weekly figure that restates a daily one is not added.
 */
function combineHours(xs: Array<{ hours: number; kind: HoursKind }>): number | null {
  if (!xs.length) return null;
  const best = new Map<HoursKind, number>();
  for (const x of xs) best.set(x.kind, Math.max(best.get(x.kind) ?? 0, x.hours));
  const week = best.get("week");
  const day = best.get("day");
  if (week != null && day != null && Math.abs(week - day) <= Math.max(week, day) * 0.25) best.delete(week >= day ? "day" : "week");
  return round1([...best.values()].reduce((a, b) => a + b, 0));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Largest dollar amount in a sentence ("$180,000", "$6K", "180 grand"). */
export function moneyIn(s: string): { value: number; text: string } | null {
  let best: { value: number; text: string } | null = null;
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|K|m|M|million|thousand)?\b|\b(\d+(?:\.\d+)?)\s?(grand|thousand dollars|k dollars)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number((m[1] ?? m[3] ?? "0").replace(/,/g, ""));
    const unit = (m[2] ?? m[4] ?? "").toLowerCase();
    const v = n * (unit === "k" || unit === "thousand" || unit === "grand" || unit === "thousand dollars" || unit === "k dollars" ? 1000 : unit === "m" || unit === "million" ? 1_000_000 : 1);
    if (!best || v > best.value) best = { value: v, text: m[0].trim() };
  }
  return best;
}

// ───────────────────────────────────────────── task objects ─────────────────────────────────────────────

type Concept = {
  action: Action;
  /** Matches the task object. Group 1 (optional) = qualifier, group 2 (optional) = object. */
  re: RegExp;
  /** A match that names no object ("chase them") continues the current topic instead of starting one. */
  needsObject?: boolean;
};

/**
 * Generic business tasks (not industries). Order matters: earlier concepts win when one phrase matches several
 * ("follow up on estimates" is chasing, not quoting).
 */
const CONCEPTS: Concept[] = [
  { action: "urgent", re: /\b(after[- ]hours|overnight|middle of the night|weekend|late[- ]night)\s+(emergenc(?:y|ies)|calls?|texts?|requests?)\b|\b(emergenc(?:y|ies))\s+(?:after hours|at night|overnight|on (?:the )?weekends?)/i },
  { action: "verify", re: /\b(insurance|eligibility|benefits?|coverage|credit|background|license|income|employment)\s+(verifications?|checks?)\b|\b()(verif(?:y|ying|ied|ications?))\b|\b()(eligibility and benefits)\b/i },
  {
    action: "chase",
    re: /\b(unscheduled|unbooked|unsigned|outstanding|past[- ]due|overdue|unpaid|missing|open)\s+(treatment(?: plans?)?|estimates?|quotes?|proposals?|receipts?|documents?|invoices?|paperwork|balances?|leads?|applications?)\b|\bfollow(?:ing|s)?[- ]?(?:ups?\s+)?(?:up\s+)?(?:on|with)\s+(?:the |our |all |those |these )?()((?!them\b|it\b|that\b)[a-z]+(?: [a-z]+)?)|\bchas(?:e|es|ing)\s+(?:clients|customers|patients|people|homeowners|tenants|owners|members)\s+(?:for|about|on)\s+()([a-z]+(?: (?:and )?(?:missing )?[a-z]+)?)|\b()((?:1099|W-?9|W-?2|COI|lien waiver)s?)\b|\b(?:the |our )?(adjusters?|carriers?|insurance compan(?:y|ies)|vendors?|subs?)\s+(chased|follow[- ]?ups?)\b|\b(?:heard back from|chas(?:e|ing)|follow(?:ing)? up with) (?:the |our )?()(adjusters?|carriers?|insurance compan(?:y|ies))\b|\b()(aging (?:report|list))\b|\b(vaccine|appointment|dental|annual|wellness|service)?\s?(recalls?)\b/i,
  },
  { action: "close", re: /\b(month[- ]end|year[- ]end|quarter[- ]end)\s+(close|closes|closing)\b|\b()(clos(?:e|ing) the books|close package|reconciliations?|reconcil(?:e|ing) (?:the )?(?:bank|accounts|credit cards?))\b/i },
  { action: "renewal" as Action, re: /\b(lease|policy|contract|membership|subscription|license|warranty|service agreement)\s+(renewals?)\b|\b()(renewal (?:offers?|notices?|letters?))\b|\b(policy|insurance|contract|membership)?\s?(renewals?)\b/i },
  { action: "packet", re: /\b(insurance|warranty|permit)\s+(claims? (?:paperwork|packets?|files?|documentation|submissions?)|claims? and supplements?|paperwork)\b|\b()(supplements?|(?:claim |insurance )?packets?|paperwork|permit applications?|submittals?)\b/i },
  {
    action: "triage",
    re: /\b(maintenance|service|repair|support|warranty|work)\s+(requests?|tickets?|orders?)\b|\b()(dispatch(?:es|ing|ed)? (?:a |the )?vendors?|vendors? (?:gets? )?dispatched|(?:preferred )?vendor list|pick the vendor)\b|\b(client|customer|tenant|site)?\s?(complaints?)\b|\b()(log (?:it|them|each one)|tell the (?:crew|shift|team|site) (?:lead|supervisor)|sends? (?:me|us) ["“])/i,
  },
  { action: "report", re: /\b(monthly|weekly|daily|quarterly|monday|owner|client|cash|board|investor|status|performance|sales|progress|job[- ]cost|wip|management)\s+(reports?|statements?|summar(?:y|ies)|summary letters?|updates?)\b|\b()(reports?)\b(?= (?:every|each|by the|to (?:each|every|all)))|\b(weekly|monthly|daily)\s+(?:text |email |status )?(updates?)\b|\b(monday|weekly|monthly|friday)\s+(?:property[- ]manager|[a-z]+-[a-z]+|service|client|account|cash|status|inspection)\s+(reports?|updates?|summar(?:y|ies))\b|\bsend (?:each|every|all|our|the|my) (?:[a-z-]+ ){1,3}?(?:a |an |the )?(?:little |short |quick |brief )?(cash|status|progress|performance|sales|weekly|monthly|job[- ]cost|service|inspection)?\s?(reports?|updates?|summar(?:y|ies)|recaps?)\b/i },
  {
    action: "quote",
    re: /\b(?:put(?:ting)? together|build(?:ing)?|writ(?:e|ing)|creat(?:e|ing)|do(?:ing)?|draft(?:ing)?)\s+(?:the |a |an |our |my |each |every |all the )?()(quotes?|proposals?|bids?|estimates?)\b|\b(quote|proposal|bid)\s+(requests?|building|prep|writing)\b|^()(bids?|proposals?|quotes?|estimates?)[.!]?$|\b(?:copy(?:ing)?|reus(?:e|ing)) (?:the |my |our )?(?:last|old|previous) ()(proposals?|quotes?|bids?|estimates?)\b/i,
  },
  {
    action: "entry",
    re: /\b()(data entry|re-?typ(?:e|ing)|re-?key(?:ing)?|re-?enter(?:ing)?|copy(?:ing)? and past(?:e|ing)|migrat(?:e|ing|ion)|switch(?:ing)? over from|bring (?:all )?(?:of )?(?:this|the|their) data|pulling records|click(?:s|ing)? into (?:all )?(?:of )?(?:the )?(?:different )?fields|typ(?:e|es|ing) (?:the |it |them |every |each |all )?(?:[a-z]+ )?into)\b/i,
  },
  { action: "coverage", re: /\b()(sick calls?|call(?:s|ed)? in sick|call[- ]outs?|call(?:s|ed)? (?:me )?out\b|can'?t make (?:it|their shift|the shift)|cover (?:the |a |their |his |her )?shifts?|shift coverage|find (?:a |someone to )?(?:replacement|cover|sub(?:stitute)?))/i },
  { action: "schedule", re: /\b()((?:build(?:ing)?|mak(?:e|ing)|do(?:ing)?|reshuffl\w*) (?:the |our |a )?(?:technician |crew |tech |staff |driver |install )?schedules?|dispatch board|dispatch(?:ing)?(?! (?:a |the )?vendors?)(?=[\s.,]))/i },
  { action: "reviews", re: /\b(google|online|yelp|five[- ]star|5[- ]star|our|more|new|bad)\s+(reviews)\b|\b()(ask(?:ing)? (?:for|people for) (?:a )?reviews?|reputation)\b/i },
  { action: "sync", re: /\b()(scrap(?:e|es|ing)(?! agent)\b|catalogs?|price lists?|product (?:data|feeds?))\b/i },
  { action: "invoice", re: /\b()(invoic(?:es|ing)|billing|accounts receivable|past[- ]due (?:accounts|invoices))\b(?! codes?| numbers?)/i },
  { action: "inbox", re: /\b(?:the |my |our )?()(inbox|emails? (?:all day|pile up))\b/i },
];
// "renewal" is folded into the deadline action.
for (const c of CONCEPTS) if ((c.action as string) === "renewal") c.action = "deadline";

type Hit = { action: Action; qualifier: string; object: string; phrase: string; index: number };

export function conceptHits(s: string): Hit[] {
  const hits: Hit[] = [];
  for (const c of CONCEPTS) {
    const m = c.re.exec(s);
    if (!m) continue;
    // Pairs of (qualifier, object) groups: take the first pair that matched.
    let qualifier = "";
    let object = "";
    for (let g = 1; g < m.length; g += 2) {
      if (m[g] !== undefined || m[g + 1] !== undefined) {
        qualifier = (m[g] ?? "").trim();
        object = (m[g + 1] ?? "").trim();
        break;
      }
    }
    // "adjusters chased" / "adjuster follow-ups": the party is the object.
    if (/^(?:chased|follow[- ]?ups?)$/i.test(object)) {
      object = qualifier;
      qualifier = "";
    }
    // "log it, tell the crew lead" / "they send me “the trash wasn't emptied”": the task is handling client requests.
    if (c.action === "triage" && /^(?:log |tell |sends? )/i.test(object)) {
      qualifier = "client";
      object = "requests";
    }
    const phrase = normalizeWhitespace(`${qualifier} ${object}`).toLowerCase() || m[0].toLowerCase();
    if (hits.some((h) => h.action === c.action)) continue;
    hits.push({ action: c.action, qualifier: qualifier.toLowerCase(), object: object.toLowerCase(), phrase, index: m.index });
  }
  // Chasing overdue invoices is one job, not a chasing job and an invoicing job.
  if (hits.some((h) => h.action === "chase" && /invoice|balance|payment|receivable/.test(h.object))) return hits.filter((h) => h.action !== "invoice").sort((a, b) => a.index - b.index);
  // A follow-up of quotes/estimates is chasing; drop the quoting hit then.
  if (hits.some((h) => h.action === "chase")) return hits.filter((h) => h.action !== "quote" || !/follow|chas/i.test(s));
  return hits.sort((a, b) => a.index - b.index);
}

// ───────────────────────────────────────────── pain ─────────────────────────────────────────────

const PAIN_WORDS =
  /\bby hand\b|\bmanually\b|\bchas(?:e|es|ing)\b|\bcopy(?:ing)? and paste\b|\bre-?typ\w*|\bre-?key\w*|\bbehind\b|\bdrowning\b|\bworst\b|\bkills? us\b|\beats?\b|\bfalls? apart\b|\bnobody\b|\bwe miss\b|\bmiss(?:es|ed)? (?:some|it|them|one)\b|\bforget\b|\bdon'?t have the (?:hands|time|people|bandwidth)\b|\btedious\b|\bboring\b|\brepetitive\b|\bhate\b|\btakes? forever\b|\bsurprise bill\b|\bwr(?:ite|ote) off\b|\bdenied\b|\bgo(?:es)? cold\b|\bmonth to month\b|\bspends?\b|\bspending\b|\bhad to\b|\bhas to\b|\bhave to\b|\bwritten by hand\b|\bsitting (?:in|there)\b|\bsits (?:in|there)\b|\bfor (?:a|two|three) weeks?\b|\bslips?\b|\bfalls? through\b|\bpain\b|\bheadache\b|\bnightmare\b|\bhands down\b|\bwaiting on\b|\bwait,\b/gi;

const ITCH_Q = /\bitch\b|pain points?|eats? (?:up )?hours|spend(?:ing)? hours|repetitive|headache|biggest (?:problem|time)|walk me through your week|what(?:'s| is) (?:the|your) (?:biggest|main)/i;
/** Hedges and filler that never name a job ("honestly my week", "you know", "I mean"). */
const FILLER = /\b(?:honestly|basically|literally|actually|really|kind of|sort of|you know|i mean|my week|my day|my life|my time|the phone|stuff|things?|hands down)\b/i;
const NOT_NP = /\b(?:is|are|was|were|be|been|do|does|did|have|has|had|i|we|you|they|it|he|she|that|this|there|yes|yeah|no(?!-)|nope|sure|okay|ok|right|exactly|perfect|got|ugh|thanks?|sounds|mine|one|two|three|down|definitely|absolutely|totally|correct|great|cool|nice|wow|email|emails|text|texts|phone|mostly|both|neither|none|all)\b/i;
/** Questions that invite the next pain ("What's next?", "Where does your time go?"). */
const NEXT_Q = /what(?:'s| is)? next|what else|anything else|what other|where does (?:your|the) time|eats? the most|start there|walk me through|itch|biggest/i;
/** "Vaccine recalls." / "Then no-shows." / "Month-end close, no question." → the speaker's name for a job, or null. */
/** List markers and ordinals never name a job: "First, estimate follow-up." → "estimate follow-up." */
export const LIST_MARKER = /^(?:(?:first(?: of all| off)?|second(?:ly)?|third(?:ly)?|fourth|fifth|next|then|also|finally|lastly|last|one|two|three|four|five|number (?:one|two|three|four|five)|and|plus|oh,? and)[,:.]?\s+)+/i;
export function nounPhraseAnswer(text: string): string | null {
  const stripped = text.trim().replace(LIST_MARKER, "");
  if (stripped !== text.trim()) {
    if (!stripped || /^(?:first|second|third|fourth|fifth|next|one|two|three|four)[.!]?$/i.test(stripped)) return null;
    text = stripped;
  }
  const intro = /^(?:the|my|our) (?:biggest|main|worst|other|next|first|second|third) (?:drain|pain|problem|time sink|thing|one|headache|issue|time suck)(?: for (?:me|us))? is ([a-z][\w'’ -]{2,40}?)[.!]?$/i.exec(text.trim())?.[1];
  if (intro) return nounPhraseAnswer(intro);
  const m = /^(?:(?:and|then|also|plus|oh,? and|next|so)\s+)?([A-Za-z][\w'’-]*(?:[ ,]+[\w'’-]+){0,5}?)[.!]?$/i.exec(text.trim());
  if (!m) return null;
  const np = m[1]!.replace(/,.*$/, "").trim();
  if (!np || np.split(/\s+/).length > 5 || NOT_NP.test(np) || FILLER.test(np)) return null;
  return np;
}

const INTRO = /^(?:and|also|oh,? and|plus|then|the other|another|the worst|the biggest|the big one|honestly|on top of that|the main|our biggest|my biggest|the last|last thing|lastly|finally|one more)\b/i;

/** Agency questions that ask for the one thing the owner wants first. */
const ASK_Q =
  /woke up tomorrow|(?:great|perfect|ideal|good) (?:monday|morning|week|day|friday) look like|wake up tomorrow|one thing (?:was|were|got|is) (?:done|handled|off your plate)|magic wand|if you could (?:only )?(?:pick|choose|have|wave|snap)|what would you (?:want|pick|choose) first|start with first|most valuable|top priority|if we (?:only )?(?:did|do|fixed|fix|took) one thing|pay for first/i;
/** The owner stating the ask unprompted. */
const ASK_SELF =
  /\bwhat I (?:really |actually |honestly )?want(?:ed)? is\b|\bthe (?:one )?thing I'?d (?:pay|kill) for\b|\bif I woke up tomorrow\b|\bif I could (?:wave a magic wand|snap my fingers|have one thing)\b|\bI'?d pay (?:good money |anything |real money )?for (?:that|this|the|a|an|someone)\b|\bmy (?:number one|#1|top|biggest) (?:ask|wish|priority) (?:is|would be)\b/i;
/** A sentence that opens a new task mid-answer ("Every Monday I'm supposed to…"). */
const STRONG_START = /^(?:(?:and|also|plus|oh,? and)\s+)?(?:every|each|on) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|morning|night|evening|day)s?\b|\bI'?m (?:also )?supposed to\b|^(?:and )?then there'?s\b/i;
/** Questions about where data lives: the answer lists systems, it does not continue the last pain. */
const SYSTEMS_Q = /\bwhere(?:'s| does| do| is| are)?\b[^?]*\b(?:live|kept|stored)\b|\bwhat (?:systems?|software|tools?|apps?|programs?)\b|\bwhat do you use\b|\bwhere do you keep\b|\bwhat are you using\b/i;
/** Hard rules: "Never…", "And never…", "Always…", "Don't ever…", "Rule one: never…". */
export const GUARD_RE =
  /^(?:(?:and|but|also|oh,? and|plus|so|okay|ok|please|one|two|three|first|second|third|number (?:one|two|three)|rule (?:one|two|number \w+)|the (?:big |main |hard |one )?rule is|hard rule|and (?:also|please))[,:.]?\s+)*(?:never|always|don'?t ever|do not ever|under no circumstances|make sure|no one|nobody (?:but|except)|only (?:ever )?(?:talk|speak|email|text|contact|deal))\b|\b(?:you|the agent|it|we|the assistant) (?:should|must|can) (?:never|not ever)\b|\bnot allowed to\b|\bonly ever (?:talk|speak|deal|email|text|call|contact|work|go)\b|\bonly (?:talk|speak) (?:to|with)\b|\b(?:always|everything|that account) goes? through (?:me|[A-Z][a-z]+)\b|\bis the only (?:one|person|people)\b/i;

const WANT = /\b(?:[A-Z][a-z]+|[Hh]e|[Ss]he) wants (?:a|an|the|his|her)\b|\bI'?d like (?:a|an|the)\b|\bI'?d love\b|\bwould love\b|\bthat would (?:be huge|change)\b|\bif (?:she|he|we|I) had\b|\bI want\b|\bwe want\b/i;

function painScore(s: string): number {
  const hours = hoursPerWeekIn(s);
  const money = moneyIn(s);
  const words = (s.match(PAIN_WORDS) ?? []).length;
  return (hours ? 3 + Math.min(hours, 20) / 2 : 0) + (money ? 2 + Math.log10(Math.max(10, money.value)) / 2 : 0) + words * 1.5 + (WANT.test(s) ? 2.5 : 0);
}

// ───────────────────────────────────────────── entities ─────────────────────────────────────────────

const KNOWN_SYSTEMS = [
  "Salesforce", "HubSpot", "QuickBooks Online", "QuickBooks", "Xero", "NetSuite", "Sage Intacct", "FreshBooks", "Bill.com", "Gusto", "ADP", "Expensify",
  "Hubdoc", "Dext", "Karbon", "TaxDome", "Canopy", "Excel", "Google Sheets", "Google Sheet", "Google Drive", "Dropbox", "Gmail", "Outlook", "Shopify", "Canva",
  "Zapier", "ServiceTitan", "Housecall Pro", "Jobber", "Applied Epic", "EZLynx", "HawkSoft", "Dentrix", "Eaglesoft", "Open Dental", "Weave",
  "Clio", "Asana", "Trello", "Notion", "Airtable", "Stripe", "Square", "SAGE", "ESP", "commonsku", "DocuSign", "Calendly", "AppFolio", "Buildium",
  "Yardi", "Rent Manager", "Xactimate", "AccuLynx", "JobNimbus", "CompanyCam", "EagleView", "Procore", "Buildertrend", "CoConstruct", "Podium",
  "Mailchimp", "Klaviyo", "Toast", "Slack", "Teams", "Zoom", "PestPac", "Cornerstone", "AVImark", "ezyVet", "FieldRoutes", "GorillaDesk", "ServiceTrade", "Swept", "Janitorial Manager",
];
/** Chat/meeting apps are channels, not systems the agent works in. */
const NOT_WORK_SYSTEMS = new Set(["Slack", "Teams", "Zoom", "Gmail", "Outlook"]);
const CAP_STOP = new Set(
  "I We She He They It The A An And Or But So Then Also Every Each Our My Their His Her This That These Those If When What Who How Why Anything Nothing Tenants Owners Patients Clients Customers Email Text Texts Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Honestly Maybe Yeah Okay Oh Last Dr Mr Mrs Ms Hi Hey HVAC PM AM Sheet Sheets Drive Docs Online Excel Gmail Square Portal".split(" "),
);

/** Product names that are also everyday words ("square footage", "my teams", "a toast"): named only as software. */
const COMMON_WORD_SYSTEMS = new Set(["Square", "Toast", "Teams", "Notion", "Canopy", "Weave", "Podium", "Stripe", "Zoom", "Excel", "Slack", "Outlook", "Gusto", "Sage"]);
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "we use Square", "in Square", "the Square app" — yes; "Square footage, frequency…" — no. */
function namedAsSoftware(s: string, name: string): boolean {
  for (const m of s.matchAll(new RegExp(`(^|[^A-Za-z])(${esc(name)})(?![A-Za-z])`, "g"))) {
    const at = (m.index ?? 0) + m[1]!.length;
    const before = s.slice(Math.max(0, at - 32), at).toLowerCase();
    const after = s.slice(at + name.length, at + name.length + 28);
    if (/^\s*(?:footage|feet|foot|meters?|miles?|yards?|inch(?:es)?|deal|meal|root|dance|one|ones|off|up|away|corner|peg|knot)\b/i.test(after)) continue;
    if (/\b(?:in|on|of|into|from|through|via|using|use|uses|used|with|our|my|their|the|to|switched to|moved to|run on|runs on|log into|logged into|microsoft|google)\s*$/.test(before)) return true;
    if (/^\s*(?:app|pos|account|dashboard|software|system|terminal|reader|payments?|integration|export|reports?|data|invoices?|for|files?|spreadsheets?|sheets?|workbooks?|channel|meeting|call)\b/i.test(after)) return true;
  }
  return false;
}

function systemsIn(s: string): string[] {
  const out: string[] = [];
  for (const t of KNOWN_SYSTEMS) {
    const common = COMMON_WORD_SYSTEMS.has(t);
    const re = new RegExp(`\\b${esc(t)}\\b`, t === "ESP" || t === "SAGE" || common ? "" : "i");
    if (!re.test(s) || (common && !namedAsSoftware(s, t))) continue;
    if (!out.some((o) => o.toLowerCase().startsWith(t.toLowerCase()))) out.push(t);
  }
  // "the Delta Dental portal, MetLife, Cigna, Guardian" — portals/sites the owner logs into.
  if (/\b(?:log(?:s|ging)? in(?:to)?|portals?|websites?|carrier sites?)\b/i.test(s)) {
    const re = /(?:^|[\s,(])((?:[A-Z][a-zA-Z]+|[A-Z]{2,})(?: (?:[A-Z][a-zA-Z]+|[A-Z]{2,}))?)(?= portal|,| and|\)|\.| sometimes| when)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const name = m[1]!;
      const first = name.split(" ")[0]!;
      if (CAP_STOP.has(first) || m.index === 0) continue;
      if (!out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(/portal/i.test(s.slice(m.index, m.index + name.length + 9)) ? `${name} portal` : name);
    }
  }
  return out;
}

const ROLE_WORDS =
  "managing partner|managing attorney|senior partner|attorney|ops lead|operations lead|crew lead|shift lead|lead cleaner|site supervisor|office manager|front desk lead|front desk|bookkeeper|assistant|partner|business partner|wife|husband|dispatcher|operations manager|ops manager|controller|accountant|coordinator|project manager|production manager|estimator|admin|administrator|senior accountant|staff accountant|associate|paralegal|manager|lead|supervisor|foreman|office admin|claims coordinator|leasing agent|property manager";

function peopleIn(sentences: string[]): Person[] {
  const out: Person[] = [];
  const add = (name: string, role: string | null) => {
    if (!name || CAP_STOP.has(name) || /^(?:Hey|Okay|Yeah|Just|So|Well|Like)$/.test(name)) return;
    const prev = out.find((p) => p.name === name);
    if (prev) {
      if (!prev.role && role) prev.role = role;
      return;
    }
    out.push({ name, role });
  };
  const roleFirst = new RegExp(`\\b(?:[Mm]y|[Oo]ur) (${ROLE_WORDS}),? ([A-Z][a-z]+)\\b`, "g");
  const nameFirst = new RegExp(`\\b([A-Z][a-z]+),? (?:my|our) (${ROLE_WORDS})\\b`, "g");
  for (const s of sentences) {
    for (const [re, roleIdx, nameIdx] of [[roleFirst, 1, 2], [nameFirst, 2, 1]] as const) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) add(m[nameIdx]!, m[roleIdx]!);
    }
    for (const m of s.matchAll(/\bDr\.? ([A-Z][a-z]+)/g)) add(`Dr. ${m[1]}`, "doctor");
    for (const m of s.matchAll(/\b(?:my|our) (?:two |three |\w+ )?((?:senior |staff )?(?:accountants|coordinators|managers|techs|technicians|estimators|partners|hygienists)),? ([A-Z][a-z]+) and ([A-Z][a-z]+)\b/g)) {
      add(m[2]!, singular(m[1]!));
      add(m[3]!, singular(m[1]!));
    }
    for (const m of s.matchAll(/\b(?:his|her|my) name is ([A-Z][a-z]+)/g)) add(m[1]!, null);
  }
  return out;
}

/** "A, B, C and D" lists inside a clause: the things a report covers or a check captures. */
function listItems(s: string): string[] {
  const clauses = s.split(/\s+[—–-]\s+|:\s+|,\s+(?:and\s+|then\s+)?(?:sometimes\s+|also\s+)?(?=(?:writes|calls|checks|records|enters|puts|types|copies|updates|sends|gets|logs|emails|texts|reads|figures|dispatches|marks|adds|pulls|uploads|builds)\b)/);
  let best: string[] = [];
  for (const c of clauses) {
    const parts = c.split(/,\s*(?:and\s+|or\s+)?|\s+and\s+(?=whether|if\b)/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const cleaned = parts
      .map((p, i) => {
        let x = p.replace(/[.;]+$/, "");
        if (i === 0) x = x.replace(/^.*?\b(?:writes|captures|records|checks|includes|covers|gets|like|such as|is|are|the)\s+(?=\S)/i, "");
        if (i === parts.length - 1) x = x.replace(/\s+(?:into|to|for the|before|so)\s+.*$/i, "");
        return x.replace(/^(?:and|or|the|a|an)\s+/i, "").replace(/^whether it'?s\s+/i, "").trim();
      })
      .filter((x, i) => x.length >= 3 && x.split(/\s+/).length <= 7 && !(i === 0 && /\b(?:miss(?:es)?|is|are|has|have|needs?|gets?|spits|takes)\b/i.test(x)));
    // Prefer lists of things (lowercase) over lists of names (systems, carriers).
    const weight = (xs: string[]) => xs.filter((x) => /^[a-z]/.test(x)).length * 2 + xs.length;
    if (weight(cleaned) > weight(best)) best = cleaned;
  }
  return best.length >= 3 ? best.slice(0, 8) : [];
}

const TIME_RE = /\b(?:at|by|before|around|gets? in at|(?:he'?s|she'?s|i'?m|is) in (?:at|by)|in the truck by|starts? at|huddle is at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/gi;

function earliestMorningTime(s: string): { h: number; m: number } | null {
  let best: { h: number; m: number } | null = null;
  for (const m of s.matchAll(TIME_RE)) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    const ap = (m[3] ?? "").toLowerCase();
    if (ap.startsWith("p") && h < 12) h += 12;
    if (h < 5 || h > 11) continue;
    if (!best || h * 60 + min < best.h * 60 + best.m) best = { h, m: min };
  }
  return best;
}

function cadenceIn(text: string): Cadence | null {
  const t = text.toLowerCase();
  const by = /\bby the (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (/\bevery month\b|\bmonthly\b|\beach month\b|\bmonth[- ]end\b|\bby the \d{1,2}(?:st|nd|rd|th)\b|\bfirst (?:week|few days) of (?:the|every) month\b/.test(t)) {
    const deadline = by ? Number(by[1]) : null;
    return { kind: "monthly", day: deadline ? Math.max(1, deadline - 4) : /month[- ]end/.test(t) ? 1 : 1, deadlineDay: deadline };
  }
  const dows = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  // "Every Monday and Thursday", "mostly Tuesdays and Wednesdays", "Friday afternoons", "usually Sunday night".
  const dm = /\b(?:every|on|mostly|usually|each) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?:(?:,| and|,? or) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?)?\b|\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s? (?:afternoons?|mornings?|nights?|evenings?)\b|\b(sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)(?: and (sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays))?\b/.exec(t);
  if (dm) {
    const days = [dm[1], dm[2], dm[3], dm[4], dm[5]].filter((x): x is string => !!x).map((x) => dows.indexOf(x.replace(/s$/, ""))).filter((x) => x >= 0);
    if (days.length) return days.length > 1 ? { kind: "weekly", dow: days[0]!, dows: [...new Set(days)] } : { kind: "weekly", dow: days[0]! };
  }
  if (/\bevery week\b|\bweekly\b|\beach week\b|\bonce a week\b/.test(t)) return { kind: "weekly", dow: 1 };
  if (/\bevery (?:morning|afternoon|day|evening|night|weekday)\b|\beach (?:morning|day)\b|\bdaily\b|\btomorrow'?s\b|\ba day\b|\bmy (?:whole |entire )?day is\b|\ball day\b/.test(t)) return { kind: "daily", days: /saturday|six days/.test(t) ? "1-6" : "1-5" };
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const months = MONTHS.map((m, i) => (new RegExp(`\\b(?:in|across|through|and) ${m}\\b|\\b${m} and\\b`).test(t) ? i + 1 : 0)).filter(Boolean);
  if (months.length) return { kind: "weekly", dow: 1, months };
  if (/\b(?:comes? in|come in|arrive|submit|texts? (?:us|our|at)|emails? us|when (?:a|an|the) [a-z]+ (?:calls|emails|texts|submits))\b/.test(t)) return { kind: "event", channel: /\btext/.test(t) ? "sms" : "email" };
  return null;
}

const APPROVAL_RULE =
  /\bwithout (?:me|us|[A-Z][a-z]+(?: or (?:me|[A-Z][a-z]+))?) (?:seeing|reading|reviewing|approving|signing off|looking at|checking)|\bnothing (?:goes|gets sent|leaves)\b|\b(?:reviews?|approves?|signs? off on) (?:anything|everything|every)\b|\bsign[- ]off\b|\bneeds? (?:\w+ )?approval\b|\bwant(?:s)? approval\b|\bdon'?t want (?:the agent|anything|it|you)\b|\bbefore (?:it'?s|it is|anything is) sent\b|\bwithout (?:one of )?(?:the |my |our )?[a-z]+s? (?:approving|reviewing|signing off|seeing)\b/i;

// ───────────────────────────────────────────── main ─────────────────────────────────────────────

/** `keep(text, prev, next)` drops sentences that are about some other business (e.g. examples on a podcast). */
export function readDiscovery(raw: string, keep?: (text: string, prev: string, next: string) => boolean): Discovery {
  const turns = parseTurns(raw);
  const labelled = turns.some((t) => t.speaker);
  const sentences: Sentence[] = [];
  let lastAgencyItch = false;
  let lastQuestion: string | null = null;
  let idx = 0;
  turns.forEach((t, ti) => {
    if (t.agency) {
      lastAgencyItch = ITCH_Q.test(t.text);
      lastQuestion = t.text;
      return;
    }
    const askTurn = !!lastQuestion && ASK_Q.test(lastQuestion) && (turns[ti - 1]?.agency ?? false);
    let pos = 0;
    for (const s of splitSentences(t.text)) {
      if (s.length < 3) continue;
      const asked = !!lastQuestion && (/would you want|waiting for you|wish|magic wand|if you could|what would (?:help|change)|ideal/i.test(lastQuestion) || ASK_Q.test(lastQuestion));
      const ask = (askTurn && pos < 4 && !GUARD_RE.test(s) && !APPROVAL_RULE.test(s)) || (labelled && ASK_SELF.test(s));
      sentences.push({ text: s, turn: ti, idx: idx++, speaker: t.speaker, afterItch: lastAgencyItch, question: lastQuestion, asked, ask });
      pos++;
    }
    lastAgencyItch = false;
  });
  if (keep) {
    const all = sentences.splice(0);
    all.forEach((s, i) => {
      if (keep(s.text, all[i - 1]?.text ?? "", all[i + 1]?.text ?? "")) sentences.push(s);
    });
  }
  const speakerCounts = new Map<string, number>();
  for (const t of turns) if (t.speaker && !t.agency) speakerCounts.set(t.speaker, (speakerCounts.get(t.speaker) ?? 0) + 1);
  const attOwner = /\b([A-Z][a-z]+)(?: [A-Z][a-z]+)?\s*\((?:[^)]*\b)?(?:owner|founder|ceo|president)\b/i.exec(/\b(?:attendees|participants)\s*:\s*([^\n]+)/i.exec(raw)?.[1] ?? "")?.[1];
  // "I own it", "I'm the owner": the speaker who says so, even if someone else talks more.
  const saysOwner = turns.find((t) => !t.agency && t.speaker && /\bI own (?:it|the (?:business|practice|clinic|hospital|company|firm|shop|agency))\b|\bI'?m the owner\b|\bI (?:founded|started) (?:it|the|this)\b/i.test(t.text))?.speaker ?? null;
  const owner = (attOwner && speakerCounts.has(attOwner) ? attOwner : null) ?? saysOwner ?? [...speakerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Walk the call; start topics where the owner introduces a task, attach what follows to the current topic.
  const topics: Topic[] = [];
  let current: Topic | null = null;
  let lastTurn = -1;
  let conceptSeenInTurn = false;
  const newTopic = (h: Hit, s: Sentence): Topic => ({
    action: h.action,
    phrase: h.phrase,
    qualifier: h.qualifier,
    sentences: [],
    first: s,
    hoursPerWeek: null,
    money: null,
    moneyText: null,
    score: 0,
    cadence: null,
    items: [],
    lists: [],
    systems: [],
    people: [],
    rules: [],
    leadDays: null,
  });
  const statements = new WeakMap<Topic, Array<{ hours: number; kind: HoursKind }>>();
  const bare = new WeakMap<Topic, number>();
  let turnPos = 0;
  let npTopic: Topic | null = null;
  const STOPW = new Set("that this with have from they them their what when which would could just about like then there been were will your every each into after before only also some than much many more most over under very".split(" "));
  const words = (x: string) => new Set((x.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOPW.has(w)));
  for (const s of sentences) {
    if (s.turn !== lastTurn) {
      lastTurn = s.turn;
      conceptSeenInTurn = false;
      turnPos = 0;
      npTopic = null;
      // "What goes in the close package?" — the answer belongs to the topic the question is about.
      const asked = s.question ? conceptHits(s.question).map((h) => topics.find((t) => t.action === h.action)).find((t): t is Topic => !!t) : undefined;
      if (asked) {
        current = asked;
        conceptSeenInTurn = true;
      }
    }
    const isQuestion = /\?\s*$/.test(s.text);
    const hits = isQuestion ? [] : conceptHits(s.text);
    const pain = painScore(s.text) + (s.asked ? 3 : 0);
    const intro = INTRO.test(s.text) || /,\s*hands down\b/i.test(s.text) || s.text.split(/\s+/).length <= 5;
    const listAt = s.text.search(/\s[—–-]\s|:\s/);
    const strong = labelled && STRONG_START.test(s.text) && (!hits[0] || listAt < 0 || hits[0].index < listAt);
    // A rule ("Never send a price…") or a line that only says where data lives ("Invoicing is QuickBooks Online.")
    // never starts a task of its own.
    const sysOnly = systemsIn(s.text).length > 0 && painScore(s.text) === 0 && !WANT.test(s.text) && !s.ask;
    const canStart = !(labelled && GUARD_RE.test(s.text)) && !sysOnly;
    // Answers about where data lives, hard rules or tone don't continue the last pain.
    const inventory = !!s.question && (SYSTEMS_Q.test(s.question) || /\b(?:hard rules?|never do|always do|tone|voice|sound like)\b/i.test(s.question));
    let target: Topic | null = null;
    let detached = false;
    const pos = turnPos++;
    // The speaker naming the next job in a few words ("Vaccine recalls.", "Then no-shows.").
    const prevInTurn = sentences[s.idx - 1]?.turn === s.turn ? sentences[s.idx - 1]!.text : "";
    const np =
      labelled && !isQuestion && (pos <= 1 || /^(?:the|my|our) (?:biggest|main|worst) /i.test(s.text)) && canStart && (NEXT_Q.test(s.question ?? "") || /^(?:the|my|our) (?:biggest|main|worst|other|next) /i.test(s.text) || /^(?:and|then|also|plus|oh,? and|next)\b/i.test(s.text) || /\b(?:the (?:first|second|third|fourth|next|other|last) (?:one|thing)|another one)\b/i.test(prevInTurn))
        ? nounPhraseAnswer(s.text)
        : null;
    if (np && !hits.length) {
      const t = newTopic({ action: "manual", qualifier: "", object: np.toLowerCase(), phrase: np.toLowerCase(), index: 0 }, s);
      t.label = np;
      topics.push(t);
      npTopic = t;
      attach(t, s, pain);
      current = t;
      continue;
    }
    // "The third one is mine." introduces; it belongs to no job.
    if (/^the (?:first|second|third|fourth|next|other|last) (?:one|thing) is (?:mine|hers|his|ours|this)\b/i.test(s.text)) continue;
    if (hits.length) {
      const existing = hits.map((h) => topics.find((t) => t.action === h.action)).filter((t): t is Topic => !!t);
      // A job the speaker just named in this turn ("Then claims status.") takes the task word that follows,
      // even when another job already used the same playbook ("COIs" chasing ≠ chasing the adjuster).
      const fromNp = npTopic && npTopic.action === "manual" && npTopic.first.turn === s.turn && canStart ? npTopic : null;
      if (fromNp) {
        fromNp.action = hits[0]!.action;
        fromNp.phrase = hits[0]!.phrase;
        fromNp.qualifier = hits[0]!.qualifier;
        target = fromNp;
        npTopic = null;
      } else if (current && hits.some((h) => h.action === current!.action)) target = current;
      else if (existing[0] && (!conceptSeenInTurn || intro || strong)) target = existing[0];
      else if (!conceptSeenInTurn || intro || strong) {
        // New tasks named in this sentence. Unlabelled monologues need real pain in the sentence itself.
        const fresh = canStart ? hits.filter((h) => !topics.some((t) => t.action === h.action)) : [];
        if (!canStart && !existing.length) detached = true;
        if (fresh.length && (labelled ? pain > 0 || s.afterItch || intro || strong || !conceptSeenInTurn : pain >= 1.5)) {
          // The job named just before ("Insurance claims." then "…needs the adjuster chased") is this task.
          const conv = npTopic && npTopic.action === "manual" && npTopic.first.turn === s.turn ? npTopic : null;
          fresh.forEach((h, i) => {
            if (i === 0 && conv) {
              conv.action = h.action;
              conv.phrase = h.phrase;
              conv.qualifier = h.qualifier;
            } else {
              const t = newTopic(h, s);
              if (i === 0 && np) t.label = np;
              topics.push(t);
            }
          });
          npTopic = null;
          target = topics.find((t) => t.action === fresh[0]!.action) ?? null;
          // Several tasks in one breath ("scrape catalogs and create invoices"): each gets this sentence.
          for (const h of fresh.slice(1)) attach(topics.find((t) => t.action === h.action)!, s, pain, hits.length > 1);
        } else if (existing[0]) target = existing[0];
      }
      conceptSeenInTurn = true;
    }
    // "The other thing is X." with no known task: start a topic named from the owner's own words.
    const vo = !hits.length && !isQuestion && labelled && canStart && INTRO.test(s.text) ? /\bI (reconcile|compile|prepare|update|review|file|enter|build|check|process|send out)\s+(?:the |our |all the |every )?([a-z][a-z -]{3,40}?)(?=\s+(?:against|for|to|from|into|with|by|every|each|once)\b|[.,])/i.exec(s.text) : null;
    if (vo) {
      const NOUN: Record<string, string> = { reconcile: "reconciliation", compile: "compilation", prepare: "prep", update: "updates", review: "review", file: "filing", enter: "entry", build: "build", check: "checks", process: "processing", "send out": "send-out" };
      const label = `${vo[2]!.trim().replace(/s$/, "")} ${NOUN[vo[1]!.toLowerCase()] ?? "work"}`;
      const t = newTopic({ action: "manual", qualifier: "", object: label.toLowerCase(), phrase: label.toLowerCase(), index: 0 }, s);
      t.label = label;
      topics.push(t);
      attach(t, s, pain);
      current = t;
      npTopic = t;
      continue;
    }
    if (!hits.length && !isQuestion && INTRO.test(s.text) && labelled && canStart) {
      const np = /^(?:and|also|oh,? and|plus|then|the other (?:big )?(?:thing|one)(?: that [a-z ]+)?(?: is)?|another (?:thing|one)(?: is)?|the last thing(?: is)?|lastly|finally)\s*,?\s+(?:it'?s\s+)?(?:the |our |my )?([a-z0-9][a-z0-9' -]{2,40}?)(?=[.,!]|$| is | are | in | every | that )/i.exec(s.text)?.[1];
      if (np && np.split(/\s+/).length <= 4 && !/^(?:it|that|this|them|those|we|i|they|you|no|nothing|everything|anything|yeah|so)\b/i.test(np)) {
        const t = newTopic({ action: "manual", qualifier: "", object: trimPhrase(np).toLowerCase(), phrase: trimPhrase(np).toLowerCase(), index: 0 }, s);
        topics.push(t);
        target = t;
      }
    }
    // The owner's ask with no task word ("A list of every patient overdue for rabies…") goes to the job it shares words with.
    if (!target && s.ask && !hits.length && topics.length) {
      const mine = words(s.text);
      const best = topics.map((t) => ({ t, n: [...words(t.sentences.map((x) => x.text).join(" "))].filter((w) => mine.has(w)).length })).sort((a, b) => b.n - a.n)[0];
      if (best && best.n >= 3) target = best.t;
    }
    if (!target && !detached && !(inventory && !hits.length) && !(labelled && GUARD_RE.test(s.text)) && current && (labelled ? s.turn - lastTopicTurn(current) <= 4 : s.idx - (current.sentences[current.sentences.length - 1]?.idx ?? -9) <= 1)) target = current;
    if (target) {
      attach(target, s, pain, hits.length > 1);
      current = target;
    }
  }

  // Fallback for tasks no concept covers: a pain sentence with an explicit time cost and a verb-object phrase.
  for (const s of sentences) {
    const h = hoursPerWeekIn(s.text);
    if (!h || h < 2 || topics.some((t) => t.sentences.includes(s)) || GUARD_RE.test(s.text)) continue;
    const m = /\b(?:spend(?:s|ing)?|takes?|lose|losing)\b.*?\b(?:on|doing)\s+((?:the\s+)?[a-z][a-z' -]{3,40}?)(?=[,.]| every| each| a week| per| for| because|$)|\b(?:chasing|building|writing|typing|copying|entering|checking|calling|sending|updating|filling out|putting together|pulling|preparing|scheduling|booking|ordering|processing|sorting)\s+([a-z][a-z' -]{3,40}?)(?=[,.]| every| each| a week| per| for| because| into| from|$)/i.exec(s.text);
    const phrase = trimPhrase((m?.[1] ?? m?.[2] ?? "").replace(/^the\s+/i, ""));
    if (!phrase || /^(?:it|that|this|them|those|hours?)$/i.test(phrase)) continue;
    const t = newTopic({ action: "manual", qualifier: "", object: phrase, phrase: phrase.toLowerCase(), index: 0 }, s);
    attach(t, s, painScore(s.text));
    topics.push(t);
  }

  function lastTopicTurn(t: Topic) {
    return t.sentences[t.sentences.length - 1]?.turn ?? t.first.turn;
  }
  function attach(t: Topic, s: Sentence, pain: number, shared = false) {
    if (t.sentences.includes(s)) return;
    t.sentences.push(s);
    t.score += pain + (s.afterItch ? 4 : 0);
    const hs = hoursStatement(s.text);
    if (hs) {
      const xs = statements.get(t) ?? [];
      xs.push(hs);
      statements.set(t, xs);
      t.hoursPerWeek = combineHours(xs);
    } else {
      const b = bareHoursIn(s.text);
      if (b) bare.set(t, Math.max(bare.get(t) ?? 0, b));
    }
    const mo = moneyIn(s.text);
    if (mo && mo.value >= 1000 && !APPROVAL_RULE.test(s.text) && !/\b(?:over|above|more than|under) \$/i.test(s.text) && (t.money == null || mo.value > t.money)) {
      t.money = mo.value;
      t.moneyText = s.text;
    }
    for (const sys of systemsIn(s.text)) if (!t.systems.includes(sys)) t.systems.push(sys);
    const li = shared ? [] : listItems(s.text);
    if (li.length) {
      t.lists.push({ text: s.text, items: li });
      if (!t.items.length) t.items = li;
    }
    if (APPROVAL_RULE.test(s.text) || /\b(?:over|above|more than) \$\d/i.test(s.text)) t.rules.push(s.text);
    const lead = /\b(\d+) days (?:out|before|ahead|in advance|prior|early)\b/i.exec(s.text);
    if (lead) t.leadDays = Number(lead[1]);
  }

  for (const t of topics) {
    const ctx = t.sentences.map((s) => s.text).join(" ");
    t.cadence = cadenceIn(ctx.replace(RE_HOURS_PER, " ").replace(RE_HOURS_DAILY, " ").replace(RE_DAYS_PER, " ")) ?? cadenceIn(ctx);
    // "That's three, four hours when I do it" about a Monday report: the task's cadence supplies the period.
    const b = bare.get(t);
    if (t.hoursPerWeek == null && b) {
      const c = t.cadence;
      t.hoursPerWeek = round1(c?.kind === "daily" ? b * (c.days === "1-6" ? 6 : c.days === "*" ? 7 : 5) : c?.kind === "monthly" ? b / 4.33 : b);
    }
    t.people = peopleIn(t.sentences.map((s) => s.text)).map((p) => p.name);
    if (t.hoursPerWeek) t.score += t.hoursPerWeek * 1.5;
    if (t.money) t.score += Math.log10(t.money) * 1.5;
    if (t.first.afterItch) t.score += 6;
  }
  // "Billing." then "chasing unpaid invoices": one job. Invoicing stays its own job only when it is about making invoices.
  const chaseInv = topics.find((t) => t.action === "chase" && /invoice|balance|payment|receivable|aging/.test(t.phrase));
  const inv = topics.find((t) => t.action === "invoice");
  if (chaseInv && inv && !/\b(?:send|create|build|prep|draft|make|issue|generate)\w* (?:out )?(?:the |their |our |all the )?invoices?\b|\binvoic(?:e|ing) (?:clients|customers|for)\b/i.test(inv.sentences.map((x) => x.text).join(" "))) {
    for (const x of inv.sentences) if (!chaseInv.sentences.includes(x)) chaseInv.sentences.push(x);
    chaseInv.sentences.sort((a, b) => a.idx - b.idx);
    chaseInv.first = chaseInv.sentences[0]!;
    chaseInv.score += inv.score;
    chaseInv.hoursPerWeek = Math.max(chaseInv.hoursPerWeek ?? 0, inv.hoursPerWeek ?? 0) || null;
    for (const x of inv.systems) if (!chaseInv.systems.includes(x)) chaseInv.systems.push(x);
    topics.splice(topics.indexOf(inv), 1);
  }
  // "What would a great Monday look like?" — the ask names the day it should be ready.
  for (const t of topics) {
    const a = t.sentences.find((x) => x.ask);
    const day = a && /\b(monday|tuesday|wednesday|thursday|friday)\b/i.exec(`${a.question ?? ""} ${t.sentences.filter((x) => x.ask).map((x) => x.text).join(" ")}`)?.[1];
    if (day && t.cadence?.kind !== "daily") t.cadence = { kind: "weekly", dow: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(day.toLowerCase()) };
  }
  const ranked = topics
    .filter((t) => t.score >= 2 && (t.hoursPerWeek || t.money || t.sentences.some((s) => (s.text.match(PAIN_WORDS) ?? []).length > 0 || s.asked || WANT.test(s.text)) || t.first.afterItch))
    .sort((a, b) => b.score - a.score || a.first.idx - b.first.idx);
  // What the owner asked for first, in the order they said it.
  const askTopics = ranked
    .map((t) => ({ t, at: t.sentences.find((x) => x.ask)?.idx ?? -1 }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.t);

  const allText = sentences.map((s) => s.text);
  const people = peopleIn(allText);
  const att = /\b(?:attendees|participants)\s*:\s*([^\n]+)/i.exec(raw)?.[1];
  const agencyNames = new Set(turns.filter((t) => t.agency && t.speaker).map((t) => t.speaker!.split(" ")[0]!));
  if (att) {
    for (const m of att.matchAll(/([A-Z][a-z]+)(?: [A-Z][a-z]+)?\s*\(([^)]*)\)/g)) {
      if (agencyNames.has(m[1]!)) continue;
      const role = /\b(owner|founder|ceo|president|office manager|manager|partner|bookkeeper|coordinator|accountant|admin)\b/i.exec(m[2]!)?.[1]?.toLowerCase() ?? null;
      if (role && !people.some((p) => p.name === m[1])) people.push({ name: m[1]!, role });
    }
  }
  // "(owner: Gina Moretti; office manager: Rick Alvarez)" in a header, and "Rick Alvarez handles them personally" in a rule.
  for (const m of raw.matchAll(new RegExp(`\\b(owner|founder|${ROLE_WORDS}):\\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)`, "g"))) {
    const first = m[2]!.split(" ")[0]!;
    if (agencyNames.has(first)) continue;
    const prev = people.find((p) => p.name === first || p.name === m[2]);
    if (prev) {
      prev.role ??= m[1]!.toLowerCase();
      if (prev.name === first && m[2] !== first && first !== owner) prev.name = m[2]!;
    } else if (first !== owner) people.push({ name: m[2]!, role: m[1]!.toLowerCase() });
  }
  for (const s of sentences) for (const m of s.text.matchAll(/\b([A-Z][a-z]+ [A-Z][a-z]+) (?:handles|owns|manages|takes care of) (?:them|it|that account|the account|those|that client)\b/g)) {
    const first = m[1]!.split(" ")[0]!;
    if (!people.some((p) => p.name === m[1] || p.name.split(" ")[0] === first)) people.push({ name: m[1]!, role: "handles an account personally" });
  }
  for (const sp of speakerCounts.keys()) if (!people.some((p) => p.name === sp || p.name.split(" ")[0] === sp)) people.push({ name: sp, role: null });
  if (owner && !people.some((p) => p.name === owner)) people.unshift({ name: owner, role: "owner" });
  else if (owner) people.find((p) => p.name === owner)!.role ??= "owner";
  const systems0 = [...new Set(sentences.flatMap((s) => systemsIn(s.text)))];
  // "QuickBooks" said once and "QuickBooks Online" said once are one system.
  const fuller = (x: string) => systems0.find((y) => y.startsWith(`${x} `) || y === `${x}s`) ?? x;
  const systems = [...new Set(systems0.map(fuller))];
  for (const t of topics) t.systems = [...new Set(t.systems.map(fuller))];
  const rules = [...new Set(sentences.filter((s) => APPROVAL_RULE.test(s.text) || /\b(?:over|above|more than) \$\d[\d,]*\b[^.]*\bapprov/i.test(s.text)).map((s) => s.text))];

  const joined = allText.join(" ");
  const sms = labelled
    ? /\btext(?:s|ing|ed)?\b(?! (?:file|box|field))|\bsms\b|\bweave\b|\bpodium\b/i.test(joined)
    : /\btext (?:it )?(?:to )?(?:me|us)\b|\balways text\b|\bprefer text/i.test(joined);
  const slack = labelled ? /\bslack\b/i.test(joined) : /\b(?:our|my) slack\b|\bslack me\b/i.test(joined);

  // Who gets the morning output: the answer to "who should get…" or any "email her/text me" line.
  let recipient: Discovery["recipient"] = { name: null, channel: null, by: null };
  const deliveryTurn = turns.findIndex((t, i) => t.agency && /who (?:should|gets?|wants?)|morning stuff|waiting for you|first thing in the morning|send (?:it|this) to|how do (?:you|your) .* (?:like|want) to hear/i.test(t.text) && !!turns[i + 1]);
  const deliverySents = sentences.filter((s) => (deliveryTurn >= 0 && s.turn === deliveryTurn + 1) || /\b(?:email|text|send) (?:it to )?(?:me|her|him|them)\b/i.test(s.text));
  if (deliverySents.length) {
    const txt = deliverySents.map((s) => s.text).join(" ");
    const askedAt = deliveryTurn >= 0 ? earliestMorningTime(turns[deliveryTurn]!.text) : null;
    const sendTo = /\b(?:send|email|text) (?:it |this |them )?(?:to )?([A-Z][a-z]+)\b/.exec(txt)?.[1];
    const named = people.find((p) => new RegExp(`\\b${p.name.replace(".", "\\.")}\\b`).test(txt) && p.name !== owner) ?? (sendTo && !CAP_STOP.has(sendTo) ? { name: sendTo, role: null } : undefined);
    const toMe = /\b(?:text|email|send) (?:it )?(?:to )?me\b/i.test(txt);
    recipient = {
      name: toMe ? owner : (named?.name ?? owner),
      channel: /\btext (?:it )?(?:to )?(?:me|her|him)\b/i.test(txt) ? "sms" : /\bemail (?:it )?(?:to )?(?:me|her|him)|outlook|gmail|inbox\b/i.test(txt) ? "email" : null,
      by: earliestMorningTime(txt) ?? askedAt,
    };
  }

  // "Tone?" → "Warm but short. Property managers are busy. No fluff, bullet points are fine."
  const toneTurn = turns.findIndex((t, i) => t.agency && /\b(?:tone|voice|how (?:should|do you want) (?:it|the assistant|the agent|they|we|messages) (?:to )?sound|how formal)\b/i.test(t.text) && !!turns[i + 1] && !turns[i + 1]!.agency);
  const tone = toneTurn >= 0 ? truncate(sentences.filter((s) => s.turn === toneTurn + 1).map((s) => s.text).join(" "), 220) || null : null;

  const compliance: string[] = [];
  if (/\bhipaa\b|\bphi\b|\bpatients?\b/i.test(joined)) compliance.push("hipaa");
  if (/\bssns?\b|social security|\btax returns?\b|\bbank (?:statements|accounts?)\b|\bpii\b|\bW-?2s?\b|\b1099s?\b/i.test(joined)) compliance.push("pii");
  if (/\bmanagement agreement\b|\bcontract says\b|\bper our (?:agreement|contract)\b/i.test(joined)) compliance.push("contract");

  // Facts: volumes and scale the owner stated about the business ("about 340 units for 28 owners").
  const facts = (labelled ? sentences : [])
    .filter((s) => /\b(?:we|i)(?:'re| are| manage| see| do| serve| run| have| got| employ| handle| send| file| install)\b[^.]*\b\d[\d,]*\b/i.test(s.text) && !/\$/.test(s.text) && s.text.length < 260 && !hoursPerWeekIn(s.text))
    .map((s) => s.text)
    .slice(0, 6);
  const preferences = sentences
    .filter((s) => /\b(?:i|we) (?:prefer|always|never|don'?t want|do not want|like to|want everything|need (?:it|them|everything))\b|\b(?:prefer|definitely) (?:texts?|emails?|calls?)\b|^(?:texts?|email)[,.]/i.test(s.text) && s.text.length < 300)
    // A short answer ("Texts, definitely.") only makes sense with the question it answers.
    .map((s) => (s.text.split(/\s+/).length <= 4 && s.question && /\?\s*$/.test(s.question) ? `${s.question.trim()} ${s.text}` : s.text));
  const resale =
    sentences.find((s) => /\bsell (?:this|it|that|the [\w\s-]{2,40}?) to (?:my |our |your |their )?(?:own )?(?:customers|clients|owners|members)|\bresell\b|\bpackage (?:this|it) up\b|\b(?:would )?pay (?:us )?(?:extra )?for (?:a|an|this|that)\b/i.test(s.text))?.text ?? null;

  return {
    owner,
    turns: turns.length,
    sentences,
    topics: ranked,
    people: people.slice(0, 10),
    systems,
    rules: labelled ? rules : [],
    guardrails: !labelled ? [] : [
      ...new Set(
        sentences
          .filter((s) => GUARD_RE.test(s.text) && !/\?\s*$/.test(s.text) && s.text.length < 400)
          // The reason said right after belongs to the rule ("Only Dr. Okafor or I give estimates, after an exam.").
          .map((s) => {
            let text = s.text;
            for (let k = 1; k <= 2; k++) {
              const nx = sentences[s.idx + k];
              // The reason said right after, or the next line about the same name ("Castillo Builders" → "Marco Castillo is…").
              const names = (text.match(/\b[A-Z][a-z]{3,}\b/g) ?? []).filter((w) => !/^(?:Never|Always|Only|And|Also|Don|The)$/.test(w));
              const sameName = names.some((w) => new RegExp(`\\b${w}\\b`).test(nx?.text ?? ""));
              if (!nx || nx.turn !== s.turn || (GUARD_RE.test(nx.text) && !sameName) || !(/^(?:only|their|they|that'?s|because|it'?s|he|she|his|her|everything goes)\b/i.test(nx.text) || sameName)) break;
              text = `${text} ${nx.text}`;
            }
            return { ...s, text };
          })
          // "Two. Never send…": drop the count; keep the rule whole.
          .map((s) => s.text.replace(/^(?:(?:one|two|three|first|second|third|number (?:one|two|three)|rule (?:one|two))[,:.]?\s+)/i, "")),
      ),
    ]
      // A line already folded into a longer rule is not a rule of its own.
      .filter((g, _i, all) => !all.some((o) => o !== g && o.includes(g)))
      .slice(0, 8),
    channels: { sms, slack, email: true },
    recipient,
    compliance,
    facts,
    preferences: [...new Set(preferences)].slice(0, 6),
    resale,
    vertical: null,
    askTopics,
    statedHours: round1(ranked.reduce((n, t) => n + (t.hoursPerWeek ?? 0), 0)),
    tone,
  };
}

const singular = (w: string) => w.replace(/ies$/, "y").replace(/(?<!s)s$/, "");

const TAIL_STOP = /\s+(?:and|or|but|nor|so|to|for|of|with|in|on|at|from|into|by|about|the|a|an|my|our|their|your|his|her|that|which|who|when|while|because|then|is|are|was|were|be|it|this|these|those|as|than|if|forgetting|trying|like)$/i;
/** "the last proposal and" → "the last proposal": a task name never ends on a joining word. */
export function trimPhrase(p: string): string {
  let x = normalizeWhitespace(p).replace(/[,;:—–-]+$/, "").trim();
  for (let i = 0; i < 6 && TAIL_STOP.test(x); i++) x = x.replace(TAIL_STOP, "").trim();
  return x;
}

export const quoteOf = (s: string, max = 240) => {
  const t = normalizeWhitespace(s);
  const cut = t.replace(/^(?:so|and|but|yeah|well|okay|like|honestly|oh),?\s+/i, "");
  // "And never contact…" quoted as a rule reads "Never contact…".
  return truncate(cut !== t ? cut.replace(/^[a-z]/, (c) => c.toUpperCase()) : cut, max);
};
