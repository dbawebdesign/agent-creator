/**
 * Channels and conversations. Agents meet people where they already are:
 * email, SMS, Slack, the web portal, the REST API and MCP.
 */
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents, type ChannelKind } from "./agents";
import { createdAt, id, organizations, updatedAt, users } from "./core";

/** A configured channel for an org (and optionally pinned to one agent). */
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ChannelKind>().notNull(),
    /** Routing key for inbound traffic: Slack team id, Twilio number, email handle, etc. */
    externalId: text("external_id"),
    /** Non-secret settings (channel ids, display names). Secrets live in `secrets`. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secretId: uuid("secret_id"),
    status: text("status", { enum: ["pending", "connected", "error", "disabled"] }).notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("channel_connections_org_idx").on(t.orgId),
    uniqueIndex("channel_connections_kind_external_uq").on(t.kind, t.externalId),
  ],
);

/** People the agent talks to who are not platform users (the client's staff or customers). */
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    slackUserId: text("slack_user_id"),
    /** Whether the agent may proactively message this contact. */
    allowProactive: text("allow_proactive", { enum: ["yes", "no"] }).notNull().default("yes"),
    createdAt: createdAt(),
  },
  (t) => [index("contacts_org_idx").on(t.orgId)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").$type<ChannelKind>().notNull(),
    /** Email thread id / Slack thread_ts / phone number — used to continue threads. */
    externalThreadId: text("external_thread_id"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    subject: text("subject"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("conversations_agent_last_idx").on(t.agentId, t.lastMessageAt),
    uniqueIndex("conversations_thread_uq").on(t.agentId, t.channel, t.externalThreadId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    /** "agent" | "user" | "contact" | "system" */
    author: text("author", { enum: ["agent", "user", "contact", "system"] }).notNull(),
    body: text("body").notNull(),
    /** Provider message id for idempotent ingestion (Resend id, Twilio SID, Slack ts). */
    externalId: text("external_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    deliveryStatus: text("delivery_status", { enum: ["pending", "sent", "delivered", "failed", "received"] })
      .notNull()
      .default("pending"),
    runId: uuid("run_id"),
    deliverableId: uuid("deliverable_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_external_uq").on(t.orgId, t.externalId),
  ],
);

/** Inbound webhook receipts for idempotency and debugging. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("webhook_events_provider_external_uq").on(t.provider, t.externalId)],
);
