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

/**
 * Database errors carry the query's parameter values ("Failed query: … params: a@b.com,…"): emails, message text.
 * Strip them from anything logged, whatever field or message string they arrive in.
 */
export function scrubDbParams(text: string): string {
  return text.replace(/\bparams: [\s\S]*?(?=\n\s*at |\n\n|$)/g, "params: [redacted]");
}

function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.includes("params:") ? scrubDbParams(v) : v;
  if (depth > 3 || v === null || typeof v !== "object") return v;
  if (v instanceof Error) {
    const out: Record<string, unknown> = { type: v.name, message: scrubDbParams(v.message) };
    if (v.stack) out.stack = scrubDbParams(v.stack);
    const cause = (v as { cause?: unknown }).cause;
    if (cause) out.cause = scrubValue(cause, depth + 1);
    const code = (v as { code?: unknown }).code;
    if (typeof code === "string") out.code = code;
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = k === "params" ? "[redacted]" : scrubValue(x, depth + 1);
  return out;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: process.env.ROSTER_PROCESS ?? "roster-web" },
  mixin: () => store.getStore() ?? {},
  formatters: { log: (obj) => scrubValue(obj) as Record<string, unknown> },
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map((a) => (typeof a === "string" && a.includes("params:") ? scrubDbParams(a) : a)) as Parameters<typeof method>);
    },
  },
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
