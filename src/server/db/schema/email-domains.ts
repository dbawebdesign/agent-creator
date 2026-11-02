/**
 * White-label email domains. An agency (or a reselling client) sends and receives agent mail on its own
 * domain, e.g. maya@agents.northbeam.ai, once the domain is verified. Agents use the nearest verified
 * domain up their org chain (customer → client → agency), else env EMAIL_DOMAIN.
 */
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, organizations, updatedAt } from "./core";

export type DnsRecord = { record: string; name: string; type: string; value: string; ttl?: string; priority?: number; status?: string };

export const emailDomains = pgTable(
  "email_domains",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lowercase hostname, e.g. "agents.northbeam.ai". Several orgs may CLAIM it (pending); only one can hold it verified. */
    domain: text("domain").notNull(),
    status: text("status", { enum: ["pending", "verified", "failed"] }).notNull().default("pending"),
    /** Resend domain id when verification runs through Resend; null in simulated (dev) mode. */
    providerId: text("provider_id"),
    /** DNS records to publish (from Resend). */
    records: jsonb("records").$type<DnsRecord[]>().notNull().default([]),
    simulated: boolean("simulated").notNull().default(false),
    /** Per-claim ownership token, published as TXT `_roster-verify.<domain>` = `roster-verify=<token>`. */
    token: text("token"),
    /** Pending claims lapse after this (so a squatter can't hold a domain forever). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Why it isn't verified yet, in plain words ("Connect email sending to verify"). */
    note: text("note"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("email_domains_org_uq").on(t.orgId),
    // Only one org can hold a domain VERIFIED; pending claims don't block anyone.
    uniqueIndex("email_domains_verified_domain_uq").on(t.domain).where(sql`status = 'verified'`),
    index("email_domains_domain_idx").on(t.domain),
    index("email_domains_status_idx").on(t.status),
  ],
);
