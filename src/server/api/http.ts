/**
 * Shared HTTP plumbing for the public API: consistent JSON errors, bearer-key auth with scopes and
 * per-key rate limiting, and opaque cursor pagination.
 */
import "server-only";
import { z } from "zod";
import { logger } from "@/server/lib/logger";
import { readTextCapped } from "./body";
import { rateLimit } from "@/server/security/rate-limit";
import { authenticateApiKey, hasScope, type ApiPrincipal, type ApiScope } from "./keys";

export type ErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "conflict"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "unprocessable"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  insufficient_scope: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  conflict: 409,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unprocessable: 422,
  internal_error: 500,
};

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return Response.json(data, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

export function errorResponse(code: ErrorCode, message: string, extra?: { details?: unknown; headers?: Record<string, string> }) {
  const body: { error: { code: ErrorCode; message: string; details?: unknown } } = { error: { code, message } };
  if (extra?.details !== undefined) body.error.details = extra.details;
  return json(body, { status: STATUS[code], headers: extra?.headers });
}

export function toErrorResponse(err: unknown) {
  if (err instanceof ApiError) return errorResponse(err.code, err.message, { details: err.details, headers: err.headers });
  logger.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, "api: unhandled error");
  return errorResponse("internal_error", "Something went wrong. Try again.");
}

export const RATE_LIMIT_PER_MIN = 120;

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1] ?? null;
}

/**
 * Authenticate the request's bearer key and charge its rate limit. Throws ApiError.
 * Rate-limit headers are returned for the caller to attach.
 */
export async function authenticate(req: Request): Promise<{ principal: ApiPrincipal; rateHeaders: Record<string, string> }> {
  const principal = await authenticateApiKey(bearerToken(req));
  if (!principal) {
    throw new ApiError("unauthorized", "Missing or invalid API key. Send `Authorization: Bearer rk_live_…`.", undefined, {
      "WWW-Authenticate": 'Bearer realm="roster"',
    });
  }
  const rl = await rateLimit(`api:key:${principal.keyId}`, RATE_LIMIT_PER_MIN, 60);
  const rateHeaders = {
    "X-RateLimit-Limit": String(RATE_LIMIT_PER_MIN),
    "X-RateLimit-Remaining": String(rl.remaining),
    "X-RateLimit-Reset": String(Math.ceil(rl.resetAt.getTime() / 1000)),
  };
  if (!rl.ok) {
    const retry = Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000));
    throw new ApiError("rate_limited", "Rate limit exceeded. Slow down and retry.", undefined, {
      ...rateHeaders,
      "Retry-After": String(retry),
    });
  }
  return { principal, rateHeaders };
}

export function requireScope(p: ApiPrincipal, scope: ApiScope) {
  if (!hasScope(p, scope)) throw new ApiError("insufficient_scope", `This API key is missing the "${scope}" scope.`);
}

/**
 * Wrap a v1 route handler: auth, scope, rate limit, consistent errors.
 */
export function apiRoute<Ctx>(
  scope: ApiScope,
  handler: (args: { req: Request; principal: ApiPrincipal; ctx: Ctx }) => Promise<{ status?: number; body: unknown }>,
) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    let rateHeaders: Record<string, string> = {};
    try {
      const auth = await authenticate(req);
      rateHeaders = auth.rateHeaders;
      requireScope(auth.principal, scope);
      const out = await handler({ req, principal: auth.principal, ctx });
      return json(out.body, { status: out.status ?? 200, headers: rateHeaders });
    } catch (err) {
      const res = toErrorResponse(err);
      for (const [k, v] of Object.entries(rateHeaders)) if (!res.headers.has(k)) res.headers.set(k, v);
      return res;
    }
  };
}

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const text = await readTextCapped(req, maxBytes);
  if (text === null) throw new ApiError("invalid_request", "Request body too large.");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("invalid_request", "Request body must be valid JSON.");
  }
}

export function parseWith<T extends z.ZodType>(schemaDef: T, input: unknown): z.infer<T> {
  const r = schemaDef.safeParse(input);
  if (!r.success) {
    throw new ApiError(
      "invalid_request",
      r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "body"}: ${r.error.issues[0].message}` : "Invalid request",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

// ── Cursor pagination (createdAt desc, id desc) ──────────────────────────────

const cursorShape = z.object({ t: z.iso.datetime({ offset: true }), id: z.uuid() });
export type Cursor = z.infer<typeof cursorShape>;

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 200) throw new Error("too long");
    const parsed = cursorShape.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed;
  } catch {
    throw new ApiError("invalid_request", "Invalid cursor.");
  }
}

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export function searchParams(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

export function uuidParam(v: string | undefined): string {
  const r = z.uuid().safeParse(v);
  // Malformed ids are indistinguishable from missing ones.
  if (!r.success) throw new ApiError("not_found", "Not found.");
  return r.data;
}
