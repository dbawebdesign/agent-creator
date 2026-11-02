/**
 * Job registry: maps queue job types to handlers, plus `runJobsOnce()` for tests/dev.
 * channel.deliver / inbound.process are owned by the channels slice.
 */
import "server-only";
import { executeRun, failRun } from "@/server/agents/runtime";
import { channelDeliver, inboundProcess } from "@/server/channels/jobs";
import type { DB } from "@/server/db/client";
import { db } from "@/server/db/client";
import { knowledgeIndexJob } from "@/server/knowledge";
import { logger } from "@/server/lib/logger";
import { htmlToText, safeFetch } from "@/server/security/ssrf";
import { analyzeDiscovery, provisionAgentComputer } from "@/server/services/engine";
import { claimTypes, processJob } from "./worker";
import type { JobType } from "./queue";

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
      if (ctx.attempts >= ctx.maxAttempts) await failRun(ctx.db, runId, orgId, `Gave up after ${ctx.attempts} attempts: ${(err as Error).message}`);
      throw err;
    }
  },
  "agent.provision": async (payload, ctx) => provisionAgentComputer(payload, ctx.db),
  "discovery.analyze": async (payload) => {
    await analyzeDiscovery(String(payload.discoveryId ?? ""));
  },
  "knowledge.index": async (payload, ctx) => knowledgeIndexJob(ctx.db, payload, fetchKnowledgeUrl),
  "channel.deliver": async (payload, ctx) => channelDeliver(payload, { db: ctx.db, jobId: ctx.jobId }),
  "inbound.process": async (payload, ctx) => inboundProcess(payload, { db: ctx.db, jobId: ctx.jobId }),
};

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
