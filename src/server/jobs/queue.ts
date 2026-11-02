/**
 * Durable Postgres job queue.
 *
 * - Claims with FOR UPDATE SKIP LOCKED: any number of workers, no double processing.
 * - Lease-based locking: a crashed worker's jobs are reclaimed after `lockedUntil`.
 * - Exponential backoff with jitter, dead-lettering after `maxAttempts`.
 * - Idempotency keys: at most one queued/running job per key.
 */
import { sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";

export type JobType =
  | "agent.run" // execute a run (workflow, message reply, manual task)
  | "agent.provision" // set up a new agent's stack (inbox, computer, knowledge, first deliverable)
  | "discovery.analyze" // Architect: transcript → agent proposal
  | "knowledge.index" // chunk + index a knowledge source
  | "channel.deliver" // send a deliverable/message out through a channel
  | "inbound.process" // process an inbound email/SMS/Slack event
  | "deliverable.release"; // hand over a deliverable finished early (first overnight deliverable: work ~1 AM, release 6 AM)

export type EnqueueOptions = {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  orgId?: string | null;
  queue?: string;
};

/** Accepts the db or a transaction (anything with `insert`). */
export async function enqueue(database: Pick<DB, "insert">, type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}) {
  const rows = await database
    .insert(schema.jobs)
    .values({
      type,
      payload,
      queue: opts.queue ?? "default",
      runAt: opts.runAt ?? new Date(),
      priority: opts.priority ?? 0,
      maxAttempts: opts.maxAttempts ?? 5,
      idempotencyKey: opts.idempotencyKey ?? null,
      orgId: opts.orgId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.jobs.id });
  return rows[0]?.id ?? null;
}

export type ClaimedJob = typeof schema.jobs.$inferSelect;

export async function claim(database: DB, workerId: string, limit: number, leaseMs = 5 * 60_000, queue = "default") {
  const res = await database.execute(sql`
    update jobs set status = 'running', locked_by = ${workerId},
      locked_until = now() + (${leaseMs} || ' milliseconds')::interval,
      attempts = attempts + 1
    where id in (
      select id from jobs
      where queue = ${queue}
        and ((status = 'queued' and run_at <= now())
          or (status = 'running' and locked_until < now()))
      order by priority desc, run_at asc
      limit ${limit}
      for update skip locked
    )
    returning id, type, payload, org_id as "orgId", attempts, max_attempts as "maxAttempts"
  `);
  return res.rows as Array<Pick<ClaimedJob, "id" | "type" | "payload" | "orgId" | "attempts" | "maxAttempts">>;
}

export async function complete(database: DB, jobId: string) {
  await database.execute(sql`
    update jobs set status = 'succeeded', finished_at = now(), locked_by = null, locked_until = null
    where id = ${jobId}`);
}

export function backoffMs(attempt: number) {
  const base = Math.min(60_000 * 2 ** (attempt - 1), 60 * 60_000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export async function fail(database: DB, job: { id: string; attempts: number; maxAttempts: number }, error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const dead = job.attempts >= job.maxAttempts;
  await database.execute(sql`
    update jobs set
      status = ${dead ? "dead" : "queued"},
      last_error = ${message.slice(0, 4000)},
      run_at = now() + (${backoffMs(job.attempts)} || ' milliseconds')::interval,
      locked_by = null, locked_until = null,
      finished_at = ${dead ? sql`now()` : sql`null`}
    where id = ${job.id}`);
  return dead;
}
