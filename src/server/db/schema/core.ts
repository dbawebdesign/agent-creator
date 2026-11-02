/**
 * Core tenancy, identity and access.
 *
 * Tenancy is a tree of organizations:
 *   agency  (the operator who builds and sells AI employees, e.g. AJ)
 *     └─ client    (a business that buys AI employees from the agency)
 *          └─ customer (a business the client resells an agent to — B2B2B)
 *
 * Every tenant-owned row carries `org_id`. Access checks resolve a user's
 * membership in the org or any ancestor (agency staff can see their clients).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const orgKind = pgEnum("org_kind", ["agency", "client", "customer"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member", "viewer"]);

export type Branding = {
  /** Display name shown in the portal header and emails. */
  displayName?: string;
  /** Hex accent color, e.g. "#4F46E5". */
  accent?: string;
  logoUrl?: string;
  /** Sender name for outbound agent email, e.g. "Brandlord". */
  emailFromName?: string;
  /** Hide all "Powered by Roster" marks (agency plan feature). */
  whiteLabel?: boolean;
};

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    parentId: uuid("parent_id"),
    /** Agency at the root of this org's tree (self for agencies). Denormalized for fast scoping. */
    agencyId: uuid("agency_id"),
    kind: orgKind("kind").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    industry: text("industry"),
    website: text("website"),
    timezone: text("timezone").notNull().default("America/New_York"),
    branding: jsonb("branding").$type<Branding>().notNull().default({}),
    customDomain: text("custom_domain"),
    status: text("status", { enum: ["active", "trial", "paused", "churned"] }).notNull().default("active"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("organizations_slug_uq").on(t.slug),
    uniqueIndex("organizations_custom_domain_uq").on(t.customDomain),
    index("organizations_parent_idx").on(t.parentId),
    index("organizations_agency_idx").on(t.agencyId),
  ],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    /** scrypt hash: scrypt$N$r$p$salt$hash (base64). Null for magic-link/SSO-only users. */
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    phone: text("phone"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_user_org_uq").on(t.userId, t.orgId), index("memberships_org_idx").on(t.orgId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invitations_token_uq").on(t.tokenHash), index("invitations_org_idx").on(t.orgId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 of the opaque session token; the raw token only lives in the cookie. */
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/** Single-use tokens: magic links, email verification, password reset. */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    email: text("email").notNull(),
    purpose: text("purpose", { enum: ["magic_link", "verify_email", "reset_password"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_tokens_token_uq").on(t.tokenHash)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Optional: restrict the key to a single agent. */
    agentId: uuid("agent_id"),
    name: text("name").notNull(),
    /** First 12 chars of the key, e.g. "rk_live_ab12", shown in UI for identification. */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["agents:read", "agents:invoke"]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_org_idx").on(t.orgId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: uuid("org_id"),
    actorType: text("actor_type", { enum: ["user", "agent", "api_key", "system"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.orgId, t.createdAt)],
);

/** Encrypted credentials for integrations (client CRM keys, Slack bot tokens, etc). */
export const secrets = pgTable(
  "secrets",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** AES-256-GCM: v1.<iv>.<tag>.<ciphertext> base64url */
    ciphertext: text("ciphertext").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("secrets_org_name_uq").on(t.orgId, t.name)],
);

/** Flat-rate plans an agency sells to its clients (and clients to their customers). */
export const plans = pgTable(
  "plans",
  {
    id: id(),
    /** The seller org (agency, or client reselling to customers). */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Monthly price in cents, flat. No token billing, no setup fee by default. */
    priceCents: integer("price_cents").notNull(),
    setupFeeCents: integer("setup_fee_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    stripePriceId: text("stripe_price_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("plans_org_idx").on(t.orgId)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    /** The buyer org. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["trialing", "active", "past_due", "canceled"] }).notNull().default("active"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("subscriptions_org_idx").on(t.orgId)],
);
