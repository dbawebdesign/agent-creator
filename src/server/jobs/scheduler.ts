/**
 * Scheduler: finds due workflows and enqueues exactly one agent.run per scheduled slot.
 *
 * Safe with any number of workers: due rows are locked with FOR UPDATE SKIP LOCKED inside one transaction, the
 * job carries an idempotency key per (workflow, slot), and next_run_at is advanced (in the org's timezone) in the
 * same transaction. Missed slots (worker downtime) collapse into a single catch-up run.
 */
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { eq, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import type { WorkflowTrigger } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { enqueue } from "./queue";

/** Next fire time strictly after `after`, evaluating the cron in `timezone`. */
export function nextCronRun(cron: string, timezone: string, after: Date = new Date()): Date {
  const expr = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone });
  return expr.next().toDate();
}

export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron);
    return cron.trim().split(/\s+/).length === 5;
  } catch {
    return false;
  }
}

/** The next 6:00 AM in the org's timezone (the "overnight wow" delivery time). */
export function nextLocalTime(timezone: string, hour = 6, minute = 0, after: Date = new Date()): Date {
  return nextCronRun(`${minute} ${hour} * * *`, timezone, after);
}

export function nextRunForTrigger(trigger: WorkflowTrigger, timezone: string, after: Date = new Date()): Date | null {
  if (trigger.type !== "schedule") return null;
  try {
    return nextCronRun(trigger.cron, trigger.timezone ?? timezone, after);
  } catch {
    return null;
  }
}

type DueRow = { id: string; org_id: string; agent_id: string; trigger: WorkflowTrigger; next_run_at: Date | string; timezone: string };

/** One scheduler pass. Returns the number of runs enqueued. */
export async function schedulerTick(database: DB, now: Date = new Date(), batch = 100): Promise<number> {
  return (await schedulerBatch(database, now, batch)).enqueued;
}

/**
 * Drain the due backlog: repeat batches (each its own short transaction, rows locked SKIP LOCKED so other workers
 * take other rows in parallel) until a batch comes back short, the time budget runs out, or `shouldStop()` says the
 * worker is shutting down. Anything left is picked up on the next tick, by this worker or another.
 */
export async function schedulerDrain(
  database: DB,
  opts: { now?: () => Date; batch?: number; budgetMs?: number; shouldStop?: () => boolean } = {},
): Promise<{ due: number; enqueued: number; batches: number; ms: number; more: boolean }> {
  const started = Date.now();
  const batch = opts.batch ?? 250;
  const budget = opts.budgetMs ?? 10_000;
  let due = 0;
  let enqueued = 0;
  let batches = 0;
  for (;;) {
    const r = await schedulerBatch(database, opts.now?.() ?? new Date(), batch);
    batches++;
    due += r.due;
    enqueued += r.enqueued;
    const more = r.due >= batch;
    if (!more || Date.now() - started >= budget || opts.shouldStop?.()) return { due, enqueued, batches, ms: Date.now() - started, more };
  }
}

async function schedulerBatch(database: DB, now: Date, batch: number): Promise<{ due: number; enqueued: number }> {
  return database.transaction(async (tx) => {
    const due = (
      await tx.execute(sql`
        select w.id, w.org_id, w.agent_id, w.trigger, w.next_run_at, o.timezone
        from workflows w
        join agents a on a.id = w.agent_id and a.org_id = w.org_id
        join organizations o on o.id = w.org_id
        where w.enabled = true and w.next_run_at is not null and w.next_run_at <= ${now.toISOString()}::timestamptz
          and a.status = 'active' and o.deleted_at is null
        order by w.next_run_at asc
        limit ${batch}
        for update of w skip locked`)
    ).rows as DueRow[];
    let enqueued = 0;
    for (const w of due) {
      const slot = new Date(w.next_run_at);
      const next = nextRunForTrigger(w.trigger, w.timezone, now);
      const runId = randomUUID();
      const jobId = await enqueue(
        tx,
        "agent.run",
        { orgId: w.org_id, runId },
        { orgId: w.org_id, idempotencyKey: `wf:${w.id}:${slot.toISOString()}` },
      );
      if (jobId) {
        await tx.insert(schema.runs).values({
          id: runId,
          orgId: w.org_id,
          agentId: w.agent_id,
          workflowId: w.id,
          trigger: "schedule",
          status: "queued",
          input: { kind: "workflow", scheduledFor: slot.toISOString() },
        });
        enqueued++;
      }
      await tx.update(schema.workflows).set({ nextRunAt: next }).where(eq(schema.workflows.id, w.id));
      if (!next) logger.warn({ workflowId: w.id }, "workflow has no next run (invalid cron or non-schedule trigger)");
    }
    return { due: due.length, enqueued };
  });
}

/** How long a pending approval waits for a human before it expires (env APPROVAL_TTL_HOURS, default 7 days). */
export function approvalTtlMs(): number {
  const h = Number(process.env.APPROVAL_TTL_HOURS ?? 168);
  return (Number.isFinite(h) && h > 0 ? h : 168) * 3_600_000;
}

/**
 * Expire approvals nobody decided on and wake their runs so the agent records the action as not taken and
 * finishes (the runtime treats "expired" like a rejection). Multi-worker safe: the UPDATE … WHERE status='pending'
 * is atomic per row, and the resume job reuses decideApproval's idempotency key.
 */
export async function expireApprovals(database: DB, now: Date = new Date(), ttlMs = approvalTtlMs(), batch = 100): Promise<number> {
  const cutoff = new Date(now.getTime() - ttlMs);
  const expired = (
    await database.execute(sql`
      update approvals set status = 'expired', decided_at = ${now.toISOString()}::timestamptz
      where id in (
        select id from approvals where status = 'pending' and created_at < ${cutoff.toISOString()}::timestamptz
        order by created_at limit ${batch} for update skip locked)
      returning id, org_id, run_id`)
  ).rows as Array<{ id: string; org_id: string; run_id: string | null }>;
  for (const a of expired) {
    if (a.run_id) await enqueue(database, "agent.run", { orgId: a.org_id, runId: a.run_id }, { orgId: a.org_id, priority: 30, idempotencyKey: `approval:${a.id}` });
  }
  if (expired.length) logger.info({ expired: expired.length }, "expired stale approvals");
  return expired.length;
}

/** Local wall-clock hour (0-23) of `at` in `timezone`. */
export function localHour(timezone: string, at: Date): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(at);
    return Number(h) % 24;
  } catch {
    return at.getUTCHours();
  }
}

/**
 * When the first ("overnight wow") deliverable is worked on and when it is handed over, in the client's timezone:
 * - hired before 1:00 AM: work at 1:00, release at 6:00;
 * - hired 1:00–6:00 AM: work now, release at 6:00;
 * - hired after 6:00 AM: work now and release as soon as it is done (releaseAt null).
 * Work starts hours early so the deliverable is ready (and retried if needed) well before the owner wakes up.
 */
export function firstDeliverableSchedule(timezone: string, now: Date = new Date()): { runAt: Date; releaseAt: Date | null } {
  const h = localHour(timezone, now);
  if (h < 1) return { runAt: nextLocalTime(timezone, 1, 0, now), releaseAt: nextLocalTime(timezone, 6, 0, now) };
  if (h < 6) return { runAt: now, releaseAt: nextLocalTime(timezone, 6, 0, now) };
  return { runAt: now, releaseAt: null };
}
