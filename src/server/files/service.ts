/**
 * File ingestion: store the original, extract text, and (when allowed) add it to the knowledge base.
 *
 * Used by the upload route (POST /api/orgs/[orgId]/knowledge/upload) and by inbound email
 * attachments. Callers decide `index`: uploads by members always index; email attachments index only
 * for trusted senders (DMARC/SPF pass + member or known contact). Untrusted files are stored, never indexed.
 */
import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";
import * as engine from "@/server/services/engine";
import { extractText, FILE_TYPES, FileError, fileKind, safeFileName, UPLOAD_MAX_BYTES, type FileKind } from "./extract";

export { FileError } from "./extract";

export type StoredFile = typeof schema.files.$inferSelect;

export type IngestFileInput = {
  orgId: string;
  agentId?: string | null;
  name: string;
  bytes: Buffer;
  source: "upload" | "email";
  sourceRef?: string | null;
  /** Add the extracted text to the knowledge base (false = keep the original only). */
  index: boolean;
  actor: engine.Actor;
  ip?: string | null;
  meta?: Record<string, unknown>;
};

export type IngestFileResult = {
  fileId: string;
  name: string;
  kind: FileKind | null;
  size: number;
  status: StoredFile["status"];
  knowledgeSourceId: string | null;
  /** Characters of text sent to the knowledge base. */
  chars: number;
  truncated: boolean;
  /** Same bytes were already indexed for this agent/org: nothing new was added. */
  duplicate: boolean;
  error: string | null;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Where bytes go. Today: the `files.data` bytea column. To move to S3, write the object here and return
 * { storage: "s3", storageKey, data: null }; `readFileBytes` is the matching read path.
 */
function placeBytes(bytes: Buffer): Pick<StoredFile, "storage" | "storageKey" | "data"> {
  return { storage: "db", storageKey: null, data: bytes };
}

export async function readFileBytes(orgId: string, fileId: string): Promise<{ file: Omit<StoredFile, "data">; bytes: Buffer } | null> {
  const rows = await db()
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.id, fileId), eq(schema.files.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.storage !== "db" || !row.data) return null;
  const { data, ...file } = row;
  return { file, bytes: data };
}

export async function listFiles(orgId: string, opts: { agentId?: string | null; limit?: number } = {}) {
  const where = [eq(schema.files.orgId, orgId)];
  if (opts.agentId) where.push(eq(schema.files.agentId, opts.agentId));
  return db()
    .select({
      id: schema.files.id,
      name: schema.files.name,
      mime: schema.files.mime,
      size: schema.files.size,
      source: schema.files.source,
      status: schema.files.status,
      error: schema.files.error,
      agentId: schema.files.agentId,
      knowledgeSourceId: schema.files.knowledgeSourceId,
      createdAt: schema.files.createdAt,
    })
    .from(schema.files)
    .where(and(...where))
    .orderBy(desc(schema.files.createdAt))
    .limit(Math.min(200, Math.max(1, opts.limit ?? 50)));
}

function actorUserId(actor: engine.Actor): string | null {
  return actor.type === "user" ? actor.userId : null;
}

/**
 * Store + extract + index. Throws FileError for an unsupported, oversized or unreadable *upload*
 * (nothing is stored). For email attachments (`source: "email"`) unreadable files are still stored with
 * status "failed" so the original is kept; this never throws for them except on database errors.
 */
export async function ingestFile(input: IngestFileInput): Promise<IngestFileResult> {
  const name = safeFileName(input.name);
  const kind = fileKind(name);
  const size = input.bytes.length;
  const sha = sha256Hex(input.bytes);
  const strict = input.source === "upload";
  if (size > UPLOAD_MAX_BYTES) {
    if (strict) throw new FileError("Files can be up to 10 MB.", 413);
  }
  if (size === 0 && strict) throw new FileError("That file is empty.", 400);
  if (!kind && strict) throw new FileError("That file type isn't supported. Use CSV, TSV, TXT, Markdown, JSON, HTML, PDF or DOCX.", 415);

  // Re-uploading the same bytes for the same agent shouldn't index them twice.
  if (input.index && kind) {
    const dup = await db()
      .select({ id: schema.files.id, knowledgeSourceId: schema.files.knowledgeSourceId })
      .from(schema.files)
      .innerJoin(schema.knowledgeSources, eq(schema.knowledgeSources.id, schema.files.knowledgeSourceId))
      .where(
        and(
          eq(schema.files.orgId, input.orgId),
          eq(schema.files.sha256, sha),
          input.agentId ? eq(schema.files.agentId, input.agentId) : isNull(schema.files.agentId),
          eq(schema.files.status, "indexed"),
          isNotNull(schema.files.knowledgeSourceId),
        ),
      )
      .limit(1);
    if (dup[0]) {
      return { fileId: dup[0].id, name, kind, size, status: "indexed", knowledgeSourceId: dup[0].knowledgeSourceId, chars: 0, truncated: false, duplicate: true, error: null };
    }
  }

  let text = "";
  let truncated = false;
  let extractMeta: Record<string, unknown> = {};
  let error: string | null = null;
  if (!kind) error = "Unsupported file type";
  else if (size > UPLOAD_MAX_BYTES) error = "File is over 10 MB";
  else {
    try {
      const out = await extractText(kind, name, input.bytes);
      text = out.text;
      truncated = out.truncated;
      extractMeta = out.meta;
    } catch (err) {
      if (strict && err instanceof FileError) throw err;
      error = err instanceof FileError ? err.message : "Couldn't read the file";
      if (!(err instanceof FileError)) logger.warn({ err: err instanceof Error ? err.name : "unknown", kind }, "file extraction failed");
    }
  }

  const mime = kind ? FILE_TYPES[kind].mime : "application/octet-stream";
  const [row] = await db()
    .insert(schema.files)
    .values({
      orgId: input.orgId,
      agentId: input.agentId ?? null,
      name,
      mime,
      size,
      sha256: sha,
      ...placeBytes(input.bytes),
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      status: error ? "failed" : "stored",
      error,
      meta: { ...input.meta, ...extractMeta, ...(truncated ? { truncated: true } : {}) },
      uploadedBy: actorUserId(input.actor),
    })
    .returning({ id: schema.files.id });
  const fileId = row!.id;

  let knowledgeSourceId: string | null = null;
  let status: StoredFile["status"] = error ? "failed" : "stored";
  if (input.index && !error && text) {
    try {
      ({ sourceId: knowledgeSourceId } = await engine.addKnowledge({
        orgId: input.orgId,
        agentId: input.agentId ?? null,
        title: name,
        kind: "text",
        content: text,
        actor: input.actor,
      }));
      status = "indexed";
      await db().update(schema.files).set({ status, knowledgeSourceId }).where(and(eq(schema.files.id, fileId), eq(schema.files.orgId, input.orgId)));
    } catch (err) {
      error = "Couldn't add the file to the knowledge base";
      status = "failed";
      await db().update(schema.files).set({ status, error }).where(and(eq(schema.files.id, fileId), eq(schema.files.orgId, input.orgId)));
      if (strict) {
        // Don't keep an upload the person was told failed.
        await db().delete(schema.files).where(and(eq(schema.files.id, fileId), eq(schema.files.orgId, input.orgId)));
        throw err;
      }
      logger.warn({ err: err instanceof Error ? err.name : "unknown" }, "attachment indexing failed");
    }
  }

  await audit({
    orgId: input.orgId,
    actorType: input.actor.type === "user" ? "user" : input.actor.type === "api_key" ? "api_key" : "system",
    actorId: input.actor.type === "user" ? input.actor.userId : input.actor.type === "api_key" ? input.actor.keyId : null,
    action: input.source === "upload" ? "file.uploaded" : "file.received",
    targetType: "file",
    targetId: fileId,
    metadata: { kind, size, indexed: status === "indexed", agentId: input.agentId ?? null },
    ip: input.ip ?? null,
  });

  return { fileId, name, kind, size, status, knowledgeSourceId, chars: text.length, truncated, duplicate: false, error };
}
