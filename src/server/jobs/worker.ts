/**
 * Worker loop: claims jobs (FOR UPDATE SKIP LOCKED) with bounded concurrency, renews leases while handlers run,
 * runs the scheduler tick, and shuts down gracefully. Any number of workers can run side by side.
 */
import { sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { logger, withLogContext } from "@/server/lib/logger";
import { backoffMs, reclaimExpired, type JobType } from "./queue";
import { expireApprovals, schedulerDrain } from "./scheduler";

export type ClaimedRow = { id: string; type: string; payload: Record<string, unknown>; orgId: string | null; attempts: number; maxAttempts: number };
type Handler = (payload: Record<string, unknown>, ctx: { db: DB; jobId: string; attempts: number; maxAttempts: number }) => Promise<void>;

export const LEASE_MS = 5 * 60_000;

/**
 * Like queue.claim, optionally restricted to job types. Expired leases are first put back in the queue (or
 * dead-lettered once their attempts are spent) by `reclaimExpired`; the claim itself only reads `status='queued'`
 * through jobs_claim_idx (queue, priority desc, run_at), so it stays sub-millisecond with a large backlog.
 */
export async function claimTypes(database: DB, workerId: string, limit: number, types: JobType[] | null, leaseMs = LEASE_MS, queue = "default"): Promise<ClaimedRow[]> {
  await reclaimExpired(database, queue);
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await database.execute(sql`
    update jobs set status = 'running', locked_by = ${workerId},
      locked_until = now() + (${leaseMs} || ' milliseconds')::interval,
      attempts = attempts + 1
    where id in (
      select id from jobs
      where queue = ${queue} ${typeFilter} and status = 'queued' and run_at <= now()
      order by priority desc, run_at asc
      limit ${limit}
      for update skip locked
    )
    returning id, type, payload, org_id as "orgId", attempts, max_attempts as "maxAttempts"`);
  return res.rows as ClaimedRow[];
}

/** Log fields for a job: jobId, type, orgId and (when the payload has one) runId. */
export function jobLogContext(job: Pick<ClaimedRow, "id" | "type" | "orgId" | "payload">) {
  const runId = typeof job.payload?.runId === "string" ? job.payload.runId : undefined;
  return { jobId: job.id, type: job.type, orgId: job.orgId ?? undefined, ...(runId ? { runId } : {}) };
}

async function renewLease(database: DB, jobId: string, workerId: string, leaseMs = LEASE_MS) {
  await database.execute(sql`
    update jobs set locked_until = now() + (${leaseMs} || ' milliseconds')::interval
    where id = ${jobId} and locked_by = ${workerId} and status = 'running'`);
}

/** Run one claimed job with lease renewal; completes or fails (with backoff / dead-letter) it. */
export async function processJob(database: DB, job: ClaimedRow, handlers: Record<string, Handler>, workerId: string): Promise<void> {
  return withLogContext(jobLogContext(job), () => processJobInContext(database, job, handlers, workerId));
}

async function processJobInContext(database: DB, job: ClaimedRow, handlers: Record<string, Handler>, workerId: string): Promise<void> {
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
    logger.info({ attempts: job.attempts, ms: Date.now() - started }, "job succeeded");
  } catch (err) {
    const dead = await failOwned(database, job, workerId, err);
    logger.warn({ attempts: job.attempts, maxAttempts: job.maxAttempts, dead, ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) }, "job failed");
  } finally {
    clearInterval(timer);
  }
}

/** Like queue.fail, but only if this worker still holds the lease (a reclaimed job is someone else's now). */
async function failOwned(database: DB, job: ClaimedRow, workerId: string, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const dead = job.attempts >= job.maxAttempts;
  await database.execute(sql`
    update jobs set
      status = ${dead ? "dead" : "queued"},
      last_error = ${message.slice(0, 4000)},
      run_at = now() + (${backoffMs(job.attempts)} || ' milliseconds')::interval,
      locked_by = null, locked_until = null,
      finished_at = ${dead ? sql`now()` : sql`null`}
    where id = ${job.id} and locked_by = ${workerId}`);
  return dead;
}

export type WorkerHandle = { stop(): Promise<void>; readonly running: number; readonly lastLoopAt: number };

export function startWorker(opts: {
  database: DB;
  handlers: Record<string, Handler>;
  concurrency: number;
  workerId: string;
  pollMs?: number;
  schedulerMs?: number;
  /** Called after each scheduler tick (the worker process uses it for maintenance scheduling and heartbeats). */
  onTick?: () => Promise<unknown> | unknown;
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

  let lastLoopAt = Date.now();
  const loop = (async () => {
    while (!stopping) {
      lastLoopAt = Date.now();
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

  // Scheduler: drain every due workflow (in SKIP LOCKED batches, bounded by a time budget) each tick; ticks never
  // overlap within a worker, and several workers share the backlog. Jitter keeps a fleet from ticking in lockstep.
  let ticking = false;
  const tickMs = opts.schedulerMs ?? 15_000;
  const tick = setInterval(() => {
    if (stopping || ticking) return;
    ticking = true;
    const jitter = Math.floor(Math.random() * Math.min(2_000, tickMs / 4));
    setTimeout(() => {
      schedulerDrain(opts.database, { budgetMs: Math.max(1_000, tickMs - 2_000), shouldStop: () => stopping })
        .then((r) => r.enqueued && logger.info(r, "scheduler enqueued runs"))
        .then(() => expireApprovals(opts.database))
        .then(() => opts.onTick?.())
        .catch((err) => logger.error({ err: (err as Error).message }, "scheduler tick failed"))
        .finally(() => {
          ticking = false;
        });
    }, jitter).unref?.();
  }, tickMs);

  return {
    get running() {
      return inflight.size;
    },
    get lastLoopAt() {
      return lastLoopAt;
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
