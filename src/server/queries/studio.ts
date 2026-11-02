/**
 * Studio read queries. Every function takes ids that the caller already authorized
 * (via requireOrg on the agency) and scopes every query by them.
 */
import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";

const s = schema;
const DAY = 86_400_000;

export type ClientOrg = typeof s.organizations.$inferSelect;

/** Client + customer orgs under an agency (authorized by the caller). */
export const agencyOrgs = cache(async (agencyId: string): Promise<ClientOrg[]> => {
  return db()
    .select()
    .from(s.organizations)
    .where(
      and(
        or(eq(s.organizations.agencyId, agencyId), eq(s.organizations.parentId, agencyId)),
        ne(s.organizations.id, agencyId),
        isNull(s.organizations.deletedAt),
      ),
    )
    .orderBy(asc(s.organizations.name));
});

export async function agencyOrgIds(agencyId: string): Promise<string[]> {
  return (await agencyOrgs(agencyId)).map((o) => o.id);
}

export function inboxAddress(handle: string | null | undefined): string | null {
  return handle ? `${handle}@${env().EMAIL_DOMAIN}` : null;
}

const agentCols = {
  id: s.agents.id,
  name: s.agents.name,
  role: s.agents.role,
  status: s.agents.status,
  avatarSeed: s.agents.avatarSeed,
  orgId: s.agents.orgId,
  emailHandle: s.agents.emailHandle,
  summary: s.agents.summary,
  createdAt: s.agents.createdAt,
};

/** Orgs in this agency's tree, as a subquery (no id list round-trip; scales to thousands of clients). */
function inAgency(col: Parameters<typeof eq>[0], agencyId: string) {
  return sql`${col} in (select o.id from organizations o where (o.agency_id = ${agencyId} or o.parent_id = ${agencyId}) and o.id <> ${agencyId} and o.deleted_at is null)`;
}

/**
 * Deliverables in this agency's client/customer orgs, via the denormalized deliverables.agency_id
 * (indexes: (agency_id, created_at) and the partial changes_requested one). Excludes the agency's own org and
 * soft-deleted orgs, matching inAgency.
 */
function agencyDeliverables(agencyId: string, alias?: string) {
  const agency = alias ? sql.raw(`${alias}.agency_id`) : s.deliverables.agencyId;
  const org = alias ? sql.raw(`${alias}.org_id`) : s.deliverables.orgId;
  return sql`(${agency} = ${agencyId} and ${org} <> ${agencyId} and ${org} not in (select o.id from organizations o where o.agency_id = ${agencyId} and o.deleted_at is not null))`;
}

/** Escape LIKE wildcards in user search text. */
function likeEscape(q: string) {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const SHELL_RECENT = 8;

/** The shell carries counts and a few recent items — never the whole agency. ⌘K searches the rest on demand. */
export async function getShellData(agencyId: string) {
  const [recent, counts, clients] = await Promise.all([
    db()
      .select({ id: s.agents.id, name: s.agents.name, role: s.agents.role, seed: s.agents.avatarSeed, status: s.agents.status, orgName: s.organizations.name })
      .from(s.agents)
      .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
      .where(and(inAgency(s.agents.orgId, agencyId), ne(s.agents.status, "archived")))
      // Most recently active: last delivery (trigger-maintained) or last edit, whichever is newer.
      .orderBy(sql`greatest(${s.agents.updatedAt}, coalesce(${s.agents.lastDeliveredAt}, ${s.agents.updatedAt})) desc`)
      .limit(SHELL_RECENT),
    db()
      .select({
        agents: sql<number>`(select count(*) from agents a where ${inAgency(sql`a.org_id`, agencyId)} and a.status <> 'archived')`.mapWith(Number),
        clients: sql<number>`(select count(*) from organizations o where (o.agency_id = ${agencyId} or o.parent_id = ${agencyId}) and o.kind = 'client' and o.deleted_at is null)`.mapWith(Number),
      })
      .from(sql`(select 1) as one`),
    db()
      .select({ id: s.organizations.id, name: s.organizations.name, slug: s.organizations.slug })
      .from(s.organizations)
      .where(and(inAgency(s.organizations.id, agencyId), eq(s.organizations.kind, "client")))
      .orderBy(desc(s.organizations.createdAt))
      .limit(6),
  ]);
  return {
    agents: recent.map((a) => ({ id: a.id, name: a.name, role: a.role, seed: a.seed ?? a.id, orgName: a.orgName, status: a.status })),
    clients,
    counts: { agents: counts[0]?.agents ?? 0, clients: counts[0]?.clients ?? 0 },
  };
}

/** ⌘K: prefix / word-prefix matches on names (and agent roles), capped. */
export async function searchStudio(agencyId: string, q: string, limit = 8) {
  const term = likeEscape(q.trim().toLowerCase());
  if (!term) return { agents: [], clients: [] };
  const prefix = `${term}%`;
  const word = `% ${term}%`;
  const [agents, clients] = await Promise.all([
    db()
      .select({ id: s.agents.id, name: s.agents.name, role: s.agents.role, seed: s.agents.avatarSeed, orgName: s.organizations.name })
      .from(s.agents)
      .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
      .where(
        and(
          inAgency(s.agents.orgId, agencyId),
          ne(s.agents.status, "archived"),
          sql`(lower(${s.agents.name}) like ${prefix} or lower(${s.agents.name}) like ${word} or lower(${s.agents.role}) like ${prefix} or lower(${s.organizations.name}) like ${prefix})`,
        ),
      )
      .orderBy(sql`lower(${s.agents.name}) like ${prefix} desc`, asc(s.agents.name))
      .limit(limit),
    db()
      .select({ id: s.organizations.id, name: s.organizations.name, slug: s.organizations.slug })
      .from(s.organizations)
      .where(and(inAgency(s.organizations.id, agencyId), eq(s.organizations.kind, "client"), sql`(lower(${s.organizations.name}) like ${prefix} or lower(${s.organizations.name}) like ${word})`))
      .orderBy(sql`lower(${s.organizations.name}) like ${prefix} desc`, asc(s.organizations.name))
      .limit(limit),
  ]);
  return { agents: agents.map((a) => ({ ...a, seed: a.seed ?? a.id })), clients };
}

export const PAGE_SIZE = 50;

async function mrrCents(agencyId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const [row] = await db()
    .select({ v: sql<number>`coalesce(sum(${s.plans.priceCents}), 0)`.mapWith(Number) })
    .from(s.subscriptions)
    .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
    .where(
      and(
        inArray(s.subscriptions.orgId, ids),
        eq(s.plans.orgId, agencyId),
        inArray(s.subscriptions.status, ["active", "past_due", "trialing"]),
      ),
    );
  return row?.v ?? 0;
}

/** Mirrors the engine's notification href for a change request (engine.ts changesHref). */
const changesHrefSql = sql`'/agents/' || ${s.deliverables.agentId}::text || '/activity?deliverable=' || ${s.deliverables.id}::text`;

export async function getHome(agencyId: string) {
  const empty = {
    delivered: [],
    approvals: [],
    changes: [],
    failed: [],
    provisioning: [],
    waiting: [],
    numbers: { mrrCents: 0, activeAgents: 0, hoursWeek: 0, deliveredWeek: 0 },
    counts: { clients: 0, agents: 0 },
  };
  void empty;
  const since = new Date(Date.now() - DAY);
  const week = new Date(Date.now() - 7 * DAY);

  const [delivered, approvals, failed, attentionAgents, agentCounts, week7, mrr, changes] = await Promise.all([
    db()
      .select({
        id: s.deliverables.id,
        title: s.deliverables.title,
        preview: s.deliverables.preview,
        kind: s.deliverables.kind,
        status: s.deliverables.status,
        needsReview: s.deliverables.needsReview,
        hoursSaved: s.deliverables.hoursSaved,
        createdAt: s.deliverables.createdAt,
        agentId: s.agents.id,
        agentName: s.agents.name,
        agentSeed: s.agents.avatarSeed,
        orgName: s.organizations.name,
        orgSlug: s.organizations.slug,
      })
      .from(s.deliverables)
      .innerJoin(s.agents, eq(s.agents.id, s.deliverables.agentId))
      .innerJoin(s.organizations, eq(s.organizations.id, s.deliverables.orgId))
      .where(and(agencyDeliverables(agencyId), gte(s.deliverables.createdAt, since)))
      .orderBy(desc(s.deliverables.createdAt))
      .limit(8),
    db()
      .select({
        id: s.approvals.id,
        description: s.approvals.description,
        action: s.approvals.action,
        createdAt: s.approvals.createdAt,
        agentId: s.agents.id,
        agentName: s.agents.name,
        agentSeed: s.agents.avatarSeed,
        orgName: s.organizations.name,
        orgSlug: s.organizations.slug,
      })
      .from(s.approvals)
      .innerJoin(s.agents, eq(s.agents.id, s.approvals.agentId))
      .innerJoin(s.organizations, eq(s.organizations.id, s.approvals.orgId))
      .where(and(inAgency(s.approvals.orgId, agencyId), eq(s.approvals.status, "pending")))
      .orderBy(desc(s.approvals.createdAt))
      .limit(6),
    db()
      .select({
        id: s.runs.id,
        summary: s.runs.summary,
        error: s.runs.error,
        createdAt: s.runs.createdAt,
        agentId: s.agents.id,
        agentName: s.agents.name,
        agentSeed: s.agents.avatarSeed,
        orgName: s.organizations.name,
        workflowName: s.workflows.name,
      })
      .from(s.runs)
      .innerJoin(s.agents, eq(s.agents.id, s.runs.agentId))
      .innerJoin(s.organizations, eq(s.organizations.id, s.runs.orgId))
      .leftJoin(s.workflows, eq(s.workflows.id, s.runs.workflowId))
      .where(and(inAgency(s.runs.orgId, agencyId), eq(s.runs.status, "failed"), gte(s.runs.createdAt, new Date(Date.now() - 3 * DAY))))
      .orderBy(desc(s.runs.createdAt))
      .limit(5),
    // Only what the page shows: provisioning agents, active agents with no delivery yet, and counts.
    db()
      .select({ ...agentCols, orgName: s.organizations.name })
      .from(s.agents)
      .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
      .where(
        and(
          inAgency(s.agents.orgId, agencyId),
          or(
            eq(s.agents.status, "provisioning"),
            and(eq(s.agents.status, "active"), eq(s.agents.deliveredCount, 0)),
          ),
        ),
      )
      .orderBy(desc(s.agents.createdAt))
      .limit(12),
    db()
      .select({
        active: sql<number>`count(*) filter (where ${s.agents.status} = 'active')`.mapWith(Number),
        live: sql<number>`count(*) filter (where ${s.agents.status} <> 'archived')`.mapWith(Number),
        provisioning: sql<number>`count(*) filter (where ${s.agents.status} = 'provisioning')`.mapWith(Number),
        clients: sql<number>`(select count(*) from organizations o where (o.agency_id = ${agencyId} or o.parent_id = ${agencyId}) and o.kind = 'client' and o.deleted_at is null)`.mapWith(Number),
      })
      .from(s.agents)
      .where(inAgency(s.agents.orgId, agencyId)),
    db()
      .select({
        hours: sql<number>`coalesce(sum(${s.deliverables.hoursSaved}), 0)`.mapWith(Number),
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(s.deliverables)
      .where(and(agencyDeliverables(agencyId), gte(s.deliverables.createdAt, week))),
    clientTotals(agencyId).then((t) => t.mrrCents),
    db()
      .select({
        id: s.deliverables.id,
        title: s.deliverables.title,
        feedback: s.deliverables.feedback,
        createdAt: s.deliverables.createdAt,
        seenAt: s.deliverables.seenAt,
        // When the client actually asked: the engine's agency notification for this deliverable.
        requestedAt: sql<Date | null>`(select max(n.created_at) from notifications n where n.org_id = ${agencyId} and n.kind = 'deliverable.changes_requested' and n.href = ${changesHrefSql})`.mapWith(
          (v) => (v ? new Date(v) : null),
        ),
        // Still open: the alert hasn't been closed (all copies read) …
        open: sql<boolean>`coalesce((select bool_or(n.read_at is null) from notifications n where n.org_id = ${agencyId} and n.kind = 'deliverable.changes_requested' and n.href = ${changesHrefSql}), true)`,
        // … and no revision has been delivered since (walks this agent's later deliverables via (agent_id, created_at)).
        revised: sql<boolean>`exists (select 1 from deliverables r join runs ru on ru.id = r.run_id where r.agent_id = ${s.deliverables.agentId} and r.created_at > ${s.deliverables.createdAt} and ru.input->>'kind' = 'revision' and ru.input->>'deliverableId' = ${s.deliverables.id}::text)`,
        agentId: s.agents.id,
        agentName: s.agents.name,
        agentSeed: s.agents.avatarSeed,
        orgName: s.organizations.name,
      })
      .from(s.deliverables)
      .innerJoin(s.agents, eq(s.agents.id, s.deliverables.agentId))
      .innerJoin(s.organizations, eq(s.organizations.id, s.deliverables.orgId))
      // Select-list subqueries run only for these few rows (LIMIT first); open/revised are filtered below.
      .where(and(agencyDeliverables(agencyId), eq(s.deliverables.status, "changes_requested")))
      .orderBy(desc(s.deliverables.createdAt))
      .limit(20),
  ]);

  const counts = agentCounts[0];
  return {
    delivered,
    approvals,
    changes: changes.filter((c) => c.open && !c.revised).slice(0, 6),
    failed,
    provisioning: attentionAgents.filter((a) => a.status === "provisioning").slice(0, 6),
    waiting: attentionAgents.filter((a) => a.status === "active").slice(0, 6),
    numbers: {
      mrrCents: mrr,
      activeAgents: counts?.active ?? 0,
      provisioningAgents: counts?.provisioning ?? 0,
      hoursWeek: week7[0]?.hours ?? 0,
      deliveredWeek: week7[0]?.n ?? 0,
    },
    counts: { clients: counts?.clients ?? 0, agents: counts?.live ?? 0 },
  };
}

export async function listClients(agencyId: string, opts: { page?: number; q?: string } = {}) {
  const page = Math.max(0, Math.floor(opts.page ?? 0));
  const q = opts.q?.trim().toLowerCase();
  const rows = await db()
    .select({ id: s.organizations.id, name: s.organizations.name, slug: s.organizations.slug, status: s.organizations.status, industry: s.organizations.industry, website: s.organizations.website })
    .from(s.organizations)
    .where(
      and(
        inAgency(s.organizations.id, agencyId),
        eq(s.organizations.kind, "client"),
        q ? sql`(lower(${s.organizations.name}) like ${`${likeEscape(q)}%`} or lower(${s.organizations.name}) like ${`% ${likeEscape(q)}%`})` : undefined,
      ),
    )
    .orderBy(asc(s.organizations.name), asc(s.organizations.id))
    .limit(PAGE_SIZE + 1)
    .offset(page * PAGE_SIZE);
  const more = rows.length > PAGE_SIZE;
  const orgs = rows.slice(0, PAGE_SIZE);
  const ids = orgs.map((o) => o.id);
  if (!ids.length) return { items: [], page, more: false };
  const [agentCounts, lastDel, subs] = await Promise.all([
    db()
      .select({ orgId: s.agents.orgId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(s.agents)
      .where(and(inArray(s.agents.orgId, ids), ne(s.agents.status, "archived")))
      .groupBy(s.agents.orgId),
    // Latest delivery per client on this page only, from the agents' trigger-maintained last_delivered_at.
    db()
      .select({ orgId: s.agents.orgId, at: sql<Date | null>`max(${s.agents.lastDeliveredAt})`.mapWith((v) => (v ? new Date(v) : null)) })
      .from(s.agents)
      .where(inArray(s.agents.orgId, ids))
      .groupBy(s.agents.orgId),
    db()
      .select({ orgId: s.subscriptions.orgId, status: s.subscriptions.status, planName: s.plans.name, priceCents: s.plans.priceCents })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(and(inArray(s.subscriptions.orgId, ids), eq(s.plans.orgId, agencyId), ne(s.subscriptions.status, "canceled"))),
  ]);
  const items = orgs.map((o) => {
    const mine = subs.filter((x) => x.orgId === o.id);
    return {
      ...o,
      agents: agentCounts.find((x) => x.orgId === o.id)?.n ?? 0,
      lastDeliveryAt: lastDel.find((x) => x.orgId === o.id)?.at ?? null,
      planName: mine[0]?.planName ?? null,
      mrrCents: mine.reduce((sum, x) => sum + x.priceCents, 0),
      subStatus: mine[0]?.status ?? null,
    };
  });
  return { items, page, more };
}

/** One client or customer org in this agency's tree by id (for action guards). */
export async function orgInAgency(agencyId: string, orgId: string): Promise<ClientOrg | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return null;
  const rows = await db().select().from(s.organizations).where(and(eq(s.organizations.id, orgId), inAgency(s.organizations.id, agencyId))).limit(1);
  return rows[0] ?? null;
}

/** Clients for the new-agent picker: a bounded first page (or a name search), plus any pinned ids/slugs, with plan labels. */
export async function pickerClients(agencyId: string, opts: { q?: string; pin?: { ids?: string[]; slugs?: string[] }; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 50);
  const q = opts.q?.trim().toLowerCase();
  const term = q ? likeEscape(q) : null;
  const pinIds = (opts.pin?.ids ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const pinSlugs = (opts.pin?.slugs ?? []).filter(Boolean).slice(0, 4);
  const cols = { id: s.organizations.id, name: s.organizations.name, slug: s.organizations.slug };
  const base = and(inAgency(s.organizations.id, agencyId), eq(s.organizations.kind, "client"));
  const [page, pinned] = await Promise.all([
    db()
      .select(cols)
      .from(s.organizations)
      .where(and(base, term ? sql`(lower(${s.organizations.name}) like ${`${term}%`} or lower(${s.organizations.name}) like ${`% ${term}%`})` : undefined))
      .orderBy(...(term ? [sql`lower(${s.organizations.name}) like ${`${term}%`} desc`, asc(s.organizations.name)] : [asc(s.organizations.name)]))
      .limit(limit),
    pinIds.length || pinSlugs.length
      ? db()
          .select(cols)
          .from(s.organizations)
          .where(and(base, or(pinIds.length ? inArray(s.organizations.id, pinIds) : undefined, pinSlugs.length ? inArray(s.organizations.slug, pinSlugs) : undefined)))
      : Promise.resolve([]),
  ]);
  const orgs = [...pinned, ...page.filter((o) => !pinned.some((p) => p.id === o.id))];
  if (!orgs.length) return [];
  const subs = await db()
    .select({ orgId: s.subscriptions.orgId, priceCents: s.plans.priceCents, planName: s.plans.name })
    .from(s.subscriptions)
    .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
    .where(and(inArray(s.subscriptions.orgId, orgs.map((o) => o.id)), eq(s.plans.orgId, agencyId), ne(s.subscriptions.status, "canceled")));
  return orgs.map((o) => {
    const sub = subs.find((x) => x.orgId === o.id);
    return { ...o, plan: sub ? { priceCents: sub.priceCents, name: sub.planName } : null };
  });
}

/** One client org of this agency by slug (no full-agency load). */
export const clientBySlug = cache(async (agencyId: string, slug: string): Promise<ClientOrg | null> => {
  const rows = await db()
    .select()
    .from(s.organizations)
    .where(and(eq(s.organizations.slug, slug), eq(s.organizations.kind, "client"), inAgency(s.organizations.id, agencyId)))
    .limit(1);
  return rows[0] ?? null;
});

export async function getClient(agencyId: string, slug: string) {
  const org = await clientBySlug(agencyId, slug);
  if (!org) return null;
  const [agents, deliverables, subs, members, invites, customers] = await Promise.all([
    db()
      .select(agentCols)
      .from(s.agents)
      .where(and(eq(s.agents.orgId, org.id), ne(s.agents.status, "archived")))
      .orderBy(asc(s.agents.createdAt)),
    db()
      .select({
        id: s.deliverables.id,
        title: s.deliverables.title,
        preview: s.deliverables.preview,
        kind: s.deliverables.kind,
        status: s.deliverables.status,
        hoursSaved: s.deliverables.hoursSaved,
        createdAt: s.deliverables.createdAt,
        agentId: s.agents.id,
        agentName: s.agents.name,
        agentSeed: s.agents.avatarSeed,
      })
      .from(s.deliverables)
      .innerJoin(s.agents, eq(s.agents.id, s.deliverables.agentId))
      .where(eq(s.deliverables.orgId, org.id))
      .orderBy(desc(s.deliverables.createdAt))
      .limit(8),
    db()
      .select({ id: s.subscriptions.id, status: s.subscriptions.status, createdAt: s.subscriptions.createdAt, currentPeriodEnd: s.subscriptions.currentPeriodEnd, planId: s.plans.id, planName: s.plans.name, priceCents: s.plans.priceCents })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(and(eq(s.subscriptions.orgId, org.id), eq(s.plans.orgId, agencyId)))
      .orderBy(desc(s.subscriptions.createdAt)),
    db()
      .select({ id: s.memberships.id, role: s.memberships.role, name: s.users.name, email: s.users.email })
      .from(s.memberships)
      .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
      .where(eq(s.memberships.orgId, org.id)),
    db()
      .select()
      .from(s.invitations)
      .where(and(eq(s.invitations.orgId, org.id), isNull(s.invitations.acceptedAt)))
      .orderBy(desc(s.invitations.createdAt)),
    db()
      .select({ id: s.organizations.id, name: s.organizations.name })
      .from(s.organizations)
      .where(and(eq(s.organizations.parentId, org.id), isNull(s.organizations.deletedAt))),
  ]);
  const hours = deliverables.reduce((sum, d) => sum + d.hoursSaved, 0);
  return { org, agents, deliverables, subs, members, invites, customers, hours };
}

export async function listAgents(agencyId: string, opts: { page?: number; q?: string } = {}) {
  const page = Math.max(0, Math.floor(opts.page ?? 0));
  const q = opts.q?.trim().toLowerCase();
  const week = new Date(Date.now() - 7 * DAY);
  const rows = await db()
    .select({
      id: s.agents.id,
      name: s.agents.name,
      role: s.agents.role,
      status: s.agents.status,
      avatarSeed: s.agents.avatarSeed,
      orgId: s.agents.orgId,
      orgName: s.organizations.name,
      orgSlug: s.organizations.slug,
      orgKind: s.organizations.kind,
      lastDeliveryAt: s.agents.lastDeliveredAt,
    })
    .from(s.agents)
    .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
    .where(
      and(
        inAgency(s.agents.orgId, agencyId),
        ne(s.agents.status, "archived"),
        q
          ? sql`(lower(${s.agents.name}) like ${`${likeEscape(q)}%`} or lower(${s.agents.role}) like ${`${likeEscape(q)}%`} or lower(${s.organizations.name}) like ${`${likeEscape(q)}%`})`
          : undefined,
      ),
    )
    .orderBy(asc(s.organizations.name), asc(s.agents.name), asc(s.agents.id))
    .limit(PAGE_SIZE + 1)
    .offset(page * PAGE_SIZE);
  const more = rows.length > PAGE_SIZE;
  const list = rows.slice(0, PAGE_SIZE);
  const ids = list.map((r) => r.id);
  if (!ids.length) return { items: [], page, more: false };
  const [stats, wfs] = await Promise.all([
    // This week's hours for this page's agents only (index on deliverables(agent_id, created_at)).
    db()
      .select({ agentId: s.deliverables.agentId, hours: sql<number>`coalesce(sum(${s.deliverables.hoursSaved}), 0)`.mapWith(Number) })
      .from(s.deliverables)
      .where(and(inArray(s.deliverables.agentId, ids), gte(s.deliverables.createdAt, week)))
      .groupBy(s.deliverables.agentId),
    db()
      .select({ agentId: s.workflows.agentId, n: sql<number>`count(*)`.mapWith(Number), next: sql<Date | null>`min(${s.workflows.nextRunAt})`.mapWith((v) => (v ? new Date(v) : null)) })
      .from(s.workflows)
      .where(and(inArray(s.workflows.agentId, ids), eq(s.workflows.enabled, true)))
      .groupBy(s.workflows.agentId),
  ]);
  const items = list.map((r) => {
    const st = stats.find((x) => x.agentId === r.id);
    const wf = wfs.find((x) => x.agentId === r.id);
    return { ...r, hoursWeek: st?.hours ?? 0, workflows: wf?.n ?? 0, nextRunAt: wf?.next ?? null };
  });
  return { items, page, more };
}

/** One agent, only if it belongs to the authorized agency tree. */
export async function getAgent(agencyId: string, agentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const rows = await db()
    .select({ agent: s.agents, org: s.organizations })
    .from(s.agents)
    .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
    .where(and(eq(s.agents.id, agentId), inAgency(s.agents.orgId, agencyId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, inbox: inboxAddress(row.agent.emailHandle) };
}

export async function agentWorkflows(orgId: string, agentId: string) {
  return db()
    .select()
    .from(s.workflows)
    .where(and(eq(s.workflows.orgId, orgId), eq(s.workflows.agentId, agentId)))
    .orderBy(asc(s.workflows.createdAt));
}

export async function agentDeliverables(orgId: string, agentId: string, limit = 10) {
  return db()
    .select()
    .from(s.deliverables)
    .where(and(eq(s.deliverables.orgId, orgId), eq(s.deliverables.agentId, agentId)))
    .orderBy(desc(s.deliverables.createdAt))
    .limit(limit);
}

export async function agentValue(orgId: string, agentId: string) {
  const [row] = await db()
    .select({
      hours: sql<number>`coalesce(sum(${s.deliverables.hoursSaved}), 0)`.mapWith(Number),
      n: sql<number>`count(*)`.mapWith(Number),
      approved: sql<number>`count(*) filter (where ${s.deliverables.status} = 'approved')`.mapWith(Number),
    })
    .from(s.deliverables)
    .where(and(eq(s.deliverables.orgId, orgId), eq(s.deliverables.agentId, agentId)));
  const [cost] = await db()
    .select({ micros: sql<number>`coalesce(sum(${s.runs.costMicros}), 0)`.mapWith(Number), runs: sql<number>`count(*)`.mapWith(Number) })
    .from(s.runs)
    .where(and(eq(s.runs.orgId, orgId), eq(s.runs.agentId, agentId)));
  return { hours: row?.hours ?? 0, delivered: row?.n ?? 0, approved: row?.approved ?? 0, costMicros: cost?.micros ?? 0, runs: cost?.runs ?? 0 };
}

export async function agentRuns(orgId: string, agentId: string, limit = 30) {
  const runs = await db()
    .select({ run: s.runs, workflowName: s.workflows.name })
    .from(s.runs)
    .leftJoin(s.workflows, eq(s.workflows.id, s.runs.workflowId))
    .where(and(eq(s.runs.orgId, orgId), eq(s.runs.agentId, agentId)))
    .orderBy(desc(s.runs.createdAt))
    .limit(limit);
  const runIds = runs.map((r) => r.run.id);
  const steps = runIds.length
    ? await db().select().from(s.runSteps).where(inArray(s.runSteps.runId, runIds)).orderBy(asc(s.runSteps.seq))
    : [];
  return runs.map((r) => ({ ...r.run, workflowName: r.workflowName, steps: steps.filter((st) => st.runId === r.run.id) }));
}

export async function agentMemories(orgId: string, agentId: string) {
  return db()
    .select({ id: s.memories.id, kind: s.memories.kind, content: s.memories.content, importance: s.memories.importance, source: s.memories.source, createdAt: s.memories.createdAt })
    .from(s.memories)
    .where(and(eq(s.memories.orgId, orgId), eq(s.memories.agentId, agentId)))
    .orderBy(desc(s.memories.importance), desc(s.memories.createdAt))
    .limit(200);
}

export async function agentKnowledge(orgId: string, agentId: string) {
  return db()
    .select()
    .from(s.knowledgeSources)
    .where(and(eq(s.knowledgeSources.orgId, orgId), or(eq(s.knowledgeSources.agentId, agentId), isNull(s.knowledgeSources.agentId))))
    .orderBy(desc(s.knowledgeSources.createdAt));
}

export async function agentChannels(orgId: string, agentId: string) {
  return db()
    .select({ kind: s.channelConnections.kind, status: s.channelConnections.status, agentId: s.channelConnections.agentId })
    .from(s.channelConnections)
    .where(and(eq(s.channelConnections.orgId, orgId), or(eq(s.channelConnections.agentId, agentId), isNull(s.channelConnections.agentId))));
}

/** Provisioning status for the hire checklist. */
export async function provisioningStatus(agencyId: string, agentId: string) {
  const found = await getAgent(agencyId, agentId);
  if (!found) return null;
  const { agent } = found;
  const [mem, kb, wf, ch] = await Promise.all([
    db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(s.memories).where(and(eq(s.memories.orgId, agent.orgId), eq(s.memories.agentId, agent.id))),
    db()
      .select({ n: sql<number>`count(*)`.mapWith(Number), ready: sql<number>`count(*) filter (where ${s.knowledgeSources.status} in ('ready','indexing','pending'))`.mapWith(Number) })
      .from(s.knowledgeSources)
      .where(and(eq(s.knowledgeSources.orgId, agent.orgId), eq(s.knowledgeSources.agentId, agent.id))),
    db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(s.workflows).where(and(eq(s.workflows.orgId, agent.orgId), eq(s.workflows.agentId, agent.id))),
    db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(s.channelConnections).where(and(eq(s.channelConnections.orgId, agent.orgId), eq(s.channelConnections.agentId, agent.id))),
  ]);
  return {
    status: agent.status,
    memories: mem[0]?.n ?? 0,
    knowledge: kb[0]?.n ?? 0,
    inbox: found.inbox,
    computer: agent.computerStatus,
    workflows: wf[0]?.n ?? 0,
    channels: (ch[0]?.n ?? 0) + (agent.config.defaultDelivery?.length ?? 0),
  };
}

export async function getDiscovery(agencyId: string, discoveryId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(discoveryId)) return null;
  const rows = await db()
    .select({ d: s.discoveries, orgName: s.organizations.name, orgSlug: s.organizations.slug })
    .from(s.discoveries)
    .innerJoin(s.organizations, eq(s.organizations.id, s.discoveries.orgId))
    .where(and(eq(s.discoveries.id, discoveryId), inAgency(s.discoveries.orgId, agencyId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listBlueprints(agencyId: string) {
  return db().select().from(s.blueprints).where(eq(s.blueprints.orgId, agencyId)).orderBy(desc(s.blueprints.updatedAt));
}

export async function getBilling(agencyId: string) {
  const orgs = await agencyOrgs(agencyId);
  const ids = orgs.map((o) => o.id);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since30 = new Date(Date.now() - 30 * DAY);
  const [plans, subs, usage, mrr] = await Promise.all([
    db()
      .select({ plan: s.plans, subs: sql<number>`count(${s.subscriptions.id})`.mapWith(Number) })
      .from(s.plans)
      .leftJoin(s.subscriptions, and(eq(s.subscriptions.planId, s.plans.id), ne(s.subscriptions.status, "canceled")))
      .where(eq(s.plans.orgId, agencyId))
      .groupBy(s.plans.id)
      .orderBy(desc(s.plans.active), asc(s.plans.priceCents)),
    ids.length
      ? db()
          .select({ sub: s.subscriptions, planName: s.plans.name, priceCents: s.plans.priceCents, orgName: s.organizations.name, orgSlug: s.organizations.slug })
          .from(s.subscriptions)
          .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
          .innerJoin(s.organizations, eq(s.organizations.id, s.subscriptions.orgId))
          .where(and(inArray(s.subscriptions.orgId, ids), eq(s.plans.orgId, agencyId)))
          .orderBy(asc(s.organizations.name))
      : Promise.resolve([]),
    ids.length
      ? db()
          .select({ orgId: s.usageEvents.orgId, kind: s.usageEvents.kind, micros: sql<number>`coalesce(sum(${s.usageEvents.costMicros}), 0)`.mapWith(Number) })
          .from(s.usageEvents)
          .where(and(inArray(s.usageEvents.orgId, ids), gte(s.usageEvents.createdAt, since30)))
          .groupBy(s.usageEvents.orgId, s.usageEvents.kind)
      : Promise.resolve([]),
    mrrCents(agencyId, ids),
  ]);
  const clients = orgs.filter((o) => o.kind === "client");
  const margin = clients.map((c) => {
    // A client's cost includes its customers' (resale) usage.
    const tree = new Set([c.id, ...orgs.filter((o) => o.parentId === c.id).map((o) => o.id)]);
    const rows = usage.filter((u) => tree.has(u.orgId));
    const costMicros = rows.reduce((sum, u) => sum + u.micros, 0);
    const priceCents = subs.filter((x) => x.sub.orgId === c.id && x.sub.status !== "canceled").reduce((sum, x) => sum + x.priceCents, 0);
    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.micros;
    return { id: c.id, name: c.name, slug: c.slug, priceCents, costCents: Math.round(costMicros / 10_000), byKind };
  });
  return { plans, subs, margin, mrrCents: mrr, clients: clients.map((c) => ({ id: c.id, name: c.name })), monthStart };
}

export async function getTeam(agencyId: string) {
  const [members, invites] = await Promise.all([
    db()
      .select({ id: s.memberships.id, role: s.memberships.role, userId: s.users.id, name: s.users.name, email: s.users.email, lastSeenAt: s.users.lastSeenAt })
      .from(s.memberships)
      .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
      .where(eq(s.memberships.orgId, agencyId))
      .orderBy(asc(s.memberships.createdAt)),
    db()
      .select()
      .from(s.invitations)
      .where(and(eq(s.invitations.orgId, agencyId), isNull(s.invitations.acceptedAt)))
      .orderBy(desc(s.invitations.createdAt)),
  ]);
  return { members, invites };
}

export async function listApiKeys(agencyId: string) {
  return db()
    .select({ id: s.apiKeys.id, name: s.apiKeys.name, prefix: s.apiKeys.prefix, scopes: s.apiKeys.scopes, lastUsedAt: s.apiKeys.lastUsedAt, revokedAt: s.apiKeys.revokedAt, createdAt: s.apiKeys.createdAt })
    .from(s.apiKeys)
    .where(eq(s.apiKeys.orgId, agencyId))
    .orderBy(desc(s.apiKeys.createdAt));
}

export async function agentApprovals(orgId: string, agentId: string) {
  return db()
    .select({ id: s.approvals.id, description: s.approvals.description, action: s.approvals.action, createdAt: s.approvals.createdAt })
    .from(s.approvals)
    .where(and(eq(s.approvals.orgId, orgId), eq(s.approvals.agentId, agentId), eq(s.approvals.status, "pending")))
    .orderBy(desc(s.approvals.createdAt))
    .limit(5);
}

/** What the hire promised: the discovery's proposal, the queued first deliverable, and the client's timezone. */
export async function agentSetup(orgId: string, agentId: string) {
  const [disc, first, org] = await Promise.all([
    db()
      .select({ id: s.discoveries.id, proposal: s.discoveries.proposal })
      .from(s.discoveries)
      .where(and(eq(s.discoveries.orgId, orgId), eq(s.discoveries.agentId, agentId)))
      .orderBy(desc(s.discoveries.createdAt))
      .limit(1),
    db()
      .select({ id: s.runs.id, status: s.runs.status, input: s.runs.input, createdAt: s.runs.createdAt, startedAt: s.runs.startedAt, error: s.runs.error })
      .from(s.runs)
      .where(and(eq(s.runs.orgId, orgId), eq(s.runs.agentId, agentId), eq(s.runs.trigger, "setup")))
      .orderBy(desc(s.runs.createdAt))
      .limit(1),
    db().select({ timezone: s.organizations.timezone }).from(s.organizations).where(eq(s.organizations.id, orgId)).limit(1),
  ]);
  const p = (disc[0]?.proposal ?? null) as null | {
    knowledgeNeeds?: { title: string; why: string }[];
    openQuestions?: string[];
    firstDeliverable?: { title: string; description: string };
  };
  const run = first[0] ?? null;
  const input = (run?.input ?? {}) as { title?: string; description?: string; releaseAt?: string };
  return {
    knowledgeNeeds: p?.knowledgeNeeds ?? [],
    openQuestions: p?.openQuestions ?? [],
    firstRun: run
      ? {
          status: run.status,
          title: input.title ?? p?.firstDeliverable?.title ?? "First deliverable",
          description: input.description ?? p?.firstDeliverable?.description ?? "",
          releaseAt: input.releaseAt ? new Date(input.releaseAt) : null,
          failed: run.status === "failed" || run.status === "canceled",
        }
      : null,
    timezone: org[0]?.timezone ?? "UTC",
  };
}

/** Header totals for the Clients page, without loading every client. */
export async function clientTotals(agencyId: string) {
  const [row] = await db()
    .select({
      count: sql<number>`(select count(*) from organizations o where (o.agency_id = ${agencyId} or o.parent_id = ${agencyId}) and o.kind = 'client' and o.deleted_at is null)`.mapWith(Number),
      mrr: sql<number>`(select coalesce(sum(p.price_cents), 0) from subscriptions sb join plans p on p.id = sb.plan_id join organizations o on o.id = sb.org_id where p.org_id = ${agencyId} and o.kind = 'client' and o.deleted_at is null and (o.agency_id = ${agencyId} or o.parent_id = ${agencyId}) and sb.status in ('active','past_due','trialing'))`.mapWith(Number),
    })
    .from(sql`(select 1) as one`);
  return { count: row?.count ?? 0, mrrCents: row?.mrr ?? 0 };
}

/** Header totals for the Agents page. */
export async function agentTotals(agencyId: string) {
  const week = new Date(Date.now() - 7 * DAY);
  const [row] = await db()
    .select({
      count: sql<number>`(select count(*) from agents a where ${inAgency(sql`a.org_id`, agencyId)} and a.status <> 'archived')`.mapWith(Number),
      hours: sql<number>`(select coalesce(sum(d.hours_saved), 0) from deliverables d where ${agencyDeliverables(agencyId, "d")} and d.created_at >= ${week})`.mapWith(Number),
    })
    .from(sql`(select 1) as one`);
  return { count: row?.count ?? 0, hoursWeek: row?.hours ?? 0 };
}
