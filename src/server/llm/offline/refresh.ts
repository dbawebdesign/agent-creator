/**
 * The first overnight deliverable is written right after hire and held until the release time. Files the client
 * uploads after that (a patient list, a price sheet) would never reach it. These helpers rewrite the held draft from
 * the knowledge base as it is now: called when a knowledge source finishes indexing and when "Release now" is clicked.
 *
 * Offline model only (the deterministic composer re-runs in milliseconds). With a real model the held draft is left
 * as written. The draft keeps its id and title, so release stays idempotent.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import { isOfflineModel } from "@/server/env";
import { recallMemories, searchKnowledge } from "@/server/knowledge";
import { logger } from "@/server/lib/logger";
import { keywords } from "../text";
import { compose, type Snip } from "./compose";
import { collectTables, isComplete, tableQuery } from "./tablework";

type HeldDraft = { id: string; title: string; body: string; preview?: string; data?: Record<string, unknown> | null; hoursSaved?: number; [k: string]: unknown };

/** The release-job payload with its draft rewritten from current knowledge (or unchanged when that isn't possible). */
export async function refreshHeldPayload(database: DB, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isOfflineModel()) return payload;
  const orgId = String(payload.orgId ?? "");
  const runId = String(payload.runId ?? "");
  const old = payload.deliverable as HeldDraft | undefined;
  if (!orgId || !runId || !old?.id || typeof old.body !== "string") return payload;
  const run = (await database.select().from(schema.runs).where(and(eq(schema.runs.id, runId), eq(schema.runs.orgId, orgId))).limit(1))[0];
  const input = (run?.input ?? {}) as Record<string, unknown>;
  if (!run || input.kind !== "first_deliverable") return payload;
  const agent = (await database.select().from(schema.agents).where(and(eq(schema.agents.id, run.agentId), eq(schema.agents.orgId, orgId))).limit(1))[0];
  const org = (await database.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0];
  if (!agent || !org) return payload;

  const title = String(input.title ?? old.title);
  const body = `${String(input.instructions ?? "")}${input.description ? `\n\nWhy: ${String(input.description)}` : ""}`;
  const query = keywords(`${title} ${title} ${body}`, 8).join(" ") || title;
  const hits = await searchKnowledge(database, { orgId, agentId: agent.id, query, limit: 5 });
  let knowledge: Snip[] = hits.map((h) => ({ title: h.title, text: h.content }));
  const partial = collectTables(knowledge).find((t) => !isComplete(t));
  if (partial) knowledge = [...knowledge, ...(await searchKnowledge(database, { orgId, agentId: agent.id, query: tableQuery(partial), limit: 10 })).map((h) => ({ title: h.title, text: h.content }))];
  const memories: Snip[] = (await recallMemories(database, { orgId, agentId: agent.id, query, limit: 6 })).map((m) => ({ title: m.kind, text: m.content, kind: m.kind }));
  const d = compose({
    kind: "first_deliverable",
    title,
    output: String(input.outputKind ?? "document"),
    body,
    system: `You are ${agent.name}, ${agent.role} at ${org.name}.`,
    knowledge,
    memories,
  });
  const substantive = d.data?.substantive !== false;
  const draft: HeldDraft = {
    ...old,
    body: d.body,
    preview: d.preview,
    data: { ...(old.data ?? {}), ...(d.data ?? {}), refreshedAt: new Date().toISOString() },
    // Hours are credited only for real work, not a format waiting for data.
    hoursSaved: substantive ? (old.hoursSaved ?? 0) : 0,
  };
  return { ...payload, deliverable: draft };
}

/** Rewrite every held first deliverable of an org (after a file finishes indexing). Never throws. */
export async function refreshHeldForOrg(database: DB, orgId: string): Promise<number> {
  if (!isOfflineModel()) return 0;
  try {
    const jobs = await database
      .select({ id: schema.jobs.id, payload: schema.jobs.payload })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.orgId, orgId), eq(schema.jobs.type, "deliverable.release"), eq(schema.jobs.status, "queued")))
      .limit(10);
    let n = 0;
    for (const j of jobs) {
      const next = await refreshHeldPayload(database, j.payload);
      if (next === j.payload) continue;
      // Only while still queued: a release that started in the meantime keeps what it has.
      const done = await database
        .update(schema.jobs)
        .set({ payload: next })
        .where(and(eq(schema.jobs.id, j.id), eq(schema.jobs.orgId, orgId), eq(schema.jobs.status, "queued"), sql`${schema.jobs.type} = 'deliverable.release'`))
        .returning({ id: schema.jobs.id });
      n += done.length;
    }
    return n;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : "unknown", orgId }, "could not refresh the held first deliverable");
    return 0;
  }
}
