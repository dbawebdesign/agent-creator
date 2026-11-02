/**
 * Roster worker process: `npm run worker`.
 * Horizontal: run as many as you like; jobs are claimed with SKIP LOCKED and the scheduler is lock-safe.
 */
import "server-only";
import { hostname } from "node:os";
import { db, pool } from "@/server/db/client";
import { env } from "@/server/env";
import { HANDLERS } from "@/server/jobs/handlers";
import { startWorker } from "@/server/jobs/worker";
import { logger } from "@/server/lib/logger";
import { isOfflineModel } from "@/server/env";

process.env.ROSTER_PROCESS ??= "roster-worker";

const workerId = `${hostname()}:${process.pid}`;
const concurrency = env().WORKER_CONCURRENCY;
logger.info({ workerId, concurrency, model: isOfflineModel() ? "offline" : "anthropic" }, "worker starting");

const worker = startWorker({ database: db(), handlers: HANDLERS, concurrency, workerId });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, inflight: worker.running }, "worker draining");
  await worker.stop();
  await pool().end().catch(() => undefined);
  logger.info("worker stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error({ err: (err as Error)?.message }, "unhandled rejection"));
