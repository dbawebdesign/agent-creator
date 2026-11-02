/**
 * Structured JSON logs (pino). One logger for web, worker and scripts; `service` says which process wrote the line.
 *
 * Context propagation: `withLogContext({ requestId } | { jobId, type, orgId, runId }, fn)` puts fields on every line
 * logged inside `fn` (through AsyncLocalStorage, so deep engine code needs no logger plumbing). The worker wraps each
 * job and the REST API wraps each request this way.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

export type LogContext = { requestId?: string; jobId?: string; type?: string; orgId?: string | null; runId?: string | null; [k: string]: unknown };

const store = new AsyncLocalStorage<LogContext>();

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: process.env.ROSTER_PROCESS ?? "roster-web" },
  mixin: () => store.getStore() ?? {},
  redact: {
    paths: ["*.password", "*.token", "*.apiKey", "*.authorization", "*.secret", "headers.cookie", "headers.authorization"],
    censor: "[redacted]",
  },
});

/** Run `fn` with `ctx` merged into every log line it (and anything it awaits) writes. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = store.getStore();
  return store.run(parent ? { ...parent, ...ctx } : ctx, fn);
}

export function logContext(): LogContext | undefined {
  return store.getStore();
}

const REQUEST_ID_RE = /^[\w.:-]{1,128}$/;

/** The caller's / load balancer's x-request-id when it looks sane, else a fresh one. */
export function requestIdFrom(headers: Headers | { get(name: string): string | null } | null | undefined): string {
  const given = headers?.get("x-request-id") ?? headers?.get("x-amzn-trace-id") ?? null;
  return given && REQUEST_ID_RE.test(given) ? given : crypto.randomUUID();
}
