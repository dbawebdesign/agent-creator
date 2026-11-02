/**
 * Offline deterministic model ("roster-offline-1").
 *
 * Used whenever ANTHROPIC_API_KEY is unset so the product demos and tests with zero keys. It is NOT a canned
 * string: it reads the same conversation the real model would and drives the same tool-use loop —
 * knowledge_search → memory_recall → (memory_save) → (send_message) → create_deliverable → final summary —
 * composing its output from the task instructions and the tool results it actually received.
 */
import { answerQuestion, compose, emailFromInstruction, whoAmI } from "./offline/compose";
import { withoutQuotedContext } from "./offline/quotes";
import { estimateTokens, keywords, normalizeWhitespace, splitSentences, STOPWORDS, tokenize, truncate } from "./text";
import type { LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "./types";

export const OFFLINE_MODEL = "roster-offline-1";

type Brief = {
  kind: "workflow" | "message" | "revision" | "first_deliverable" | "followup" | "task";
  title: string;
  output: string;
  body: string;
};

type ToolEvent = { name: string; input: Record<string, unknown>; result: string; isError: boolean };

function contentText(content: LlmMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_result") {
        const c = b.content;
        if (typeof c === "string") return c;
        return (c ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
      }
      return "";
    })
    .join("\n");
}

/** Parse the runtime's task brief (see agents/runtime.ts `buildBrief`). */
export function parseBrief(first: string): Brief {
  const kind = (/^Kind:\s*(\w+)/m.exec(first)?.[1] ?? "message") as Brief["kind"];
  const output = /^Output:\s*(\w+)/m.exec(first)?.[1] ?? "report";
  const sep = first.indexOf("\n---\n");
  // An unverified sender's text arrives fenced; the fence is markup for the model, not part of the request.
  const body = (sep >= 0 ? first.slice(sep + 5) : first).replace(/^\s*<\/?untrusted_message>\s*$/gim, "").trim();
  // Messages carry no title in the header (it would be the raw request): name the work from the request itself.
  const title = /^# (?:Task|Message):[ \t]*(.+)$/m.exec(first)?.[1]?.trim() ?? (kind === "message" ? titleFromRequest(body) : "Request");
  return { kind: ["workflow", "message", "revision", "first_deliverable", "followup", "task"].includes(kind) ? kind : "message", title, output, body };
}

function collectToolEvents(messages: LlmMessage[]): ToolEvent[] {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const events: ToolEvent[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") calls.set(b.id, { name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      if (b.type === "tool_result") {
        const call = calls.get(b.tool_use_id);
        if (!call) continue;
        const c = b.content;
        const result = typeof c === "string" ? c : (c ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
        events.push({ name: call.name, input: call.input, result, isError: b.is_error === true });
      }
    }
  }
  return events;
}

/** The title create_deliverable actually used (it may clean up the one asked for). */
function deliveredTitle(e: ToolEvent): string | null {
  try {
    const t = (JSON.parse(e.result) as { title?: unknown }).title;
    if (typeof t === "string" && t) return t;
  } catch {
    // not JSON: fall through
  }
  return typeof e.input.title === "string" ? e.input.title : null;
}

type Snippet = { title: string; text: string; kind?: string };

/** Parse knowledge_search / memory_recall JSON results back into snippets. */
function snippetsFrom(events: ToolEvent[], tool: string): Snippet[] {
  const out: Snippet[] = [];
  for (const e of events) {
    if (e.name !== tool || e.isError) continue;
    try {
      const parsed = JSON.parse(e.result) as { results?: Array<{ title?: string; content?: string; kind?: string }> };
      for (const r of parsed.results ?? []) {
        if (r.content) out.push({ title: r.title ?? r.kind ?? tool, text: r.content, kind: r.kind });
      }
    } catch {
      /* non-JSON result: ignore */
    }
  }
  return out;
}

/** Strip transcript/markdown noise: headings, timestamps, speaker labels, stage directions. */
function cleanSnippetText(text: string): string {
  return text
    .replace(/^[^“\n]{3,60}:\s*“([\s\S]*)”\s*$/, "$1")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/\*\*\d{1,2}:\d{2}(?::\d{2})?\*\*\s*·?/g, "\n")
    .replace(/(^|\n)\s*[A-Z][A-Za-z.'-]{1,20}(?: [A-Z][A-Za-z.'-]{1,20})?:\s+/g, "$1")
    .replace(/\\\[[^\]]*\\\]/g, " ")
    .replace(/\[(?:music|laughter|applause)\]/gi, " ");
}

type Sentence = { text: string; source: string; idx: number };

const sentenceKey = (t: string) => t.toLowerCase().replace(/\b(\w+) \1\b/g, "$1").replace(/[^a-z0-9]/g, "");

function sentencesOf(snippets: Snippet[]): Sentence[] {
  const out: Sentence[] = [];
  const seen = new Set<string>();
  let idx = 0;
  for (const s of snippets) {
    for (const sentence of splitSentences(cleanSnippetText(s.text))) {
      const clean = normalizeWhitespace(sentence);
      // Dedupe across transcript chunks and memories that quote them (ignoring stutters like "I I").
      const key = sentenceKey(clean);
      if (clean.length < 30 || clean.length > 400 || seen.has(key)) continue;
      seen.add(key);
      out.push({ text: clean, source: s.title, idx: idx++ });
    }
  }
  return out;
}

/**
 * Sentences that best match a set of keywords, IDF-weighted so rare, specific words ("quotes", "catalogs") count
 * far more than common ones ("call", "business"). Questions are skipped (usually the interviewer).
 */
/** Words that describe the *instructions* rather than the business; useless for grounding. */
const INSTRUCTION_WORDS = new Set(
  (
    "build write list deliver document documents today date lead page kinds kind requests request described exact still fill real three each " +
    "sample samples ready template markdown intro options terms checklist data call calls draft drafts drafted create include using based " +
    "short clear table tables format line items item step steps first next send save time week weekly morning report reports summary placeholder " +
    "titled title quote-ready best good better new open specific details detail need needed"
  ).split(/\s+/),
);

function bestMatches(pool: Sentence[], rawKws: string[], max: number, exclude: Set<string> = new Set(), minScore = 1.2): Sentence[] {
  const kws = [...new Set(rawKws.filter((k) => !INSTRUCTION_WORDS.has(k)))];
  if (!kws.length || !pool.length) return [];
  const n = pool.length;
  const lowered = pool.map((s) => s.text.toLowerCase());
  const res = new Map(kws.map((k) => [k, new RegExp(`\\b${k.replace(/[^a-z0-9]/g, "")}`)]));
  const idf = new Map(kws.map((k) => [k, Math.log((n + 1) / (1 + lowered.filter((t) => res.get(k)!.test(t)).length))]));
  // Small pools cap IDF low; scale the bar so a sentence holding the rarest term can still qualify.
  const bar = Math.min(minScore, 0.75 * Math.log((n + 1) / 2));
  return pool
    .map((s, i) => ({ s, lower: lowered[i]! }))
    .filter(({ s }) => !exclude.has(s.text) && !/\?\s*$/.test(s.text))
    .map(({ s, lower }) => {
      let score = 0;
      for (const k of kws) if (res.get(k)!.test(lower)) score += idf.get(k) ?? 0;
      if (score > 0 && /\d/.test(s.text)) score += 0.3;
      return { s, score };
    })
    .filter((x) => x.score > 0 && x.score >= bar)
    .sort((a, b) => b.score - a.score || a.s.idx - b.s.idx)
    .slice(0, max)
    .map((x) => x.s);
}

/** A short, clean title for work asked for in a message ("can you pull together a quick moodboard for Kindred Bakery…"). */
export function titleFromRequest(text: string): string {
  let t = normalizeWhitespace(text.split(/\n/)[0] ?? text).replace(/[?!.]+$/, "");
  t = t
    .replace(/^(?:hey|hi|hello)\b[^,]*,\s*/i, "")
    .replace(/^(?:can|could|would|will) you(?: please)?\s+|^please\s+|^i (?:need|want|would like) (?:you to\s+)?|^we need\s+/i, "")
    .replace(/^(?:pull|put|throw) together\s+|^(?:draft|write|make|create|prepare|build|give me|send me|get me|do|come up with|summari[sz]e|list)\s+(?:me\s+)?/i, "")
    .replace(/^(?:a|an|the|some|our|my)\s+/i, "")
    .replace(/^(?:quick|short|brief|rough|simple|little|first)\s+(?:pass at\s+)?/i, "")
    .replace(/^(?:a|an|the)\s+/i, "");
  // "moodboard direction for Kindred Bakery's spring launch" → "Kindred Bakery — moodboard direction (spring launch)".
  const forName = /\s+for\s+((?:[A-Z][\w&'-]*\s?){1,4}?)(?:'s\s+(.+))?$/.exec(t);
  if (forName) {
    const name = forName[1]!.trim().replace(/'s$/, "");
    const rest = t.slice(0, forName.index).trim();
    t = `${name} — ${forName[2] ? `${forName[2]} ` : ""}${rest}`;
  }
  t = t.replace(/\s+(?:by|before) (?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|eod|end of day).*$/i, "");
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return truncate(t, 60) || "Request";
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

function wantsDocument(text: string): boolean {
  return /\b(draft|write|create|prepare|build|put together|make me|summari[sz]e|report|document|table|list of)\b/i.test(text);
}

function rememberRequest(text: string): string | null {
  const m = /\b(?:remember|note|keep in mind)(?: that)?[:,]?\s+(.{8,400})/i.exec(text);
  return m?.[1] ? normalizeWhitespace(m[1]).replace(/[.!]+$/, "") : null;
}

function makeResponse(req: LlmRequest, text: string, calls: Array<{ name: string; input: Record<string, unknown> }>): LlmResponse {
  const turn = req.messages.filter((m) => m.role === "assistant").length;
  const toolCalls: LlmToolCall[] = calls.map((c, i) => ({ id: `toolu_offline_${turn}_${i}`, name: c.name, input: c.input }));
  const assistantContent: LlmContent[] = [];
  if (text) assistantContent.push({ type: "text", text });
  for (const c of toolCalls) assistantContent.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  const inputChars = req.system.length + req.messages.reduce((n, m) => n + contentText(m.content).length, 0) + JSON.stringify(req.tools).length;
  return {
    model: OFFLINE_MODEL,
    stopReason: toolCalls.length ? "tool_use" : "end_turn",
    text,
    toolCalls,
    assistantContent,
    usage: {
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: estimateTokens(text + JSON.stringify(calls)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

export const offlineProvider: LlmProvider = {
  id: "offline",
  async chat(req: LlmRequest): Promise<LlmResponse> {
    const first = req.messages[0];
    const brief = parseBrief(first ? contentText(first.content) : "");
    const has = (name: string) => req.tools.some((t) => t.name === name);
    const events = collectToolEvents(req.messages);
    const called = (name: string) => events.some((e) => e.name === name);
    const kws = keywords(`${brief.title} ${brief.title} ${brief.body}`, 8);
    const query = kws.join(" ") || brief.title;

    // 1. Ground in the knowledge base and memory first.
    const gather: Array<{ name: string; input: Record<string, unknown> }> = [];
    if (has("knowledge_search") && !called("knowledge_search")) gather.push({ name: "knowledge_search", input: { query, limit: 5 } });
    if (has("memory_recall") && !called("memory_recall")) gather.push({ name: "memory_recall", input: { query, limit: 6 } });
    if (gather.length) return makeResponse(req, "Let me pull up what I know about this first.", gather);

    const knowledge = snippetsFrom(events, "knowledge_search");
    const memories = snippetsFrom(events, "memory_recall");

    // 2. Act on explicit requests in the brief.
    const toRemember = brief.kind === "message" ? rememberRequest(brief.body) : null;
    if (toRemember && has("memory_save") && !called("memory_save")) {
      const kind = /prefer|always|never|don't|do not|like/i.test(toRemember) ? "preference" : "fact";
      return makeResponse(req, "Noted — saving that.", [{ name: "memory_save", input: { content: toRemember, kind, importance: 4 } }]);
    }
    // Only the owner's own words count as a send instruction: never event data (an inbound email etc.), never the
    // call quotes and rules pasted into a procedure, and never a change request (it only revises the deliverable).
    const ownWords = withoutQuotedContext(brief.body.split(/\n\s*\nTriggered by /)[0] ?? brief.body);
    const email = brief.kind === "revision" ? undefined : EMAIL_RE.exec(ownWords)?.[0];
    if (email && /\b(send|email|forward|reply)\b/i.test(ownWords) && has("send_message") && !called("send_message")) {
      return makeResponse(req, `Sending this to ${email}.`, [
        {
          name: "send_message",
          input: (() => {
            const e = emailFromInstruction(ownWords, whoAmI(req.system), email, titleFromRequest(ownWords));
            return { channel: "email", to: email, subject: e.subject, text: e.body };
          })(),
        },
      ]);
    }

    // 3. Produce finished work.
    const needsDeliverable = brief.kind !== "message" || wantsDocument(brief.body);
    if (needsDeliverable && has("create_deliverable") && !called("create_deliverable")) {
      const title = brief.title;
      const { trace, ...d } = compose({ kind: brief.kind, title, output: brief.kind === "message" ? (/\b(?:email|letter|reply)\b/i.test(brief.body) ? "email_draft" : "document") : brief.output, body: brief.body, system: req.system, knowledge, memories });
      // The step trace goes in this turn's text (run_steps → agency Activity view), not in the client's deliverable.
      return makeResponse(req, trace ? `Writing it up. How I put this together:\n${trace}` : "Writing it up.", [{ name: "create_deliverable", input: d }]);
    }

    // 4. Wrap up with a short, specific summary (this is the chat reply for message runs).
    const deliverable = events.find((e) => e.name === "create_deliverable" && !e.isError);
    const sent = events.find((e) => e.name === "send_message");
    const saved = events.find((e) => e.name === "memory_save" && !e.isError);
    const parts: string[] = [];
    if (deliverable) parts.push(`Done — “${deliveredTitle(deliverable) ?? brief.title}” is ready for you in the portal.`);
    if (sent) parts.push(sent.isError ? "I could not send the message." : /approval/i.test(sent.result) ? "The outgoing email is waiting for your approval." : "Message sent.");
    if (saved) parts.push(`Got it — I'll remember that ${String(saved.input.content ?? "").replace(/^I\s/, "you ")}.`);
    // A direct question the data answers ("what was Bayside's score?") gets the answer, not a paraphrase.
    const answers = brief.kind === "message" && !deliverable ? answerQuestion(brief.body, knowledge) : [];
    if (answers.length) parts.push(answers.length === 1 ? `${answers[0]}.` : `From your data: ${answers.join("; ")}.`);
    if (!parts.length) {
      const top = bestMatches(sentencesOf([...memories, ...knowledge]), kws, 2);
      parts.push(
        top.length
          ? `Here's what I have on that: ${top.map((t) => truncate(t.text, 220)).join(" ")}`
          : `I don't have anything on file about that yet. Send me the details (or a document) and I'll take it from there.`,
      );
    }
    return makeResponse(req, parts.join(" "), []);
  },
};
