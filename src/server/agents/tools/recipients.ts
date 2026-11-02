/**
 * Where an outbound recipient may come from (product critique r3 C2, security critique r3 H1/H2/M4). Only:
 *  1. an exact address written in the task itself (the owner's message, a trusted follow-up's task, the workflow
 *     procedure — never the call quotes or rules pasted into it); a whole domain only when the task names it,
 *  2. the exact sender of the triggering message,
 *  3. a contact, or a knowledge row (a CSV line, an uploaded document line; never a fetched web page or the call
 *     transcript), holding the exact address next to a person or company the task names — or, for a trusted
 *     scheduled/manual workflow working through the business's own uploaded data, any such row.
 * Never from memory or rule text. Runs that handled outside content may only answer that sender.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@/server/db/client";
import { mentions, namedInTask, withoutQuotedContext } from "@/server/llm/offline/quotes";
import { normalizePhone, originOf } from "../trust";
import type { ToolContext } from "./types";

export { namedInTask, withoutQuotedContext };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

/** Every address in a text, lowercased, as whole tokens (so "n@acme.co" never matches inside "john@acme.com"). */
export function emailsIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, "")))];
}

/** Domains the text names on their own ("anyone at acme.com"), not as part of an address. */
function domainsNamed(text: string): string[] {
  const bare = text.replace(EMAIL_RE, " ");
  return [...new Set((bare.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? []).map((d) => d.toLowerCase()))];
}

/** The task in the owner's (or the procedure's) own words for this run. Outside content is never the task. */
export function taskTextOf(ctx: Pick<ToolContext, "run" | "workflow">): string {
  const input = ctx.run.input ?? {};
  const untrusted = !!originOf(ctx.run);
  const own = [input.text, untrusted ? null : input.task, input.instructions, input.title].filter((x): x is string => typeof x === "string").join("\n");
  const wf = input.kind === "message" || input.kind === "followup" || input.kind === "revision" ? "" : (ctx.workflow?.instructions ?? "");
  return withoutQuotedContext(`${own}\n${wf}`);
}

function normalizeTarget(channel: string, to: string): string | null {
  if (channel === "sms") return normalizePhone(to) || null;
  return emailsIn(to)[0] ?? null;
}

/** Runs that handled outside content: only the original sender (or the conversation's participant). */
export function untrustedRecipientProblem(ctx: ToolContext, channel: string, to: string | undefined): string | null {
  const refuse = "This run handled a message from outside the business: it may only reply to that sender (and a human approves it first).";
  const p = ctx.trust.participant;
  if (!to) return p && p.channel === channel && !p.internal ? null : refuse;
  const target = normalizeTarget(channel, to);
  if (!target) return refuse;
  if (p && p.channel === channel && (channel === "sms" ? p.phone === target : p.email === target)) return null;
  const sender = ctx.trust.sender ?? "";
  if (channel === "sms" ? (sender.match(PHONE_RE) ?? []).some((x) => normalizePhone(x) === target) : emailsIn(sender).includes(target)) return null;
  return refuse;
}

/** Is `to` a recipient this run may address? Returns null when it is, or the reason it is not. */
export async function recipientProblem(ctx: ToolContext, channel: string, to: string): Promise<string | null> {
  if (!ctx.trust.trusted) return untrustedRecipientProblem(ctx, channel, to);
  const { db, run } = ctx;
  const task = taskTextOf(ctx);
  const target = normalizeTarget(channel, to);
  if (!target) return "That recipient is not a valid address.";
  // 1. Written in the task (exactly), or its domain named on its own.
  if (channel === "sms") {
    if ((task.match(PHONE_RE) ?? []).some((p) => normalizePhone(p) === target)) return null;
  } else {
    if (emailsIn(task).includes(target)) return null;
    if (domainsNamed(task).includes(target.split("@")[1]!)) return null;
  }
  // 2. Exactly the person who sent the triggering message.
  const sender = ctx.trust.sender ?? "";
  if (channel === "sms" ? (sender.match(PHONE_RE) ?? []).some((x) => normalizePhone(x) === target) : emailsIn(sender).includes(target)) return null;
  const names = namedInTask(task);
  // A trusted scheduled/manual workflow working through the business's own uploaded data (a tracker CSV) may address
  // its rows; anything started by a message must name the person.
  const workflowRun = !!ctx.workflow && run.input?.kind !== "message" && run.input?.kind !== "followup" && run.input?.kind !== "revision" && typeof run.input?.event !== "string";
  if (!names.length && !workflowRun) return refusal(to);
  // 3a. A contact the task names.
  const contacts = await db
    .select({ name: schema.contacts.name, email: schema.contacts.email, phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, run.orgId), channel === "sms" ? sql`${schema.contacts.phone} is not null` : sql`lower(${schema.contacts.email}) = ${target}`))
    .limit(50);
  for (const c of contacts) {
    const hit = channel === "sms" ? (c.phone ? normalizePhone(c.phone) === target : false) : true;
    if (hit && c.name && mentions(c.name, names)) return null;
  }
  // 3b. A knowledge row (uploaded or typed; not the call transcript or a fetched web page) holding the exact address
  //     next to someone the task names.
  if (channel === "email") {
    const rows = await db.execute(sql`
      select c.content from knowledge_chunks c join knowledge_sources s on s.id = c.source_id
      where c.org_id = ${run.orgId} and s.org_id = ${run.orgId} and s.kind in ('text', 'file')
        and (s.agent_id is null or s.agent_id = ${ctx.agent.id}) and c.content ilike ${`%${target.replace(/[%_\\]/g, "\\$&")}%`}
      limit 10`);
    for (const r of rows.rows as Array<{ content: string }>) {
      for (const line of r.content.split(/\r?\n/)) {
        if (emailsIn(line).includes(target) && (workflowRun || mentions(line, names))) return null;
      }
    }
  }
  return refusal(to);
}

function refusal(to: string): string {
  return `I can't send to ${to}: that address isn't in the task, isn't the sender, and doesn't match a contact or a row in the knowledge base for someone the task names. Recipients never come from memory or rules — draft it for the team instead.`;
}

// ───────────────────────────── email drafts inside deliverables ─────────────────────────────

export type ParsedDraft = { to: string; name: string | null; subject: string; body: string };

/** The email drafts in a deliverable body (`**To:** Name <addr>` / `**Subject:**` / quoted body), addressed ones only. */
export function draftsIn(markdown: string): ParsedDraft[] {
  const out: ParsedDraft[] = [];
  const blocks = `\n${markdown}`.split(/\n(?=\*\*To:\*\*)/);
  for (const b of blocks.slice(1)) {
    const to = /^\*\*To:\*\*\s*(.+?)\s*$/m.exec(b)?.[1] ?? "";
    const addr = emailsIn(to)[0];
    if (!addr) continue;
    const subject = /^\*\*Subject:\*\*\s*(.+?)\s*$/m.exec(b)?.[1] ?? "";
    const quoted: string[] = [];
    let started = false;
    for (const line of b.split("\n")) {
      if (/^>/.test(line)) {
        started = true;
        quoted.push(line.replace(/^>\s?/, ""));
      } else if (started) break;
    }
    if (!quoted.length) continue;
    out.push({ to: addr, name: /^(.+?)\s*</.exec(to)?.[1]?.trim() ?? null, subject: (subject || "Following up").slice(0, 200), body: quoted.join("\n").trim() });
  }
  return out;
}

/** Every `**To:**` address in a body, addressed draft or not (a draft to an unapproved address must not even be written). */
export function draftAddressesIn(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/^\*\*To:\*\*\s*(.+?)\s*$/gm)].flatMap((m) => emailsIn(m[1] ?? "")))];
}

// ───────────────────────────── internal notes ─────────────────────────────

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9$%@.' -]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

/**
 * Does `text` share any run of 8+ words with one of `secrets` (rules, a client's private change-request note)?
 * Short secrets (under 8 words, 24+ characters) count when they appear whole. Normalized for case, punctuation and
 * spacing. A hint, not the control: approval stays the control.
 */
export function sharesNoteText(text: string, secrets: string[]): boolean {
  const t = words(text);
  if (t.length < 3) return false;
  const joined = ` ${t.join(" ")} `;
  const grams = new Set<string>();
  for (let i = 0; i + 8 <= t.length; i++) grams.add(t.slice(i, i + 8).join(" "));
  return secrets.some((s) => {
    const w = words(s);
    if (w.length < 8) return w.join(" ").length >= 24 && joined.includes(` ${w.join(" ")} `);
    for (let i = 0; i + 8 <= w.length; i++) if (grams.has(w.slice(i, i + 8).join(" "))) return true;
    return false;
  });
}

/** The agent's internal rules, the client's change-request feedback (notes and their memories). */
export async function internalNotes(db: ToolContext["db"], orgId: string, agentId: string): Promise<string[]> {
  const [rules, notes] = await Promise.all([
    db
      .select({ content: schema.memories.content })
      .from(schema.memories)
      .where(and(eq(schema.memories.orgId, orgId), eq(schema.memories.agentId, agentId), sql`${schema.memories.content} ~* '^(approval rule|hard rule|preference|feedback on)'`))
      .limit(200),
    db
      .select({ feedback: schema.deliverables.feedback })
      .from(schema.deliverables)
      .where(and(eq(schema.deliverables.orgId, orgId), eq(schema.deliverables.agentId, agentId), sql`${schema.deliverables.feedback} is not null`))
      .limit(200),
  ]);
  const inner = (c: string) => /^Feedback on “[^”]*”:\s*([\s\S]+)$/.exec(c)?.[1] ?? /“([^”]+)”/.exec(c)?.[1] ?? c.replace(/^[^:]+:\s*/, "");
  return [...rules.map((r) => inner(r.content)), ...notes.map((n) => n.feedback ?? "")].filter((x) => x.trim().length >= 24);
}

/** Does an outbound message quote internal rules or a client's private change-request note? */
export async function quotesInternalNotes(ctx: ToolContext, text: string): Promise<boolean> {
  return sharesNoteText(text, await internalNotes(ctx.db, ctx.run.orgId, ctx.agent.id));
}
