/**
 * Where an outbound recipient may come from (product critique r3, C2). Only:
 *  1. an explicit address in the task itself (the owner's message, a follow-up's task, the workflow procedure —
 *     never the call quotes or rules pasted into it),
 *  2. the sender of the triggering message,
 *  3. a contact or a knowledge row (a CSV line, a document line) matched to a person or company the task names
 *     — or, for a scheduled/event workflow working through its data, any knowledge row holding the address.
 * Never from memory or rule text: "St. Luke's only via Greg Haines" is a rule, not an instruction to email Greg.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@/server/db/client";
import { mentions, namedInTask, withoutQuotedContext } from "@/server/llm/offline/quotes";
import { normalizeWhitespace } from "@/server/llm/text";
import { normalizePhone } from "../trust";
import type { ToolContext } from "./types";

export { namedInTask, withoutQuotedContext };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The task in the owner's (or the procedure's) own words for this run. */
export function taskTextOf(ctx: Pick<ToolContext, "run" | "workflow">): string {
  const input = ctx.run.input ?? {};
  const own = [input.text, input.task, input.instructions, input.title].filter((x): x is string => typeof x === "string").join("\n");
  const wf = input.kind === "message" || input.kind === "followup" || input.kind === "revision" ? "" : (ctx.workflow?.instructions ?? "");
  return withoutQuotedContext(`${own}\n${wf}`);
}

/** Is `to` a recipient this run may address? Returns null when it is, or the reason it is not. */
export async function recipientProblem(ctx: ToolContext, channel: string, to: string): Promise<string | null> {
  const { db, run } = ctx;
  const task = taskTextOf(ctx);
  const target = channel === "sms" ? normalizePhone(to) : (to.match(EMAIL_RE)?.[0] ?? to).trim().toLowerCase();
  if (!target) return "That recipient is not a valid address.";
  // 1. Written in the task.
  if (channel === "sms" ? (task.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []).some((p) => normalizePhone(p) === target) : task.toLowerCase().includes(target)) return null;
  // 2. The person who sent the triggering message.
  if (ctx.trust.sender && normalizeWhitespace(ctx.trust.sender).toLowerCase().includes(target)) return null;
  const names = namedInTask(task);
  const workflowRun = run.input?.kind !== "message" && run.input?.kind !== "followup" && run.input?.kind !== "revision" && !!ctx.workflow;
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
  // 3b. A knowledge row (not the call transcript) that holds the address next to someone the task names.
  if (channel === "email") {
    const rows = await db.execute(sql`
      select c.content from knowledge_chunks c join knowledge_sources s on s.id = c.source_id
      where c.org_id = ${run.orgId} and s.org_id = ${run.orgId} and s.kind <> 'transcript'
        and (s.agent_id is null or s.agent_id = ${ctx.agent.id}) and c.content ilike ${`%${target.replace(/[%_\\]/g, "\\$&")}%`}
      limit 10`);
    for (const r of rows.rows as Array<{ content: string }>) {
      for (const line of r.content.split(/\r?\n/)) {
        if (!line.toLowerCase().includes(target)) continue;
        if (workflowRun || mentions(line, names)) return null;
      }
    }
  }
  return `I can't send to ${to}: that address isn't in the task, isn't the sender, and doesn't match a contact or a row in the knowledge base for someone the task names. Recipients never come from memory or rules — draft it for the team instead.`;
}

/** Does an outbound message quote internal rules or a client's private change-request note? */
export async function quotesInternalNotes(ctx: ToolContext, text: string): Promise<boolean> {
  const out = normalizeWhitespace(text).toLowerCase();
  if (out.length < 20) return false;
  const rules = await ctx.db
    .select({ content: schema.memories.content })
    .from(schema.memories)
    .where(and(eq(schema.memories.orgId, ctx.run.orgId), eq(schema.memories.agentId, ctx.agent.id), sql`${schema.memories.content} ~* '^(approval rule|hard rule|preference)'`))
    .limit(100);
  const notes = await ctx.db
    .select({ feedback: schema.deliverables.feedback })
    .from(schema.deliverables)
    .where(and(eq(schema.deliverables.orgId, ctx.run.orgId), eq(schema.deliverables.agentId, ctx.agent.id), sql`${schema.deliverables.feedback} is not null`))
    .limit(100);
  const inner = [...rules.map((r) => /“([^”]+)”/.exec(r.content)?.[1] ?? r.content.replace(/^[^:]+:\s*/, "")), ...notes.map((n) => n.feedback ?? "")];
  return inner.some((t) => {
    const n = normalizeWhitespace(t).toLowerCase();
    if (n.length < 24) return false;
    return out.includes(n.slice(0, 48));
  });
}
