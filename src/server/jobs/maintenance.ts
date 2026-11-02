/**
 * Retention (`maintenance.prune`, enqueued hourly by every worker; the idempotency key makes it one job per hour).
 *
 * Deletes in batches of `batch` rows (`delete … where id = any(array(select … limit n))`), each its own statement, so no long
 * locks and replication/vacuum keep up. Bounded by a time budget; whatever is left goes in the next hour's run.
 *
 *   jobs            succeeded > 7 days, failed/dead > 30 days after finishing (jobs_finished_idx)
 *   webhook_events  > 30 days (whole inbound emails/SMS: PII) (webhook_events_created_idx)
 *   sessions        expired (sessions_expires_idx)
 *   auth_tokens     expired more than a day ago (auth_tokens_expires_idx)
 *   rate_limits     window over (rate_limits_reset_idx)
 *
 * Kept on purpose: usage_events (billing/margin history) and audit_logs (compliance). Plan when they get big
 * (tens of millions of rows): monthly range partitions on created_at (declarative partitioning, the existing
 * (org_id|agency_id, created_at) indexes become per-partition), detach partitions older than 13 months, dump them
 * to object storage (parquet/CSV), then drop. usage_events can additionally be rolled up into a daily
 * per-(agency, org, agent, kind) table before archiving.
 */
import { sql, type SQL } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { enqueue } from "./queue";

export const RETENTION = {
  succeededJobsDays: 7,
  failedJobsDays: 30,
  webhookEventsDays: 30,
  authTokensGraceDays: 1,
} as const;

type Target = { table: string; where: SQL };

function targets(): Target[] {
  return [
    { table: "jobs", where: sql`status = 'succeeded' and finished_at < now() - make_interval(days => ${RETENTION.succeededJobsDays})` },
    { table: "jobs", where: sql`status in ('failed','dead') and finished_at < now() - make_interval(days => ${RETENTION.failedJobsDays})` },
    { table: "webhook_events", where: sql`created_at < now() - make_interval(days => ${RETENTION.webhookEventsDays})` },
    { table: "sessions", where: sql`expires_at < now()` },
    { table: "auth_tokens", where: sql`expires_at < now() - make_interval(days => ${RETENTION.authTokensGraceDays})` },
    { table: "rate_limits", where: sql`reset_at < now()` },
  ];
}

export async function pruneOnce(database: Pick<DB, "execute">, opts: { batch?: number; budgetMs?: number } = {}): Promise<Record<string, number>> {
  const batch = opts.batch ?? 5_000;
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const deleted: Record<string, number> = {};
  for (const t of targets()) {
    // rate_limits is keyed by `key`, the rest by `id`.
    const key = t.table === "rate_limits" ? sql.raw("key") : sql.raw("id");
    const table = sql.raw(t.table);
    for (;;) {
      // `= any(array(…))` (not `in (select …)`): the planner then deletes through the primary key instead of
      // hash-joining a full scan of the table (33ms vs 138ms per 5k-row batch on 500k jobs).
      const res = await database.execute(sql`delete from ${table} where ${key} = any(array(select ${key} from ${table} where ${t.where} limit ${batch}))`);
      const n = res.rowCount ?? 0;
      deleted[t.table] = (deleted[t.table] ?? 0) + n;
      if (n < batch || Date.now() > deadline) break;
    }
    if (Date.now() > deadline) break;
  }
  return deleted;
}

export async function maintenancePrune(database: DB): Promise<void> {
  const started = Date.now();
  const deleted = await pruneOnce(database);
  logger.info({ deleted, ms: Date.now() - started }, "maintenance.prune done");
}

/** The next full hour after `now` (UTC). */
export function nextHourSlot(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

/**
 * Make sure the next hour's prune job exists. Every worker calls this each scheduler tick; the idempotency key is
 * per slot, so there is one job per hour however many workers run (after it succeeds, `now` is past the slot and
 * the key moves on to the next hour).
 */
export async function ensureMaintenanceScheduled(database: Pick<DB, "insert">, now = new Date()): Promise<string | null> {
  const slot = nextHourSlot(now);
  return enqueue(database, "maintenance.prune", {}, { runAt: slot, priority: -10, maxAttempts: 3, idempotencyKey: `maintenance.prune:${slot.toISOString()}` });
}
