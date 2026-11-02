/**
 * Roster worker process: `npm run worker` (dev) or `node --conditions=react-server dist/worker.mjs` (image).
 * Horizontal: run as many as you like; jobs are claimed with SKIP LOCKED and the scheduler is lock-safe.
 *
 * Shutdown: SIGTERM/SIGINT stop claiming, let in-flight jobs finish (up to 30s; their leases keep them owned), then
 * exit. Run it as PID 1's direct child (compose `init: true`, CMD `node …`, never `npm run`) and give the container a
 * stop grace period above 30s, or the drain is cut short.
 *
 * Health: while the claim loop is alive the process touches WORKER_HEARTBEAT_FILE (default
 * /tmp/roster-worker.heartbeat) every 10s; `node dist/worker-health.mjs` (the image HEALTHCHECK) fails when the
 * file is older than 90s.
 */
import "./process-name";
import "server-only";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { db, pool } from "@/server/db/client";
import { env, isOfflineModel } from "@/server/env";
import { HANDLERS } from "@/server/jobs/handlers";
import { ensureMaintenanceScheduled } from "@/server/jobs/maintenance";
import { startWorker } from "@/server/jobs/worker";
import { logger } from "@/server/lib/logger";
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from "./heartbeat";

process.on("unhandledRejection", (err) => logger.error({ err: (err as Error)?.message }, "unhandled rejection"));

let config: ReturnType<typeof env>;
try {
  config = env();
} catch (err) {
  // Fail fast and loudly on bad config (names only, never values).
  logger.fatal({ err: (err as Error).message }, "worker refused to start: invalid configuration");
  process.exit(1);
}

const workerId = `${hostname()}:${process.pid}`;
const concurrency = config.WORKER_CONCURRENCY;
logger.info({ workerId, concurrency, model: isOfflineModel() ? "offline" : "anthropic" }, "worker starting");

const worker = startWorker({
  database: db(),
  handlers: HANDLERS,
  concurrency,
  workerId,
  onTick: () => ensureMaintenanceScheduled(db()),
});

async function beat() {
  // Only report healthy while the claim loop is actually cycling (a wedged loop must fail the healthcheck).
  if (Date.now() - worker.lastLoopAt > HEARTBEAT_STALE_MS / 2) return;
  await writeFile(HEARTBEAT_FILE, String(Date.now())).catch((err) => logger.warn({ err: (err as Error).message }, "heartbeat write failed"));
}
void beat();
const heartbeat = setInterval(() => void beat(), 10_000);
heartbeat.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  logger.info({ signal, inflight: worker.running }, "worker draining");
  await worker.stop();
  await pool().end().catch(() => undefined);
  logger.info("worker stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
