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
    return enqueued;
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
