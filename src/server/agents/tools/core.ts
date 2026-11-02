/**
 * Core agent tools: knowledge, memory, deliverables, messaging, approvals, follow-ups.
 * Every query is scoped by ctx.run.orgId / ctx.agent.id.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { titleFromRequest } from "@/server/llm/offline";
import { normalizeWhitespace, splitSentences, truncate } from "@/server/llm/text";
import { recallMemories, searchKnowledge } from "@/server/knowledge";
import { sha256 } from "@/server/security/crypto";
import { normalizePhone, type Participant } from "../trust";
import { draftAddressesIn, quotesInternalNotes, recipientProblem, untrustedRecipientProblem } from "./recipients";
import { defineTool, ok, toolError, type ToolContext } from "./types";

const DELIVERABLE_KINDS = ["report", "document", "table", "email_draft", "message"] as const;

export const knowledgeSearch = defineTool({
  name: "knowledge_search",
  description:
    "Search this business's knowledge base (discovery call transcript, documents, catalogs, SOPs, URLs) and return the most relevant passages. Use it before writing anything factual.",
  schema: z.object({ query: z.string().min(2).max(500), limit: z.number().int().min(1).max(10).optional() }),
  async run(input, ctx) {
    const hits = await searchKnowledge(ctx.db, {
      orgId: ctx.run.orgId,
      agentId: ctx.agent.id,
      query: input.query,
      limit: input.limit ?? 5,
      // The discovery call is internal: never surface it in work done for an unverified sender.
      excludeKinds: ctx.trust.trusted ? [] : ["transcript"],
    });
    return ok({ results: hits.map((h) => ({ title: h.title, content: truncate(h.content, 1500), score: Number(h.score.toFixed(4)) })) });
  },
});

export const memoryRecall = defineTool({
  name: "memory_recall",
  description: "Recall facts, preferences, people and past episodes you have saved about this business, ranked by relevance, importance and recency.",
  schema: z.object({ query: z.string().max(500).optional(), limit: z.number().int().min(1).max(20).optional() }),
  async run(input, ctx) {
    const hits = await recallMemories(ctx.db, { orgId: ctx.run.orgId, agentId: ctx.agent.id, query: input.query, limit: input.limit ?? 8 });
    return ok({ results: hits.map((h) => ({ kind: h.kind, content: h.content, importance: h.importance })) });
  },
});

export const memorySave = defineTool({
  name: "memory_save",
  description:
    "Save something durable you learned (a fact, a preference, a person, or an episode worth remembering). Keep it to one specific sentence.",
  schema: z.object({
    content: z.string().min(3).max(500),
    kind: z.enum(["fact", "preference", "person", "episode"]).optional(),
    importance: z.number().int().min(1).max(5).optional(),
  }),
  // Payment details (bank, IBAN, routing/account numbers, "pay to" changes) are a fraud vector: never saved silently.
  approvalAction: (input) => (mentionsPaymentDetails(input.content) ? "change_payment_details" : null),
  describe: (i) => `Remember: “${truncate(i.content, 240)}”`,
  async run(input, ctx) {
    const existing = await ctx.db
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(and(eq(schema.memories.orgId, ctx.run.orgId), eq(schema.memories.agentId, ctx.agent.id), eq(schema.memories.content, input.content)))
      .limit(1);
    if (existing[0]) return ok({ saved: true, id: existing[0].id, duplicate: true });
    const [row] = await ctx.db
      .insert(schema.memories)
      .values({
        orgId: ctx.run.orgId,
        agentId: ctx.agent.id,
        kind: input.kind ?? "fact",
        content: input.content,
        importance: input.importance ?? 3,
        // Learned from an email/SMS conversation: kept out of prompts and recall until a member confirms it.
        source: memoryNeedsConfirmation(ctx) ? UNCONFIRMED_MEMORY_SOURCE : `run:${ctx.run.id}`,
      })
      .returning({ id: schema.memories.id });
    return ok({ saved: true, id: row?.id, ...(memoryNeedsConfirmation(ctx) ? { pendingConfirmation: true } : {}) });
  },
});

/** memories.source for facts learned over email/SMS that a member has not confirmed yet (see knowledge.recallMemories). */
export const UNCONFIRMED_MEMORY_SOURCE = "unconfirmed";

/** Email and SMS senders can be spoofed, so what a message-triggered run learns there is held for confirmation. */
function memoryNeedsConfirmation(ctx: ToolContext): boolean {
  if (ctx.run.input?.kind !== "message") return false;
  const channel = ctx.trust.participant?.channel;
  return channel === "email" || channel === "sms";
}

const PAYMENT_RE =
  /\b(?:iban|swift(?: code)?|bic(?: code)?|routing (?:number|no)|aba (?:number|routing)|sort code|bank (?:account|details|info(?:rmation)?|transfer|wire)|wire (?:transfer|instructions|details)|ach (?:transfer|details|payment)|remit(?:tance)? (?:to|address|details)|payment (?:details|instructions|info(?:rmation)?))\b|\b(?:pay|paid|payments?|invoices?|deposit)\b[^.\n]{0,40}\b(?:to|into) (?:account|our new account|the new account|a new account)\b|\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}\b|\baccount (?:number|no\.?|#)\D{0,6}\d{4,}/i;

/** Does this text carry bank/payment details or a change of where money goes? */
export function mentionsPaymentDetails(text: string): boolean {
  return PAYMENT_RE.test(text.slice(0, 5_000));
}

export const TITLE_MAX = 60;
const PREVIEW_MAX = 200;

export const createDeliverable = defineTool({
  name: "create_deliverable",
  description:
    "Deliver finished work to the client (it appears in their portal and is sent to their delivery channels). Body is markdown; GFM tables are allowed. Lead with the result. " +
    `The title is a short, clean name for the work (${TITLE_MAX} characters or fewer, e.g. "Kindred Bakery — spring moodboard"), never the request copied; the preview is one sentence on what is inside.`,
  schema: z.object({
    title: z.string().min(2).max(400).describe(`A short name for the work, ${TITLE_MAX} characters or fewer. Not the request itself.`),
    kind: z.enum(DELIVERABLE_KINDS).optional(),
    body: z.string().min(1).max(200_000),
    preview: z.string().max(400).optional().describe("One sentence on what is inside, for the client's inbox and portal list."),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  /** An email draft may only be addressed to someone the run could send to (checked again when it is approved). */
  async precheck(input, ctx) {
    const addresses = draftAddressesIn(input.body);
    for (const to of addresses.slice(0, 20)) {
      const problem = await recipientProblem(ctx, "email", to);
      if (problem) return `This draft is addressed to ${to}, which this run may not write to. ${problem}`;
    }
    return null;
  },
  async run(input, ctx) {
    const { db, run, agent } = ctx;
    const request = requestTextOf(run);
    const title = cleanDeliverableTitle(input.title, request);
    // Idempotent per run+title so a retried run never double-delivers (the id is derived from both).
    const id = deliverableIdFor(run.id, title);
    const dupe = await db
      .select({ id: schema.deliverables.id })
      .from(schema.deliverables)
      .where(and(eq(schema.deliverables.orgId, run.orgId), eq(schema.deliverables.runId, run.id), eq(schema.deliverables.title, title)))
      .limit(1);
    if (dupe[0]) {
      if (!ctx.state.deliverableIds.includes(dupe[0].id)) ctx.state.deliverableIds.push(dupe[0].id);
      return ok({ delivered: true, deliverableId: dupe[0].id, title, duplicate: true });
    }
    const kind = input.kind ?? (ctx.workflow?.outputKind && (DELIVERABLE_KINDS as readonly string[]).includes(ctx.workflow.outputKind) ? (ctx.workflow.outputKind as (typeof DELIVERABLE_KINDS)[number]) : "report");
    const hoursSaved = hoursCreditFor(run, ctx.workflow, ctx.state.deliverableIds.length);
    // A change request produces a new version linked to the original (never an email).
    let data = input.data ?? null;
    if (run.input?.kind === "revision" && typeof run.input.deliverableId === "string") {
      const orig = (
        await db
          .select({ id: schema.deliverables.id, data: schema.deliverables.data })
          .from(schema.deliverables)
          .where(and(eq(schema.deliverables.id, run.input.deliverableId), eq(schema.deliverables.orgId, run.orgId)))
          .limit(1)
      )[0];
      if (orig) {
        const root = typeof orig.data?.revisionOf === "string" ? orig.data.revisionOf : orig.id;
        data = { ...(data ?? {}), revisionOf: root, previousVersionId: orig.id, version: (Number(orig.data?.version) || 1) + 1 };
      }
    }
    const draft: DeliverableDraft = {
      id,
      title,
      kind,
      preview: cleanPreview(input.preview, input.body, title, request),
      body: input.body,
      data,
      // Work requested by an unverified sender is never presented as the agent's own finished output.
      needsReview: kind === "email_draft" || run.trigger === "setup" || !ctx.trust.trusted,
      hoursSaved: Number.isFinite(hoursSaved) ? hoursSaved : 0,
    };

    // Finished early (the first overnight deliverable): hand it over at the release time, not at 1 AM.
    const releaseAt = typeof run.input?.releaseAt === "string" ? new Date(run.input.releaseAt) : null;
    if (releaseAt && releaseAt.getTime() > Date.now()) {
      await enqueue(db, "deliverable.release", { orgId: run.orgId, runId: run.id, deliverable: draft }, { orgId: run.orgId, runAt: releaseAt, idempotencyKey: `release:${id}` });
      if (!ctx.state.deliverableIds.includes(id)) ctx.state.deliverableIds.push(id);
      return ok({ delivered: false, scheduled: true, deliverableId: id, title, releaseAt: releaseAt.toISOString(), note: "Saved; it will be handed to the client at the release time." });
    }
    const out = await publishDeliverable(db, { run, agent, workflow: ctx.workflow }, draft);
    if (!ctx.state.deliverableIds.includes(out.id)) ctx.state.deliverableIds.push(out.id);
    return ok({ delivered: true, deliverableId: out.id, title, channels: ["portal", ...out.channels] });
  },
});

// ───────────────────────────── deliverable titles & previews ─────────────────────────────

/** What the client asked for in their own words (chat messages and follow-ups), if anything. */
function requestTextOf(run: ToolContext["run"]): string {
  const input = run.input ?? {};
  if (input.kind === "message") return String(input.text ?? "");
  if (input.kind === "followup") return String(input.task ?? "");
  return "";
}

/** Markdown and quotes off; one line. */
function plainText(s: string): string {
  return normalizeWhitespace(s.replace(/[*_`#>]+/g, " ").replace(/<\/?untrusted_message>/gi, " ")).replace(/^["“”']+|["“”']+$/g, "").trim();
}

function comparable(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when a "title" is really the request (or a verbatim chunk of it) rather than a name for the work. */
export function titleIsPrompt(title: string, request: string): boolean {
  const t = comparable(title);
  if (!t) return true;
  if (/\?\s*$/.test(title.trim())) return true;
  if (/^(?:hey|hi|hello|can you|could you|would you|will you|please|i need|i want|i d like|i would like|we need)\b/.test(t)) return true;
  return copiesRequest(title, request);
}

/** The text is the request, its opening pasted, or nearly all of it verbatim. */
function copiesRequest(text: string, request: string): boolean {
  const t = comparable(text);
  const r = comparable(request);
  if (!t || !r) return false;
  if (t === r) return true;
  const opening = r.slice(0, 40);
  if (opening.length >= 16 && t.includes(opening)) return true;
  return r.includes(t) && t.length >= Math.max(24, r.length * 0.8);
}

/**
 * A word-boundary cut, preferring a natural break ("Q3 report: what changed" → "Q3 report"). A version marker
 * such as "(revised)" survives the cut.
 */
function shortenTitle(title: string): string {
  const suffix = /\s\((?:revised|updated|draft|v\d+)\)$/i.exec(title)?.[0] ?? "";
  const t = title.slice(0, title.length - suffix.length);
  const max = TITLE_MAX - suffix.length;
  for (const sep of [": ", " — ", " – ", " | ", " (", " - "]) {
    const i = t.indexOf(sep);
    if (i >= 12 && i <= max) return `${t.slice(0, i).trim()}${suffix}`;
  }
  let out = "";
  for (const w of t.split(" ")) {
    if ((out ? out.length + 1 : 0) + w.length > max - 1) break;
    out = out ? `${out} ${w}` : w;
  }
  return `${out ? `${out.replace(/[\s,:;—–-]+$/, "")}…` : truncate(t, max)}${suffix}`;
}

/**
 * Deliverable titles are short names for the work, ≤60 chars. A model that pastes the request as the title (or
 * writes a sentence) gets a clean title derived from the request instead.
 */
export function cleanDeliverableTitle(raw: string, request: string): string {
  let t = plainText(raw.split("\n").find((l) => l.trim()) ?? raw);
  if (titleIsPrompt(t, request)) t = titleFromRequest(request.trim() ? request : t);
  if (t.length > TITLE_MAX) t = shortenTitle(t);
  return t.length >= 2 ? t : "Deliverable";
}

function firstSentence(s: string): string {
  return truncate(splitSentences(plainText(s))[0] ?? "", PREVIEW_MAX);
}

/** First prose line of a markdown body (skips headings, tables, rules and field labels). */
function proseOf(body: string): string {
  for (const line of body.split("\n")) {
    const l = line.trim();
    if (!l || /^(?:#|\||---|```|!\[)/.test(l) || /^\*\*[^*]+:\*\*/.test(l)) continue;
    const text = l.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^>\s*/, "");
    if (/[a-z]{3}/i.test(text)) return text;
  }
  return "";
}

/** One sentence; never the request echoed back or the title repeated. Falls back to the body's first sentence. */
export function cleanPreview(raw: string | undefined, body: string, title: string, request: string): string {
  const given = raw ? firstSentence(raw) : "";
  const echo = (p: string) => !p || comparable(p) === comparable(title) || copiesRequest(p, request);
  if (!echo(given)) return given;
  const derived = firstSentence(proseOf(body));
  return derived || given || `${title} is ready.`;
}

/**
 * Hours saved are credited once per piece of real recurring work: the first new deliverable of a scheduled or
 * event-triggered workflow run, or of the setup (first overnight) run. Manual re-runs, revisions, follow-ups and
 * chat requests add 0, so "Run now" and "request changes" can't inflate the number.
 */
export function hoursCreditFor(run: ToolContext["run"], workflow: ToolContext["workflow"], deliverablesSoFar: number): number {
  if (deliverablesSoFar > 0) return 0;
  const kind = typeof run.input?.kind === "string" ? run.input.kind : "workflow";
  if (kind === "revision" || kind === "followup" || kind === "message") return 0;
  if (run.trigger === "setup") {
    const h = Number(run.input?.hoursSaved ?? 0);
    return Number.isFinite(h) && h > 0 ? h : 0;
  }
  if (run.trigger !== "schedule" && run.trigger !== "event") return 0;
  return workflow?.hoursSavedPerRun ?? 0;
}

export type DeliverableDraft = {
  id: string;
  title: string;
  kind: string;
  preview: string;
  body: string;
  data: Record<string, unknown> | null;
  needsReview: boolean;
  hoursSaved: number;
};

/** Deterministic deliverable id per (run, title): retries and staged releases converge on one row. */
export function deliverableIdFor(runId: string, title: string): string {
  const h = sha256(`deliverable|${runId}|${title}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Insert the deliverable (idempotent by id), notify the client, and send it out on the delivery channels. */
export async function publishDeliverable(
  db: ToolContext["db"],
  c: { run: ToolContext["run"]; agent: ToolContext["agent"]; workflow: ToolContext["workflow"] },
  d: DeliverableDraft,
): Promise<{ id: string; channels: string[]; duplicate: boolean }> {
  const { run, agent } = c;
  const inserted = await db
    .insert(schema.deliverables)
    .values({
      id: d.id,
      orgId: run.orgId,
      agentId: agent.id,
      runId: run.id,
      workflowId: run.workflowId,
      title: d.title,
      kind: d.kind,
      preview: d.preview,
      body: d.body,
      data: d.data,
      needsReview: d.needsReview,
      deliveredVia: ["portal"],
      hoursSaved: d.hoursSaved,
    })
    .onConflictDoNothing({ target: schema.deliverables.id })
    .returning({ id: schema.deliverables.id });
  const channels = (c.workflow?.deliverTo ?? agent.config.defaultDelivery ?? ["portal"]).filter((ch) => ch === "email" || ch === "sms" || ch === "slack");
  if (!inserted[0]) return { id: d.id, channels, duplicate: true };

  await db.insert(schema.notifications).values({
    orgId: run.orgId,
    kind: "deliverable.created",
    title: `${agent.name} delivered “${truncate(d.title, 80)}”`,
    body: d.preview,
    href: `/deliverables/${d.id}`,
  });
  for (const channel of channels) {
    await enqueue(
      db,
      "channel.deliver",
      { orgId: run.orgId, agentId: agent.id, channel, deliverableId: d.id, subject: d.title, text: `${d.preview}\n\nOpen it in your portal.` },
      { orgId: run.orgId, idempotencyKey: `deliver:${d.id}:${channel}` },
    );
  }
  return { id: d.id, channels, duplicate: false };
}

/** Does this send go back to the conversation's participant (same thread, or their own address/number/channel)? */
function isConversationTarget(input: { channel: string; to?: string }, p: Participant): boolean {
  if (!input.to) return input.channel === p.channel;
  if (input.channel === "email") return p.email !== null && input.to.trim().toLowerCase() === p.email;
  if (input.channel === "sms") return p.phone !== null && normalizePhone(input.to) === p.phone;
  if (input.channel === "slack") return p.slackChannel !== null && input.to.trim() === p.slackChannel;
  return false;
}

async function isInternalRecipient(ctx: ToolContext, to: string | undefined): Promise<boolean> {
  if (!to) return true; // channels slice resolves the org's own default recipient
  const rows = await ctx.db.execute(sql`
    select 1 from memberships m join users u on u.id = m.user_id
    where m.org_id = ${ctx.run.orgId} and lower(u.email) = lower(${to}) limit 1`);
  return rows.rows.length > 0;
}

export const sendMessage = defineTool({
  name: "send_message",
  description:
    "Send a message through a channel (email, sms, slack, portal). Without `to`, it goes to the client's own team. Messages to outside recipients may require human approval first.",
  schema: z.object({
    channel: z.enum(["email", "sms", "slack", "portal"]),
    to: z.string().max(320).optional(),
    subject: z.string().max(200).optional(),
    text: z.string().min(1).max(20_000),
  }),
  /**
   * Sends back to the person in this run's conversation are gated only when that person is outside the business.
   * Sends anywhere else are gated (send_external_<channel>; see requiresApproval), except a `to`-less send to the
   * org's own default recipient and, on runs without a conversation, email to a member of the org.
   */
  async approvalAction(input, ctx) {
    if (mentionsPaymentDetails(`${input.subject ?? ""}\n${input.text}`)) return "change_payment_details";
    // Runs driven by outside content reply only with a human's approval, whatever the agency configured.
    if (!ctx.trust.trusted) return "send_untrusted_reply";
    if (input.channel === "portal") return null;
    const action = `send_external_${input.channel}`;
    const p = ctx.trust.participant;
    if (p && isConversationTarget(input, p)) return p.internal ? null : action;
    if (!input.to) return null;
    if (ctx.run.conversationId) return action;
    if (input.channel === "email" && (await isInternalRecipient(ctx, input.to))) return null;
    return action;
  },
  /** Refused before any approval card: sends from a change request, ungrounded recipients, quoted internal notes. */
  async precheck(input, ctx) {
    if (ctx.run.input?.kind === "revision") return "A change request only revises the deliverable — nothing is sent. Deliver the new version with create_deliverable.";
    if (!ctx.trust.trusted) return untrustedRecipientProblem(ctx, input.channel, input.to);
    if (input.channel === "portal") return null;
    if (await quotesInternalNotes(ctx, `${input.subject ?? ""}\n${input.text}`)) {
      return "This message quotes an internal rule or a private note from the client. Rewrite it without them (or draft it for the team instead).";
    }
    const p = ctx.trust.participant;
    if (!input.to || (p && isConversationTarget(input, p))) return null;
    if (input.channel === "slack") return null; // Slack targets are channels in the client's own workspace
    return recipientProblem(ctx, input.channel, input.to);
  },
  describe: (i) => `Send ${i.channel}${i.to ? ` to ${i.to}` : ""}${i.subject ? `: “${truncate(i.subject, 80)}”` : ""} — ${truncate(i.text, 160)}`,
  async run(input, ctx) {
    if (ctx.state.messagesSent >= 10) return toolError("Message limit for this run reached");
    const { db, run, agent } = ctx;
    const dedupeKey = sha256(`${run.id}|${input.channel}|${input.to ?? ""}|${input.subject ?? ""}|${input.text}`).slice(0, 32);
    const existing = await db.execute(sql`
      select id from messages where org_id = ${run.orgId} and run_id = ${run.id} and meta->>'dedupeKey' = ${dedupeKey} limit 1`);
    if (existing.rows[0]) return ok({ sent: true, duplicate: true });

    // Continue the run's conversation when the channel matches; otherwise open a new outbound thread.
    let conversationId: string | null = null;
    if (run.conversationId) {
      const conv = (
        await db
          .select({ id: schema.conversations.id, channel: schema.conversations.channel })
          .from(schema.conversations)
          .where(and(eq(schema.conversations.id, run.conversationId), eq(schema.conversations.orgId, run.orgId)))
          .limit(1)
      )[0];
      if (conv && conv.channel === input.channel && !input.to) conversationId = conv.id;
    }
    if (!conversationId) {
      const [conv] = await db
        .insert(schema.conversations)
        .values({ orgId: run.orgId, agentId: agent.id, channel: input.channel, subject: input.subject ?? null, externalThreadId: null })
        .returning({ id: schema.conversations.id });
      conversationId = conv!.id;
    }
    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: run.orgId,
        conversationId,
        direction: "outbound",
        author: "agent",
        body: input.text,
        meta: { dedupeKey, to: input.to ?? null, subject: input.subject ?? null },
        deliveryStatus: input.channel === "portal" ? "delivered" : "pending",
        runId: run.id,
      })
      .returning({ id: schema.messages.id });
    await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conversationId));
    if (input.channel !== "portal") {
      await enqueue(
        db,
        "channel.deliver",
        {
          orgId: run.orgId,
          agentId: agent.id,
          channel: input.channel,
          messageId: msg!.id,
          conversationId,
          ...(input.to ? { to: input.to } : {}),
          ...(input.subject ? { subject: input.subject } : {}),
          ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
          text: input.text,
        },
        { orgId: run.orgId, idempotencyKey: `msg:${msg!.id}` },
      );
    }
    ctx.state.messagesSent++;
    return ok({ sent: true, messageId: msg!.id, channel: input.channel });
  },
});

/** Explicit approval request. The runtime pauses the run; on approval the model is told and continues. */
export const requestApproval = defineTool({
  name: "request_approval",
  description:
    "Ask a human to approve a risky action before you take it (spending money, changing records in a client system, anything irreversible). The run pauses until they decide.",
  schema: z.object({
    action: z.string().min(2).max(80),
    description: z.string().min(5).max(1000),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  approvalAction: (input) => `request:${input.action}`,
  describe: (i) => i.description,
  async run(input) {
    // Only reached after a human approved (the runtime gates every call to this tool).
    return ok({ approved: true, action: input.action });
  },
});

export const scheduleFollowup = defineTool({
  name: "schedule_followup",
  description: "Schedule yourself to do a task later (e.g. check for a reply in 2 days). Provide an ISO-8601 time or a delay in hours.",
  schema: z.object({
    task: z.string().min(5).max(2000),
    at: z.string().datetime({ offset: true }).optional(),
    inHours: z.number().min(0.25).max(24 * 30).optional(),
  }),
  async run(input, ctx) {
    if (ctx.state.followups >= 3) return toolError("At most 3 follow-ups per run");
    const when = input.at ? new Date(input.at) : new Date(Date.now() + (input.inHours ?? 24) * 3600_000);
    const max = Date.now() + 30 * 24 * 3600_000;
    if (!(when.getTime() > Date.now()) || when.getTime() > max) return toolError("Follow-up time must be in the next 30 days");
    // Idempotent per tool call (a resumed run must not schedule the same follow-up twice).
    const prior = (
      await ctx.db.execute(sql`
        select id, input->>'at' as at from runs where org_id = ${ctx.run.orgId} and input->>'parentRunId' = ${ctx.run.id} and input->>'parentToolUseId' = ${ctx.toolUseId} limit 1`)
    ).rows[0] as { id: string; at: string | null } | undefined;
    if (prior) return ok({ scheduled: true, runId: prior.id, at: prior.at ?? when.toISOString(), duplicate: true });
    const runId = randomUUID();
    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.runs).values({
        id: runId,
        orgId: ctx.run.orgId,
        agentId: ctx.agent.id,
        workflowId: ctx.run.workflowId,
        conversationId: ctx.run.conversationId,
        trigger: "schedule",
        status: "queued",
        input: {
          kind: "followup",
          task: input.task,
          parentRunId: ctx.run.id,
          parentToolUseId: ctx.toolUseId,
          at: when.toISOString(),
          // Trust never launders through a follow-up: one scheduled from outside content stays untrusted.
          ...(untrustedOrigin(ctx) ? { origin: untrustedOrigin(ctx) } : {}),
        },
      });
      await enqueue(tx, "agent.run", { orgId: ctx.run.orgId, runId }, { orgId: ctx.run.orgId, runAt: when, idempotencyKey: `followup:${ctx.run.id}:${ctx.toolUseId}` });
    });
    ctx.state.followups++;
    return ok({ scheduled: true, runId, at: when.toISOString() });
  },
});

/** The origin a run hands down to anything it schedules, when it handled outside content. */
function untrustedOrigin(ctx: ToolContext): Record<string, unknown> | null {
  const inherited = ctx.run.input?.origin as Record<string, unknown> | undefined;
  if (inherited?.untrusted === true) return inherited;
  if (ctx.trust.trusted) return null;
  const payload = (ctx.run.input?.eventPayload ?? {}) as Record<string, unknown>;
  return {
    untrusted: true,
    reason: ctx.trust.reason,
    sender: ctx.trust.sender,
    conversationId: ctx.run.conversationId ?? (typeof payload.conversationId === "string" ? payload.conversationId : null),
    messageId: typeof ctx.run.input?.messageId === "string" ? ctx.run.input.messageId : typeof payload.messageId === "string" ? payload.messageId : null,
  };
}
