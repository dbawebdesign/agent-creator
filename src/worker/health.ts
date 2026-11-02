/**
 * Worker container HEALTHCHECK: exit 0 when the worker touched its heartbeat file recently, else 1.
 * `node dist/worker-health.mjs` in the image; `tsx src/worker/health.ts` from source.
 */
import { statSync } from "node:fs";
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from "./heartbeat";

try {
  const age = Date.now() - statSync(HEARTBEAT_FILE).mtimeMs;
  if (age > HEARTBEAT_STALE_MS) {
    console.error(`worker heartbeat stale (${Math.round(age / 1000)}s old)`);
    process.exit(1);
  }
  process.exit(0);
} catch {
  console.error("worker heartbeat missing");
  process.exit(1);
}
