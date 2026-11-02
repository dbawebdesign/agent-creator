/**
 * Public API v1 operations. Shared by the REST routes (/api/v1/...) and the MCP server (/api/mcp).
 *
 * Every query is scoped by the key's org (and pinned agent, when set). Anything outside that scope is a 404 —
 * existence is never leaked. Token usage / cost is never returned.
 */
import "server-only";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { rateLimit } from "@/server/security/rate-limit";
import * as engine from "@/server/services/engine";
import { ApiError, decodeCursor, encodeCursor, listQuery, parseWith } from "./http";
import type { ApiPrincipal } from "./keys";
import { emailDomainFor } from "@/server/channels/domains";

/** Translate engine errors (matched by name so a mocked engine works too) into public API errors. */
async function engineCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "EngineNotFoundError") throw new ApiError("not_found", "Not found.");
    if (name === "EngineInputError") throw new ApiError("invalid_request", (err as Error).message.slice(0, 300));
    throw err;
  }
}

/**
 * Work-starting calls (LLM spend) get their own, tighter per-key budget on top of the general request limit,
 * shared by REST and MCP.
 */
export const INVOKE_LIMIT_PER_MIN = 20;
async function chargeInvoke(p: ApiPrincipal) {
  const rl = await rateLimit(`api:invoke:${p.keyId}`, INVOKE_LIMIT_PER_MIN, 60);
  if (!rl.ok) {
    throw new ApiError("rate_limited", `Too many agent requests (max ${INVOKE_LIMIT_PER_MIN}/min per key). Retry shortly.`, undefined, {
      "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))),
    });
  }
}

const VISIBLE_AGENT_STATUSES = ["provisioning", "active", "paused"] as const;

type AgentRow = typeof schema.agents.$inferSelect;
type DeliverableRow = typeof schema.deliverables.$inferSelect;

export type ApiAgent = {
  id: string;
  name: string;
  role: string;
  summary: string | null;
  status: AgentRow["status"];
  email: string | null;
  phone: string | null;
  createdAt: string;
};

export type ApiWorkflow = {
  id: string;
  name: string;
  trigger: "schedule" | "event" | "manual";
  outputKind: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

export type ApiDeliverable = {
  id: string;
  agentId: string;
  workflowId: string | null;
  title: string;
  kind: string;
  preview: string | null;
  body: string;
  data: Record<string, unknown> | null;
  status: DeliverableRow["status"];
  needsReview: boolean;
  deliveredVia: string[];
  hoursSaved: number;
  createdAt: string;
  portalUrl: string;
};

/** `domain` from emailDomainFor(p.orgId): the org's verified white-label domain, else env EMAIL_DOMAIN. */
export function agentEmail(handle: string | null, domain: string = env().EMAIL_DOMAIN): string | null {
  return handle ? `${handle}@${domain}` : null;
}

function serializeAgent(a: AgentRow, domain?: string): ApiAgent {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    summary: a.summary,
    status: a.status,
    email: agentEmail(a.emailHandle, domain),
    phone: a.phoneNumber,
    createdAt: a.createdAt.toISOString(),
  };
}

function serializeWorkflow(w: typeof schema.workflows.$inferSelect): ApiWorkflow {
  return {
    id: w.id,
    name: w.name,
    trigger: w.trigger.type,
    outputKind: w.outputKind,
    enabled: w.enabled,
    nextRunAt: w.nextRunAt?.toISOString() ?? null,
    lastRunAt: w.lastRunAt?.toISOString() ?? null,
  };
}

export function portalDeliverableUrl(orgSlug: string, deliverableId: string): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/p/${encodeURIComponent(orgSlug)}/d/${deliverableId}`;
}

function serializeDeliverable(d: DeliverableRow, orgSlug: string): ApiDeliverable {
  return {
    id: d.id,
    agentId: d.agentId,
    workflowId: d.workflowId,
    title: d.title,
    kind: d.kind,
    preview: d.preview,
    body: d.body,
    data: d.data ?? null,
    status: d.status,
    needsReview: d.needsReview,
    deliveredVia: d.deliveredVia,
    hoursSaved: d.hoursSaved,
    createdAt: d.createdAt.toISOString(),
    portalUrl: portalDeliverableUrl(orgSlug, d.id),
  };
}

/*
 * Keyset pagination: `order by created_at desc, id desc` with a row cursor `(created_at, id) < ($t, $id)`.
 * The cursor carries created_at at full microsecond precision as text straight from Postgres (a JS Date would
 * truncate to milliseconds and skip or repeat rows), and the bare column comparison lets the planner walk
 * (org_id, created_at, id) backward: page N costs the same as page 1 (deliverables_org_created_id_idx).
 */
type CreatedCol = typeof schema.agents.createdAt | typeof schema.deliverables.createdAt;
type IdCol = typeof schema.agents.id | typeof schema.deliverables.id;

/** created_at as an exact UTC ISO string with microseconds, for the cursor. */
function cursorTs(col: CreatedCol) {
  return sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function afterCursor(col: CreatedCol, idCol: IdCol, raw: string | undefined): SQL | undefined {
  const c = decodeCursor(raw);
  if (!c) return undefined;
  return sql`(${col}, ${idCol}) < (${c.t}::timestamptz, ${c.id}::uuid)`;
}

function page<T extends { id: string }, O>(rows: Array<{ row: T; ts: string }>, limit: number, map: (r: T) => O) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { data: items.map((r) => map(r.row)), nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.row.id }) : null, hasMore };
}

function agentScope(p: ApiPrincipal): SQL {
  const conds: SQL[] = [eq(schema.agents.orgId, p.orgId), inArray(schema.agents.status, [...VISIBLE_AGENT_STATUSES])];
  if (p.agentId) conds.push(eq(schema.agents.id, p.agentId));
  return and(...conds)!;
}

/** Load an agent visible to this key, or 404. */
export async function loadAgent(p: ApiPrincipal, agentId: string): Promise<AgentRow> {
  const [a] = await db()
    .select()
    .from(schema.agents)
    .where(and(agentScope(p), eq(schema.agents.id, agentId)))
    .limit(1);
  if (!a) throw new ApiError("not_found", "Agent not found.");
  return a;
}

export async function listAgents(p: ApiPrincipal, query: unknown) {
  const q = parseWith(listQuery, query);
  const rows = await db()
    .select({ row: schema.agents, ts: cursorTs(schema.agents.createdAt) })
    .from(schema.agents)
    .where(and(agentScope(p), afterCursor(schema.agents.createdAt, schema.agents.id, q.cursor)))
    .orderBy(desc(schema.agents.createdAt), desc(schema.agents.id))
    .limit(q.limit + 1);
  const domain = await emailDomainFor(p.orgId);
  return page(rows, q.limit, (a) => serializeAgent(a, domain));
}

export async function getAgent(p: ApiPrincipal, agentId: string): Promise<ApiAgent & { workflows: ApiWorkflow[] }> {
  const a = await loadAgent(p, agentId);
  const wfs = await db()
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.orgId, p.orgId), eq(schema.workflows.agentId, a.id)))
    .orderBy(schema.workflows.createdAt);
  return { ...serializeAgent(a, await emailDomainFor(p.orgId)), workflows: wfs.map(serializeWorkflow) };
}

/** Workflows for several agents in one query (MCP list_agents). */
export async function workflowsFor(p: ApiPrincipal, agentIds: string[]): Promise<Map<string, ApiWorkflow[]>> {
  const out = new Map<string, ApiWorkflow[]>();
  if (!agentIds.length) return out;
  const wfs = await db()
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.orgId, p.orgId), inArray(schema.workflows.agentId, agentIds)))
    .orderBy(schema.workflows.createdAt);
  for (const w of wfs) {
    const list = out.get(w.agentId) ?? [];
    list.push(serializeWorkflow(w));
    out.set(w.agentId, list);
  }
  return out;
}

/** `text` (canonical) or `message` (alias, as in MCP's ask_agent); `conversation_id` is accepted for `conversationId`. */
export const messageBody = z.preprocess(
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const o = { ...(v as Record<string, unknown>) };
    if (o.text === undefined && o.message !== undefined) o.text = o.message;
    if (o.conversationId === undefined && o.conversation_id !== undefined) o.conversationId = o.conversation_id;
    delete o.message;
    delete o.conversation_id;
    return o;
  },
  z.object({
    text: z.string({ error: "text (or message) is required" }).trim().min(1, "text (or message) is required").max(20_000),
    conversationId: z.uuid().optional(),
    wait: z.boolean().optional().default(false),
  }),
);

export type ApiRunDeliverable = { id: string; title: string; preview: string | null; kind: string; url: string };

/** Deliverables a run produced, re-read org-scoped (titles/previews only; bodies need deliverables:read). */
async function runDeliverables(p: ApiPrincipal, ids: string[]): Promise<ApiRunDeliverable[]> {
  const unique = [...new Set(ids)].filter((id) => z.uuid().safeParse(id).success).slice(0, 20);
  if (unique.length === 0) return [];
  const rows = await db()
    .select({ id: schema.deliverables.id, title: schema.deliverables.title, preview: schema.deliverables.preview, kind: schema.deliverables.kind, createdAt: schema.deliverables.createdAt })
    .from(schema.deliverables)
    .where(and(eq(schema.deliverables.orgId, p.orgId), inArray(schema.deliverables.id, unique)))
    .orderBy(schema.deliverables.createdAt);
  return rows.map((d) => ({ id: d.id, title: d.title, preview: d.preview, kind: d.kind, url: portalDeliverableUrl(p.orgSlug, d.id) }));
}

export async function sendMessage(
  p: ApiPrincipal,
  agentId: string,
  body: unknown,
  channel: "api" | "mcp" = "api",
): Promise<{
  status: number;
  body: { conversationId: string; runId: string; reply: string | null; status: "completed" | "queued"; deliverables: ApiRunDeliverable[] };
}> {
  const input = parseWith(messageBody, body);
  const agent = await loadAgent(p, agentId);
  if (agent.status !== "active") throw new ApiError("conflict", `Agent is ${agent.status}; it can't take messages right now.`);
  if (input.conversationId) {
    const [conv] = await db()
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, input.conversationId),
          eq(schema.conversations.orgId, p.orgId),
          eq(schema.conversations.agentId, agent.id),
        ),
      )
      .limit(1);
    if (!conv) throw new ApiError("not_found", "Conversation not found.");
  }
  await chargeInvoke(p);
  const res = await engineCall(() => engine.messageAgent({
    orgId: p.orgId,
    agentId: agent.id,
    text: input.text,
    conversationId: input.conversationId,
    channel,
    actor: { type: "api_key", keyId: p.keyId },
    wait: input.wait,
  }));
  const done = input.wait && typeof res.reply === "string";
  const made = Array.isArray(res.deliverables) ? res.deliverables.map((d) => d.id) : [];
  return {
    status: done ? 200 : 202,
    body: {
      conversationId: res.conversationId,
      runId: res.runId,
      reply: res.reply ?? null,
      status: done ? "completed" : "queued",
      deliverables: await runDeliverables(p, made),
    },
  };
}

export const deliverablesQuery = listQuery.extend({
  agentId: z.uuid().optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(["new", "seen", "approved", "changes_requested", "archived"]).optional(),
});

export async function listDeliverables(p: ApiPrincipal, query: unknown) {
  const q = parseWith(deliverablesQuery, query);
  const conds: (SQL | undefined)[] = [eq(schema.deliverables.orgId, p.orgId)];
  if (p.agentId) conds.push(eq(schema.deliverables.agentId, p.agentId));
  if (q.agentId) conds.push(eq(schema.deliverables.agentId, q.agentId));
  if (q.since) conds.push(gte(schema.deliverables.createdAt, new Date(q.since)));
  if (q.status) conds.push(eq(schema.deliverables.status, q.status));
  conds.push(afterCursor(schema.deliverables.createdAt, schema.deliverables.id, q.cursor));
  const rows = await db()
    .select({ row: schema.deliverables, ts: cursorTs(schema.deliverables.createdAt) })
    .from(schema.deliverables)
    .where(and(...conds))
    .orderBy(desc(schema.deliverables.createdAt), desc(schema.deliverables.id))
    .limit(q.limit + 1);
  return page(rows, q.limit, (d) => serializeDeliverable(d, p.orgSlug));
}

export async function getDeliverable(p: ApiPrincipal, deliverableId: string): Promise<ApiDeliverable> {
  const conds = [eq(schema.deliverables.orgId, p.orgId), eq(schema.deliverables.id, deliverableId)];
  if (p.agentId) conds.push(eq(schema.deliverables.agentId, p.agentId));
  const [d] = await db()
    .select()
    .from(schema.deliverables)
    .where(and(...conds))
    .limit(1);
  if (!d) throw new ApiError("not_found", "Deliverable not found.");
  return serializeDeliverable(d, p.orgSlug);
}

export async function runWorkflow(p: ApiPrincipal, workflowId: string): Promise<{ runId: string; workflowId: string; status: "queued" }> {
  const conds = [eq(schema.workflows.orgId, p.orgId), eq(schema.workflows.id, workflowId)];
  if (p.agentId) conds.push(eq(schema.workflows.agentId, p.agentId));
  const [w] = await db()
    .select({ id: schema.workflows.id, agentId: schema.workflows.agentId, enabled: schema.workflows.enabled })
    .from(schema.workflows)
    .where(and(...conds))
    .limit(1);
  if (!w) throw new ApiError("not_found", "Workflow not found.");
  const agent = await loadAgent(p, w.agentId).catch(() => null);
  if (!agent) throw new ApiError("not_found", "Workflow not found.");
  if (agent.status !== "active") throw new ApiError("conflict", `Agent is ${agent.status}; workflows can't run right now.`);
  if (!w.enabled) throw new ApiError("conflict", "Workflow is disabled.");
  await chargeInvoke(p);
  const { runId } = await engineCall(() => engine.runWorkflowNow({ orgId: p.orgId, workflowId: w.id, actor: { type: "api_key", keyId: p.keyId } }));
  return { runId, workflowId: w.id, status: "queued" };
}
