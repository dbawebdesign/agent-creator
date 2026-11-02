import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { configProblems } from "@/server/env";
import { logger } from "@/server/lib/logger";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Liveness + readiness for load balancers and the container HEALTHCHECK: 200 when the config is valid and the DB
 * answers, 503 otherwise. The body names the failing check (`config` lists variable names and rules, never values;
 * `db` is up/down) and the cause is logged, so an unhealthy instance explains itself.
 */
export async function GET() {
  const problems = configProblems();
  if (problems.length) {
    logger.error({ problems }, "health: configuration invalid");
    return Response.json({ ok: false, config: "invalid", problems }, { status: 503, headers: NO_STORE });
  }
  const started = Date.now();
  try {
    await db().execute(sql`select 1`);
    return Response.json({ ok: true, config: "ok", db: "up", latencyMs: Date.now() - started }, { headers: NO_STORE });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "health: database unreachable");
    return Response.json({ ok: false, config: "ok", db: "down" }, { status: 503, headers: NO_STORE });
  }
}
