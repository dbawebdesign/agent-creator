/** Shared helpers for engine tests (not a test file). */
import { sql } from "drizzle-orm";
import { db, schema } from "@/server/db/client";

export async function resetDb() {
  await db().execute(sql`truncate table organizations, users, jobs, audit_logs, webhook_events restart identity cascade`);
}

let n = 0;
export async function makeOrgs(opts: { timezone?: string; clientName?: string; industry?: string } = {}) {
  n++;
  const [agency] = await db()
    .insert(schema.organizations)
    .values({ kind: "agency", name: `Agency ${n}`, slug: `agency-${n}-${Date.now()}` })
    .returning();
  await db().update(schema.organizations).set({ agencyId: agency!.id }).where(sql`id = ${agency!.id}`);
  const [client] = await db()
    .insert(schema.organizations)
    .values({
      kind: "client",
      name: opts.clientName ?? `Client ${n}`,
      slug: `client-${n}-${Date.now()}`,
      parentId: agency!.id,
      agencyId: agency!.id,
      industry: opts.industry ?? null,
      timezone: opts.timezone ?? "America/New_York",
    })
    .returning();
  const [user] = await db().insert(schema.users).values({ email: `owner${n}-${Date.now()}@example.com`, name: "Owner" }).returning();
  await db().insert(schema.memberships).values({ userId: user!.id, orgId: client!.id, role: "owner" });
  return { agency: agency!, client: client!, user: user! };
}

export async function makeCustomer(parentId: string, agencyId: string) {
  n++;
  const [c] = await db()
    .insert(schema.organizations)
    .values({ kind: "customer", name: `Customer ${n}`, slug: `customer-${n}-${Date.now()}`, parentId, agencyId })
    .returning();
  return c!;
}

/** Make every queued job due now (fast-forward the clock for scheduled runs). */
export async function makeJobsDue() {
  await db().execute(sql`update jobs set run_at = now() - interval '1 second' where status = 'queued'`);
}
