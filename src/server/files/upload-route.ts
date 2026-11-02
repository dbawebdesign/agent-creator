/**
 * POST /api/orgs/[orgId]/knowledge/upload — multipart upload of one file (field "file", optional
 * "agentId") into the org's knowledge base. Session auth, member or above; 404 when there's no access.
 *
 * Response 201: { file: { id, name, kind, size, status, knowledgeSourceId, chars, truncated, duplicate } }
 * Errors: { error: { code, message } } with 400/401/404/413/415/422/429.
 */
import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { readBytesCapped } from "@/server/api/body";
import { errorResponse, type ErrorCode } from "@/server/api/http";
import { hasRole, resolveAccess } from "@/server/auth/access";
import { clientIp, getCurrentUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { rateLimit } from "@/server/security/rate-limit";
import { UPLOAD_MAX_BYTES } from "./extract";
import { FileError, ingestFile } from "./service";

/** Multipart framing on top of the 10 MB file. */
const BODY_MAX = UPLOAD_MAX_BYTES + 64 * 1024;
export const UPLOADS_PER_HOUR = 60;

const FILE_ERROR_CODES: Record<FileError["status"], ErrorCode> = {
  400: "invalid_request",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable",
};

/** Cross-site form posts are blocked by SameSite=Lax already; this also refuses scripted cross-origin posts. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser client; the session cookie is still required
  try {
    const o = new URL(origin).origin;
    if (o === new URL(env().APP_URL).origin) return true;
    return o === new URL(req.url).origin;
  } catch {
    return false;
  }
}

export async function handleKnowledgeUpload(req: Request, orgId: string): Promise<Response> {
  if (!z.uuid().safeParse(orgId).success) return errorResponse("not_found", "Not found");
  if (!sameOrigin(req)) return errorResponse("not_found", "Not found");
  const user = await getCurrentUser();
  if (!user) return errorResponse("unauthorized", "Sign in to upload files.");
  const access = await resolveAccess(user, orgId);
  if (!access || !hasRole(access, "member")) return errorResponse("not_found", "Not found");

  const rl = await rateLimit(`upload:${user.id}`, UPLOADS_PER_HOUR, 3600);
  if (!rl.ok) return errorResponse("rate_limited", "Too many uploads. Try again later.", { headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } });

  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) return errorResponse("unsupported_media_type", "Send the file as multipart/form-data.");
  const raw = await readBytesCapped(req.body, BODY_MAX, req.headers.get("content-length"));
  if (raw === null) return errorResponse("payload_too_large", "Files can be up to 10 MB.");

  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), { headers: { "content-type": type } }).formData();
  } catch {
    return errorResponse("invalid_request", "Couldn't read the upload. Try again.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return errorResponse("invalid_request", 'Attach a file in the "file" field.');
  if (form.getAll("file").length > 1) return errorResponse("invalid_request", "Upload one file at a time.");

  const agentRaw = form.get("agentId");
  let agentId: string | null = null;
  if (typeof agentRaw === "string" && agentRaw !== "") {
    if (!z.uuid().safeParse(agentRaw).success) return errorResponse("not_found", "Agent not found");
    const rows = await db()
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentRaw), eq(schema.agents.orgId, orgId)))
      .limit(1);
    if (!rows[0]) return errorResponse("not_found", "Agent not found");
    agentId = rows[0].id;
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const res = await ingestFile({
      orgId,
      agentId,
      name: file.name,
      bytes,
      source: "upload",
      index: true,
      actor: { type: "user", userId: user.id },
      ip: clientIp(req.headers),
    });
    return Response.json({ file: { id: res.fileId, name: res.name, kind: res.kind, size: res.size, status: res.status, knowledgeSourceId: res.knowledgeSourceId, chars: res.chars, truncated: res.truncated, duplicate: res.duplicate } }, { status: res.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof FileError) return errorResponse(FILE_ERROR_CODES[err.status], err.message);
    if (err instanceof Error && err.name === "EngineInputError") return errorResponse("unprocessable", "That file couldn't be added to the knowledge base.");
    if (err instanceof Error && err.name === "EngineNotFoundError") return errorResponse("not_found", "Not found");
    logger.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, "knowledge upload failed");
    return errorResponse("internal_error", "Upload failed. Try again.");
  }
}
