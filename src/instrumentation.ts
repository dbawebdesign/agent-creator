/**
 * Next.js instrumentation (runs once per server instance, before it serves traffic).
 *
 * - register(): validates the environment. In production a bad config is fatal: the process logs which variables
 *   are wrong (names only) and exits, instead of booting a server that 500s or silently runs on dev fallbacks.
 * - onRequestError(): every server error (render, route handler, server action, proxy) becomes one structured
 *   pino line with the route, method, path, digest and request id, instead of Next's unstructured `⨯` output.
 */
import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ env }, { logger }] = await Promise.all([import("@/server/env"), import("@/server/lib/logger")]);
  try {
    env();
    logger.info({ nodeEnv: process.env.NODE_ENV }, "web starting: configuration ok");
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, "web refused to start: invalid configuration");
    if (process.env.NODE_ENV === "production") process.exit(1);
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger, logContext } = await import("@/server/lib/logger");
  const e = err as { name?: string; message?: string; digest?: string; stack?: string };
  logger.error(
    {
      requestId: logContext()?.requestId ?? header(request.headers, "x-request-id"),
      method: request.method,
      // Path without the query string: queries can carry tokens (magic links, OAuth codes).
      path: request.path.split("?")[0],
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: (context as { renderSource?: string }).renderSource,
      err: { name: e?.name, message: e?.message, digest: e?.digest, stack: process.env.NODE_ENV === "production" ? undefined : e?.stack },
    },
    "request error",
  );
};
