import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export const dynamic = "force-dynamic";

/** Liveness + DB readiness. Used by load balancers and the container HEALTHCHECK. */
export async function GET() {
  const started = Date.now();
  try {
    await db().execute(sql`select 1`);
    return Response.json({ ok: true, db: "up", latencyMs: Date.now() - started }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
