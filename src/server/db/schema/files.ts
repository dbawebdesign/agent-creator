/**
 * Uploaded originals (knowledge uploads, inbound email attachments).
 *
 * Bytes live in Postgres (`data`, bytea) for now. `storage` + `storageKey` are the seam for moving
 * originals to S3 later: write the object, set storage = "s3", storageKey = key, data = null.
 */
import { customType, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agents, knowledgeSources } from "./agents";
import { createdAt, id, organizations, updatedAt, users } from "./core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const files = pgTable(
  "files",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Original filename (sanitized, ≤200 chars). */
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    /** Hex sha256 of the original bytes. */
    sha256: text("sha256").notNull(),
    storage: text("storage", { enum: ["db", "s3"] }).notNull().default("db"),
    data: bytea("data"),
    storageKey: text("storage_key"),
    source: text("source", { enum: ["upload", "email"] }).notNull(),
    /** Where it came from: the inbound message id for email attachments. */
    sourceRef: text("source_ref"),
    /** The knowledge source built from this file's text, when it was indexed. */
    knowledgeSourceId: uuid("knowledge_source_id").references(() => knowledgeSources.id, { onDelete: "set null" }),
    /** stored = kept but not indexed (e.g. untrusted sender); indexed = sent to the knowledge base. */
    status: text("status", { enum: ["stored", "indexed", "failed"] }).notNull().default("stored"),
    error: text("error"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("files_org_idx").on(t.orgId, t.createdAt),
    index("files_org_sha_idx").on(t.orgId, t.sha256),
    index("files_source_ref_idx").on(t.sourceRef),
  ],
);
