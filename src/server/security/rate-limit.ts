/**
 * Fixed-window rate limiter backed by Postgres (shared across instances).
 * Uses an UNLOGGED table for speed; swap for Redis at very high volume.
 */
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await db().execute(sql`
    create unlogged table if not exists rate_limits (
      key text primary key,
      count integer not null,
      reset_at timestamptz not null
    )`);
  ensured = true;
}

export async function rateLimit(key: string, limit: number, windowSec: number): Promise<{ ok: boolean; remaining: number; resetAt: Date }> {
  await ensureTable();
  const res = await db().execute(sql`
    insert into rate_limits (key, count, reset_at) values (${key}, 1, now() + (${windowSec} || ' seconds')::interval)
    on conflict (key) do update set
      count = case when rate_limits.reset_at < now() then 1 else rate_limits.count + 1 end,
      reset_at = case when rate_limits.reset_at < now() then now() + (${windowSec} || ' seconds')::interval else rate_limits.reset_at end
    returning count, reset_at`);
  const row = res.rows[0] as { count: number; reset_at: string | Date };
  return { ok: row.count <= limit, remaining: Math.max(0, limit - row.count), resetAt: new Date(row.reset_at) };
}
