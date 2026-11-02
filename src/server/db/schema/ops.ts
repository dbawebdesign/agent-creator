/**
 * Operational tables: the durable job queue, usage metering, notifications.
 *
 * The queue is Postgres-native (FOR UPDATE SKIP LOCKED), so it scales horizontally
 * with any number of workers and needs no extra infrastructure on day one.
 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, organizations, users } from "./core";

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    queue: text("queue").notNull().default("default"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    orgId: uuid("org_id"),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "dead"] }).notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    /** Dedupe key: at most one queued/running job per key. */
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_ready_idx").on(t.queue, t.priority, t.runAt).where(sql`${t.status} = 'queued'`),
    index("jobs_locked_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    uniqueIndex("jobs_idempotency_uq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null and ${t.status} in ('queued','running')`),
  ],
);

/** Per-run AI/infra usage for the agency's margin view. Never exposed to clients. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agencyId: uuid("agency_id"),
    agentId: uuid("agent_id"),
    runId: uuid("run_id"),
    kind: text("kind", { enum: ["llm", "email", "sms", "computer", "embedding"] }).notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    quantity: integer("quantity").notNull().default(1),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_events_org_created_idx").on(t.orgId, t.createdAt),
    index("usage_events_agency_created_idx").on(t.agencyId, t.createdAt),
  ],
);

/** In-app notifications ("Maya delivered the Monday pipeline report"). */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)],
);
