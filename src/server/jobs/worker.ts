/**
 * Worker loop: claims jobs (FOR UPDATE SKIP LOCKED) with bounded concurrency, renews leases while handlers run,
 * runs the scheduler tick, and shuts down gracefully. Any number of workers can run side by side.
 */
import { sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { complete, fail, type JobType } from "./queue";
import { schedulerTick } from "./scheduler";

export type ClaimedRow = { id: string; type: string; payload: Record<string, unknown>; orgId: string | null; attempts: number; maxAttempts: number };
type Handler = (payload: Record<string, unknown>, ctx: { db: DB; jobId: string; attempts: number; maxAttempts: number }) => Promise<void>;

export const LEASE_MS = 5 * 60_000;

/** Like queue.claim, optionally restricted to job types. */
export async function claimTypes(database: DB, workerId: string, limit: number, types: JobType[] | null, leaseMs = LEASE_MS, queue = "default"): Promise<ClaimedRow[]> {
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await database.execute(sql`
    update jobs set status = 'running', locked_by = ${workerId},
      locked_until = now() + (${leaseMs} || ' milliseconds')::interval,
      attempts = attempts + 1
    where id in (
      select id from jobs
      where queue = ${queue} ${typeFilter}
        and ((status = 'queued' and run_at <= now())
          or (status = 'running' and locked_until < now()))
      order by priority desc, run_at asc
      limit ${limit}
      for update skip locked
    )
    returning id, type, payload, org_id as "orgId", attempts, max_attempts as "maxAttempts"`);
  return res.rows as ClaimedRow[];
}

async function renewLease(database: DB, jobId: string, workerId: string, leaseMs = LEASE_MS) {
  await database.execute(sql`
    update jobs set locked_until = now() + (${leaseMs} || ' milliseconds')::interval
    where id = ${jobId} and locked_by = ${workerId} and status = 'running'`);
}

/** Run one claimed job with lease renewal; completes or fails (with backoff / dead-letter) it. */
export async function processJob(database: DB, job: ClaimedRow, handlers: Record<string, Handler>, workerId: string): Promise<void> {
  const handler = handlers[job.type];
  const timer = setInterval(() => {
    renewLease(database, job.id, workerId).catch((err) => logger.warn({ err: (err as Error).message, jobId: job.id }, "lease renewal failed"));
  }, Math.floor(LEASE_MS / 3));
  timer.unref?.();
  const started = Date.now();
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(job.payload ?? {}, { db: database, jobId: job.id, attempts: job.attempts, maxAttempts: job.maxAttempts });
    // Only the lease holder may complete the job (a reclaimed job belongs to someone else now).
    await database.execute(sql`
      update jobs set status = 'succeeded', finished_at = now(), locked_by = null, locked_until = null
      where id = ${job.id} and locked_by = ${workerId}`);
    logger.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, "job succeeded");
  } catch (err) {
    const dead = await fail(database, job, err);
    logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, dead, err: err instanceof Error ? err.message : String(err) }, "job failed");
  } finally {
    clearInterval(timer);
  }
}

export type WorkerHandle = { stop(): Promise<void>; readonly running: number };

export function startWorker(opts: {
  database: DB;
  handlers: Record<string, Handler>;
  concurrency: number;
  workerId: string;
  pollMs?: number;
  schedulerMs?: number;
}): WorkerHandle {
  const inflight = new Set<Promise<void>>();
  let stopping = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });

  const loop = (async () => {
    while (!stopping) {
      const free = opts.concurrency - inflight.size;
      let claimed: ClaimedRow[] = [];
      if (free > 0) {
        try {
          claimed = await claimTypes(opts.database, opts.workerId, free, null);
        } catch (err) {
          logger.error({ err: (err as Error).message }, "claim failed");
        }
      }
      for (const job of claimed) {
        const p = processJob(opts.database, job, opts.handlers, opts.workerId).finally(() => {
          inflight.delete(p);
          wake?.();
        });
        inflight.add(p);
      }
      if (!claimed.length || inflight.size >= opts.concurrency) await sleep(opts.pollMs ?? 1000);
    }
  })();

  const tick = setInterval(() => {
    if (stopping) return;
    schedulerTick(opts.database)
      .then((n) => n && logger.info({ enqueued: n }, "scheduler enqueued runs"))
      .catch((err) => logger.error({ err: (err as Error).message }, "scheduler tick failed"));
  }, opts.schedulerMs ?? 15_000);

  return {
    get running() {
      return inflight.size;
    },
    async stop() {
      stopping = true;
      clearInterval(tick);
      wake?.();
      await loop;
      // Let in-flight jobs finish (their leases keep them owned); after the grace period they are reclaimed.
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 30_000))]);
    },
  };
}

export { complete };
