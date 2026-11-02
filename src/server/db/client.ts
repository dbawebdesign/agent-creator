import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { env } from "@/server/env";

export type DB = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __rosterPool?: pg.Pool; __rosterDb?: DB };

function createPool() {
  return new pg.Pool({
    connectionString: env().DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: process.env.ROSTER_PROCESS ?? "roster-web",
  });
}

export function pool(): pg.Pool {
  if (!globalForDb.__rosterPool) globalForDb.__rosterPool = createPool();
  return globalForDb.__rosterPool;
}

export function db(): DB {
  if (!globalForDb.__rosterDb) globalForDb.__rosterDb = drizzle(pool(), { schema, casing: "snake_case" });
  return globalForDb.__rosterDb;
}

export { schema };
