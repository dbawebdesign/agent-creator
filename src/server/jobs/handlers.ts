/**
 * Job registry: maps queue job types to handlers, plus `runJobsOnce()` for tests/dev.
 * channel.deliver / inbound.process are owned by the channels slice.
 */
import "server-only";
import { executeRun, failRun, releaseDeliverable } from "@/server/agents/runtime";
import { channelDeliver, inboundProcess } from "@/server/channels/jobs";
import type { DB } from "@/server/db/client";
import { db } from "@/server/db/client";
import { knowledgeIndexJob } from "@/server/knowledge";
import { logger } from "@/server/lib/logger";
import { htmlToText, safeFetch } from "@/server/security/ssrf";
import { analyzeDiscovery, provisionAgentComputer } from "@/server/services/engine";
import { sql } from "drizzle-orm";
import { maintenancePrune } from "./maintenance";
import { claimTypes, LEASE_MS, processJob, type ClaimedRow } from "./worker";
import type { JobType } from "./queue";
import { DEAD_RUN_ERROR } from "./scheduler";

export type HandlerContext = { db: DB; jobId: string; attempts: number; maxAttempts: number };
export type JobHandler = (payload: Record<string, unknown>, ctx: HandlerContext) => Promise<void>;

async function fetchKnowledgeUrl(url: string): Promise<string> {
  const res = await safeFetch(url, { maxBytes: 2_000_000, timeoutMs: 15_000 });
  if (res.status >= 400) throw new Error(`Fetching the URL failed (${res.status})`);
  return /html/i.test(res.contentType) ? htmlToText(res.body) : res.body;
}

export const HANDLERS: Record<JobType, JobHandler> = {
  "agent.run": async (payload, ctx) => {
    const runId = String(payload.runId ?? "");
    const orgId = String(payload.orgId ?? "");
    if (!runId || !orgId) throw new Error("agent.run: runId and orgId are required");
    try {
      await executeRun(ctx.db, runId, { orgId });
    } catch (err) {
      if (ctx.attempts >= ctx.maxAttempts) {
        logger.error({ runId, attempts: ctx.attempts, err: (err as Error).message }, "agent.run gave up");
        await failRun(ctx.db, runId, orgId, DEAD_RUN_ERROR);
      }
      throw err;
    }
  },
  "agent.provision": async (payload, ctx) => provisionAgentComputer(payload, ctx.db),
  "deliverable.release": async (payload, ctx) => releaseDeliverable(ctx.db, payload),
  "discovery.analyze": async (payload) => {
    await analyzeDiscovery(String(payload.discoveryId ?? ""));
  },
  "knowledge.index": async (payload, ctx) => knowledgeIndexJob(ctx.db, payload, fetchKnowledgeUrl),
  "channel.deliver": async (payload, ctx) => channelDeliver(payload, { db: ctx.db, jobId: ctx.jobId }),
  "inbound.process": async (payload, ctx) => inboundProcess(payload, { db: ctx.db, jobId: ctx.jobId }),
  "maintenance.prune": async (_payload, ctx) => maintenancePrune(ctx.db),
};

/**
 * Whether the web tier may run a queued job itself when no worker picked it up (prod-r1 M6). Development only by
 * default; set ROSTER_INLINE_JOBS=1 to allow it in production (single-box installs without a worker).
 */
export function inlineJobsAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ROSTER_INLINE_JOBS === "1";
}

/**
 * Claim one still-queued job by idempotency key, through the queue (attempt counted, lease taken). Returns null
 * when a worker already has it, it is not due, or inline jobs are not allowed here.
 */
export async function claimQueuedJobByKey(idempotencyKey: string, workerId = `web-inline:${process.pid}`, database: DB = db()): Promise<ClaimedRow | null> {
  if (!inlineJobsAllowed()) return null;
  const res = await database.execute(sql`
    update jobs set status = 'running', locked_by = ${workerId},
      locked_until = now() + (${LEASE_MS} || ' milliseconds')::interval, attempts = attempts + 1
    where id = (
      select id from jobs where idempotency_key = ${idempotencyKey} and status = 'queued' and run_at <= now()
      limit 1 for update skip locked)
    returning id, type, payload, org_id as "orgId", attempts, max_attempts as "maxAttempts"`);
  return (res.rows[0] as ClaimedRow | undefined) ?? null;
}

/**
 * Run a job claimed with claimQueuedJobByKey exactly like a worker would: the lease is renewed while it runs, and
 * only the lease holder completes or fails it (backoff / dead-letter included). Call it inside `after()`.
 */
export async function runClaimedJobInline(job: ClaimedRow, workerId = `web-inline:${process.pid}`, database: DB = db()): Promise<void> {
  await processJob(database, job, HANDLERS, workerId);
}

/**
 * Drain ready jobs synchronously (tests/dev). Claims with the same SKIP LOCKED semantics as the worker.
 * Returns the number of jobs processed. `types` restricts which job types are claimed.
 */
export async function runJobsOnce(opts: { database?: DB; types?: JobType[]; max?: number; workerId?: string } = {}): Promise<number> {
  const database = opts.database ?? db();
  const workerId = opts.workerId ?? `once-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const max = opts.max ?? 100;
  let processed = 0;
  while (processed < max) {
    const jobs = await claimTypes(database, workerId, Math.min(10, max - processed), opts.types ?? null);
    if (!jobs.length) break;
    for (const job of jobs) {
      await processJob(database, job, HANDLERS, workerId);
      processed++;
    }
  }
  if (processed >= max) logger.warn({ max }, "runJobsOnce stopped at max");
  return processed;
}
