/**
 * AI employees ("agents"), what they know, what they do, and what they deliver.
 *
 * The agent stack (from the product brief):
 *   memory · knowledge base · its own email inbox · a computer/runtime · channels
 * and the work: workflows (proactive, scheduled or event-driven) → runs → deliverables.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, organizations, updatedAt, users } from "./core";

/** pgvector column (1024 dims; Voyage voyage-3 compatible). Optional: retrieval falls back to FTS. */
export const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map(Number);
  },
});

export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export type ChannelKind = "email" | "sms" | "slack" | "api" | "mcp" | "portal";

export type AgentConfig = {
  /** Model tier the agent runs on. */
  modelTier?: "smart" | "fast";
  /** Tools the agent may use (ids from the tool registry). */
  tools?: string[];
  /** Actions that need a human to approve first (e.g. "send_external_email"). */
  requireApprovalFor?: string[];
  /** Where proactive deliverables go by default. */
  defaultDelivery?: ChannelKind[];
  /** Quiet hours in the org timezone, e.g. { start: "20:00", end: "07:00" }. */
  quietHours?: { start: string; end: string };
  /** Working style notes surfaced to the model. */
  voice?: string;
  /** Monthly cost guardrail in cents (internal; never shown to clients). */
  monthlyBudgetCents?: number;
  /**
   * Let the agent answer senders it cannot verify as members (customers, strangers) without a human approving each
   * reply. Default false. Replies on email/SMS still need approval while send_external_* is in requireApprovalFor.
   */
  autoReplyUnknownSenders?: boolean;
  /**
   * Outside senders whose replies go out without approval: exact addresses ("buyer@acme.com"), whole domains
   * ("@acme.com") or E.164 numbers. They still get the restricted, untrusted tool set.
   */
  replyAllowlist?: string[];
  /** Spend guard: at most this many inbound-message runs per hour (default 60); extra messages are stored, not run. */
  inboundRunsPerHour?: number;
  /** Spend guard: share of monthlyBudgetCents that inbound-message runs may use (default 0.5). */
  inboundBudgetShare?: number;
};

export const blueprints = pgTable(
  "blueprints",
  {
    id: id(),
    /** Agency that owns this reusable template. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    vertical: text("vertical"),
    summary: text("summary"),
    /** A full agent spec (same shape the Architect produces). */
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("blueprints_org_idx").on(t.orgId)],
);

export const agents = pgTable(
  "agents",
  {
    id: id(),
    /** The client (or customer) org this agent works for. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    blueprintId: uuid("blueprint_id").references(() => blueprints.id, { onDelete: "set null" }),
    /** When a client resells an agent to a customer, the source agent it was cloned from. */
    sourceAgentId: uuid("source_agent_id"),
    name: text("name").notNull(),
    /** Job title, e.g. "Quoting Specialist". */
    role: text("role").notNull(),
    avatarSeed: text("avatar_seed"),
    /** One-line description of the job, client facing. */
    summary: text("summary"),
    /** System instructions (the job description the model follows). */
    instructions: text("instructions").notNull(),
    status: text("status", { enum: ["draft", "provisioning", "active", "paused", "archived"] })
      .notNull()
      .default("draft"),
    /** Local part of the agent's own inbox: <handle>@<EMAIL_DOMAIN>. */
    emailHandle: text("email_handle"),
    phoneNumber: text("phone_number"),
    config: jsonb("config").$type<AgentConfig>().notNull().default({}),
    /** External computer/runtime id (e.g. Orgo computer id). */
    computerId: text("computer_id"),
    computerStatus: text("computer_status", { enum: ["none", "starting", "ready", "error"] })
      .notNull()
      .default("none"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    /** Denormalized by the `deliverables_after_insert` trigger (migration 0004): newest deliverable's created_at. */
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    /** Denormalized by the same trigger: lifetime deliverable count. Never write these from app code. */
    deliveredCount: integer("delivered_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("agents_org_idx").on(t.orgId),
    index("agents_blueprint_idx").on(t.blueprintId).where(sql`${t.blueprintId} is not null`),
    uniqueIndex("agents_email_handle_uq").on(t.emailHandle),
    uniqueIndex("agents_phone_uq").on(t.phoneNumber),
  ],
);

/** Discovery call → agent. The Architect reads a transcript and proposes an agent. */
export const discoveries = pgTable(
  "discoveries",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    transcript: text("transcript").notNull(),
    status: text("status", { enum: ["pending", "analyzing", "ready", "failed", "hired"] })
      .notNull()
      .default("pending"),
    /** The Architect's structured proposal (AgentSpec). */
    proposal: jsonb("proposal").$type<Record<string, unknown>>(),
    error: text("error"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("discoveries_org_idx").on(t.orgId)],
);

export type WorkflowTrigger =
  | { type: "schedule"; cron: string; timezone?: string }
  | { type: "event"; event: "email.received" | "sms.received" | "slack.message" | "webhook" | "deliverable.approved" }
  | { type: "manual" };

export const workflows = pgTable(
  "workflows",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** What the agent should do, in plain language (the "itch" turned into a procedure). */
    instructions: text("instructions").notNull(),
    trigger: jsonb("trigger").$type<WorkflowTrigger>().notNull(),
    /** What it produces: report | document | table | email_draft | message | action */
    outputKind: text("output_kind").notNull().default("report"),
    deliverTo: jsonb("deliver_to").$type<ChannelKind[]>().notNull().default(["portal"]),
    /** Estimated human hours saved per run (drives the value dashboard). */
    hoursSavedPerRun: real("hours_saved_per_run").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflows_agent_idx").on(t.agentId),
    index("workflows_org_idx").on(t.orgId),
    index("workflows_due_idx").on(t.nextRunAt).where(sql`${t.enabled} = true`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id"),
    trigger: text("trigger", { enum: ["schedule", "event", "manual", "message", "api", "setup"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "waiting_approval", "succeeded", "failed", "canceled"] })
      .notNull()
      .default("queued"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    /** Short human summary of what happened. */
    summary: text("summary"),
    error: text("error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Internal cost in micro-dollars (1e-6 USD). Never shown to clients. */
    costMicros: integer("cost_micros").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("runs_agent_created_idx").on(t.agentId, t.createdAt),
    index("runs_org_created_idx").on(t.orgId, t.createdAt),
    index("runs_conversation_idx").on(t.conversationId),
    index("runs_workflow_idx").on(t.workflowId).where(sql`${t.workflowId} is not null`),
  ],
);

/** Step-by-step trace of a run (model turns, tool calls, results). */
export const runSteps = pgTable(
  "run_steps",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: ["thought", "tool_call", "tool_result", "message", "error"] }).notNull(),
    name: text("name"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("run_steps_run_seq_uq").on(t.runId, t.seq),
    // One durable outcome per tool call: the runtime replays it on resume instead of repeating the side effect.
    uniqueIndex("run_steps_tool_result_uq").on(t.runId, sql`(${t.data}->>'toolUseId')`).where(sql`${t.kind} = 'tool_result'`),
  ],
);

export const deliverables = pgTable(
  "deliverables",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** report | document | table | email_draft | message */
    kind: text("kind").notNull().default("report"),
    /** One-sentence preview for cards and notifications. */
    preview: text("preview"),
    /** Markdown body. Tables use GFM. */
    body: text("body").notNull(),
    /** Structured payload (e.g. rows for a table, draft email fields). */
    data: jsonb("data").$type<Record<string, unknown>>(),
    status: text("status", { enum: ["new", "seen", "approved", "changes_requested", "archived"] })
      .notNull()
      .default("new"),
    needsReview: boolean("needs_review").notNull().default(false),
    deliveredVia: jsonb("delivered_via").$type<ChannelKind[]>().notNull().default([]),
    hoursSaved: real("hours_saved").notNull().default(0),
    feedback: text("feedback"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    /** The org's agency (organizations.agency_id), set by the `deliverables_before_insert` trigger. Agency-wide reads use it. */
    agencyId: uuid("agency_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("deliverables_agent_created_idx").on(t.agentId, t.createdAt),
    index("deliverables_run_idx").on(t.runId),
    // Ascending on purpose: scanned backward they serve `order by created_at desc, id desc` (NULLS FIRST, the SQL
    // default). A drizzle `.desc()` column is DESC NULLS LAST and would NOT match that order by.
    // Keyset pages: `where org_id = $1 and (created_at, id) < ($t, $id) order by created_at desc, id desc`.
    // Also replaces the old (org_id, created_at) index for every prefix use.
    index("deliverables_org_created_id_idx").on(t.orgId, t.createdAt, t.id),
    index("deliverables_agency_created_idx").on(t.agencyId, t.createdAt),
    index("deliverables_agency_changes_idx").on(t.agencyId, t.createdAt).where(sql`${t.status} = 'changes_requested'`),
    index("deliverables_review_idx").on(t.orgId).where(sql`${t.needsReview} and ${t.status} in ('new','seen')`),
    index("deliverables_workflow_idx").on(t.workflowId).where(sql`${t.workflowId} is not null`),
  ],
);

/** Human-in-the-loop: risky actions wait for a person. */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    /** Human readable description of what will happen. */
    description: text("description").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] }).notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_org_status_idx").on(t.orgId, t.status),
    // Expiry sweep (scheduler.expireApprovals) scans only pending rows by age.
    index("approvals_pending_created_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
    index("approvals_run_idx").on(t.runId),
    index("approvals_agent_idx").on(t.agentId),
  ],
);

/** Short- and long-term memory. Facts and preferences the agent learned. */
export const memories = pgTable(
  "memories",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["fact", "preference", "person", "episode"] }).notNull().default("fact"),
    content: text("content").notNull(),
    /** 1–5, used for recall ranking and pruning. */
    importance: integer("importance").notNull().default(3),
    source: text("source"),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', content)`),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("memories_agent_idx").on(t.agentId), index("memories_tsv_idx").using("gin", t.tsv)],
);

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null = shared with every agent in the org. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind", { enum: ["text", "url", "file", "transcript"] }).notNull(),
    uri: text("uri"),
    status: text("status", { enum: ["pending", "indexing", "ready", "failed"] }).notNull().default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("knowledge_sources_org_idx").on(t.orgId), index("knowledge_sources_agent_idx").on(t.agentId)],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    seq: integer("seq").notNull(),
    content: text("content").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', content)`),
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("knowledge_chunks_source_idx").on(t.sourceId),
    index("knowledge_chunks_org_agent_idx").on(t.orgId, t.agentId),
    index("knowledge_chunks_tsv_idx").using("gin", t.tsv),
  ],
);
