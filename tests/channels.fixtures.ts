/**
 * Shared fixtures for channels/api tests. Each test file creates its own orgs with random slugs and deletes them
 * afterwards (cascade), so it never clobbers data from other test suites sharing roster_test.
 */
import { randomBytes } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db/client";

export const TEST_ENV = {
  APP_URL: "https://app.roster.test",
  EMAIL_DOMAIN: "agents.roster.test",
  RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("resend-test-signing-secret-0123456789").toString("base64")}`,
  TWILIO_AUTH_TOKEN: "twilio-test-auth-token",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  SLACK_SIGNING_SECRET: "slack-test-signing-secret",
  EMAIL_AUTHSERV_ID: "mx.resend.com",
};

export function applyTestEnv(extra: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries({ ...TEST_ENV, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const created: string[] = [];

export function rid(n = 6) {
  return randomBytes(n).toString("hex");
}

export async function makeOrg(opts: { name?: string; branding?: Record<string, unknown>; kind?: "agency" | "client" | "customer"; parentId?: string } = {}) {
  const slug = `t-${rid()}`;
  const [org] = await db()
    .insert(schema.organizations)
    .values({ kind: opts.kind ?? "client", name: opts.name ?? `Org ${slug}`, slug, branding: opts.branding ?? {}, parentId: opts.parentId ?? null })
    .returning();
  created.push(org!.id);
  return org!;
}

export async function makeAgent(orgId: string, opts: { name?: string; status?: "active" | "paused" | "archived" | "draft"; phone?: string | null } = {}) {
  const handle = `maya-${rid(4)}`;
  const [agent] = await db()
    .insert(schema.agents)
    .values({
      orgId,
      name: opts.name ?? "Maya",
      role: "Quoting Specialist",
      instructions: "Prepare quotes for promotional products.",
      status: opts.status ?? "active",
      emailHandle: handle,
      phoneNumber: opts.phone ?? null,
    })
    .returning();
  return agent!;
}

export async function makeWorkflow(orgId: string, agentId: string, enabled = true) {
  const [wf] = await db()
    .insert(schema.workflows)
    .values({ orgId, agentId, name: "Monday pipeline report", instructions: "Summarize the pipeline every Monday.", trigger: { type: "manual" }, enabled })
    .returning();
  return wf!;
}

export async function makeDeliverable(orgId: string, agentId: string, title = "Pipeline report", createdAt?: Date) {
  const [d] = await db()
    .insert(schema.deliverables)
    .values({
      orgId,
      agentId,
      title,
      preview: "Three quotes are waiting on approval.",
      body: "# Pipeline\n\n**3 quotes** pending. See [the sheet](https://example.com/sheet).\n\n<script>alert(1)</script>\n\n| Client | Value |\n|---|---|\n| Acme | $4,000 |",
      createdAt: createdAt ?? new Date(),
    })
    .returning();
  return d!;
}

export async function cleanupOrgs() {
  if (!created.length) return;
  const ids = created.splice(0);
  await db().delete(schema.jobs).where(inArray(schema.jobs.orgId, ids));
  await db().delete(schema.auditLogs).where(inArray(schema.auditLogs.orgId, ids));
  await db().delete(schema.organizations).where(inArray(schema.organizations.id, ids));
}

/** Tables owned by this slice; safe to truncate between tests. */
export async function truncateChannelTables() {
  await db().execute(sql`truncate table webhook_events`);
  await db().execute(sql`delete from jobs where type = 'inbound.process'`);
  await db().execute(sql`create unlogged table if not exists rate_limits (key text primary key, count integer not null, reset_at timestamptz not null)`);
  await db().execute(sql`delete from rate_limits where key like 'api:key:%' or key like 'api:invoke:%' or key like 'inbound:%'`);
}
