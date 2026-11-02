/**
 * Offline deterministic model ("roster-offline-1").
 *
 * Used whenever ANTHROPIC_API_KEY is unset so the product demos and tests with zero keys. It is NOT a canned
 * string: it reads the same conversation the real model would and drives the same tool-use loop —
 * knowledge_search → memory_recall → (memory_save) → (send_message) → create_deliverable → final summary —
 * composing its output from the task instructions and the tool results it actually received.
 */
import { cell, estimateTokens, keywords, normalizeWhitespace, splitSentences, truncate } from "./text";
import type { LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "./types";

export const OFFLINE_MODEL = "roster-offline-1";

type Brief = {
  kind: "workflow" | "message" | "revision" | "first_deliverable" | "followup";
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
  const title = /^# (?:Task|Message):?\s*(.+)$/m.exec(first)?.[1]?.trim() ?? "Request";
  const output = /^Output:\s*(\w+)/m.exec(first)?.[1] ?? "report";
  const sep = first.indexOf("\n---\n");
  const body = sep >= 0 ? first.slice(sep + 5).trim() : first;
  return { kind: ["workflow", "message", "revision", "first_deliverable", "followup"].includes(kind) ? kind : "message", title, output, body };
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

type Snippet = { title: string; text: string };

/** Parse knowledge_search / memory_recall JSON results back into snippets. */
function snippetsFrom(events: ToolEvent[], tool: string): Snippet[] {
  const out: Snippet[] = [];
  for (const e of events) {
    if (e.name !== tool || e.isError) continue;
    try {
      const parsed = JSON.parse(e.result) as { results?: Array<{ title?: string; content?: string; kind?: string }> };
      for (const r of parsed.results ?? []) {
        if (r.content) out.push({ title: r.title ?? r.kind ?? tool, text: r.content });
      }
    } catch {
      /* non-JSON result: ignore */
    }
  }
  return out;
}

/** Sentences from snippets that best match the task keywords. */
function relevantSentences(snippets: Snippet[], kws: string[], max: number): Array<{ text: string; source: string }> {
  const scored: Array<{ text: string; source: string; score: number; idx: number }> = [];
  let idx = 0;
  for (const s of snippets) {
    for (const sentence of splitSentences(s.text.replace(/\*\*\d+:\d+\*\*\s*·\s*/g, ""))) {
      const clean = normalizeWhitespace(sentence.replace(/\\\[[^\]]*\\\]/g, "").replace(/\[music\]/gi, ""));
      if (clean.length < 40 || clean.length > 400) continue;
      const lower = clean.toLowerCase();
      let score = 0;
      for (const k of kws) if (lower.includes(k)) score += 1;
      if (/\d/.test(clean)) score += 0.5;
      if (score > 0) scored.push({ text: clean, source: s.title, score, idx: idx++ });
    }
  }
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .filter((s) => (seen.has(s.text) ? false : (seen.add(s.text), true)))
    .slice(0, max)
    .map(({ text, source }) => ({ text, source }));
}

/** Numbered / bulleted procedure steps from workflow instructions. */
function procedureSteps(instructions: string): string[] {
  const lines = instructions
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, ""));
  if (lines.length) return lines.slice(0, 12);
  return splitSentences(instructions).slice(0, 8);
}

function composeDeliverable(brief: Brief, knowledge: Snippet[], memories: Snippet[], kws: string[]) {
  const steps = procedureSteps(brief.body);
  const findings = relevantSentences(knowledge, kws, 6);
  const prefs = memories.filter((m) => /prefer|always|never|don't|do not|wants?|likes?/i.test(m.text)).slice(0, 5);
  const facts = memories.filter((m) => !prefs.includes(m)).slice(0, 5);
  const isRevision = brief.kind === "revision";

  const lines: string[] = [];
  lines.push(`## Summary`);
  lines.push(
    `${isRevision ? "Revised" : "Prepared"} **${brief.title}** from the workflow procedure (${steps.length} steps)` +
      `${findings.length ? `, ${findings.length} relevant passages from the knowledge base` : ""}` +
      `${memories.length ? ` and ${memories.length} things I remember about how you work` : ""}. It is ready to use as-is; reply with changes and I will revise it.`,
  );
  if (isRevision) {
    const fb = /Feedback:\s*([\s\S]+?)(?:\n\n|$)/.exec(brief.body)?.[1];
    if (fb) lines.push("", `**What changed:** applied your feedback — “${truncate(normalizeWhitespace(fb), 300)}”.`);
  }
  lines.push("", "## The work", "", "| # | Step | Result |", "|---|---|---|");
  steps.forEach((s, i) => {
    const support = findings[i % Math.max(1, findings.length)];
    const result = support ? `Done — grounded in “${truncate(support.text, 120)}”` : "Done — ready for your review";
    lines.push(`| ${i + 1} | ${cell(truncate(s, 160))} | ${cell(result)} |`);
  });
  if (findings.length) {
    lines.push("", "## What I found in your materials", "");
    for (const f of findings) lines.push(`- ${truncate(f.text, 280)} _(source: ${f.source})_`);
  }
  if (facts.length || prefs.length) {
    lines.push("", "## Context I applied", "");
    for (const p of prefs) lines.push(`- Preference: ${truncate(p.text, 200)}`);
    for (const f of facts) lines.push(`- ${truncate(f.text, 200)}`);
  }
  lines.push("", "## Next", "");
  lines.push(`- I will run this again on schedule and flag anything that changed.`);
  if (kws.length) lines.push(`- Send me any files about ${kws.slice(0, 3).join(", ")} and I will fold them in.`);
  const body = lines.join("\n");
  const preview = truncate(
    `${brief.title}: ${steps.length} steps completed${findings.length ? `, grounded in ${findings.length} passages from your materials` : ""}.`,
    200,
  );
  return { title: brief.title, kind: brief.output, body, preview };
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
    const email = EMAIL_RE.exec(brief.body)?.[0];
    if (email && /\b(send|email|forward|reply)\b/i.test(brief.body) && has("send_message") && !called("send_message")) {
      return makeResponse(req, `Sending this to ${email}.`, [
        {
          name: "send_message",
          input: {
            channel: "email",
            to: email,
            subject: brief.title,
            text: `Hi,\n\n${truncate(brief.body.replace(EMAIL_RE, "").trim(), 1200)}\n\nBest,`,
          },
        },
      ]);
    }

    // 3. Produce finished work.
    const needsDeliverable = brief.kind !== "message" || wantsDocument(brief.body);
    if (needsDeliverable && has("create_deliverable") && !called("create_deliverable")) {
      const d = composeDeliverable(brief, knowledge, memories, kws);
      return makeResponse(req, "Writing it up.", [{ name: "create_deliverable", input: d }]);
    }

    // 4. Wrap up with a short, specific summary (this is the chat reply for message runs).
    const deliverable = events.find((e) => e.name === "create_deliverable" && !e.isError);
    const sent = events.find((e) => e.name === "send_message");
    const saved = events.find((e) => e.name === "memory_save" && !e.isError);
    const parts: string[] = [];
    if (deliverable) parts.push(`Done — “${brief.title}” is ready for you in the portal.`);
    if (sent) parts.push(sent.isError ? "I could not send the message." : /approval/i.test(sent.result) ? "The outgoing email is waiting for your approval." : "Message sent.");
    if (saved) parts.push(`Got it — I'll remember that ${String(saved.input.content ?? "").replace(/^I\s/, "you ")}.`);
    if (!parts.length) {
      const top = relevantSentences([...memories, ...knowledge], kws, 2);
      parts.push(
        top.length
          ? `Here's what I have on that: ${top.map((t) => truncate(t.text, 220)).join(" ")}`
          : `I don't have anything on file about that yet. Send me the details (or a document) and I'll take it from there.`,
      );
    }
    return makeResponse(req, parts.join(" "), []);
  },
};
