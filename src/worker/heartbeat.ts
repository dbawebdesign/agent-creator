/** Shared by the worker (writer) and worker-health (the container HEALTHCHECK). No other imports on purpose. */
export const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE || "/tmp/roster-worker.heartbeat";
/** The healthcheck fails when the heartbeat is older than this. */
export const HEARTBEAT_STALE_MS = 90_000;
