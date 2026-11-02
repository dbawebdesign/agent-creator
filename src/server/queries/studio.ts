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

/** Lightweight lists for the sidebar and ⌘K palette. */
export async function getShellData(agencyId: string) {
  const orgs = await agencyOrgs(agencyId);
  const ids = orgs.map((o) => o.id);
  const agents = ids.length
    ? await db()
        .select({ ...agentCols, orgName: s.organizations.name })
        .from(s.agents)
        .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
        .where(and(inArray(s.agents.orgId, ids), ne(s.agents.status, "archived")))
        .orderBy(asc(s.agents.name))
    : [];
  return {
    clients: orgs.filter((o) => o.kind === "client").map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role, seed: a.avatarSeed ?? a.id, orgName: a.orgName, status: a.status })),
  };
}

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

export async function getHome(agencyId: string) {
  const orgs = await agencyOrgs(agencyId);
  const ids = orgs.map((o) => o.id);
  const empty = {
    delivered: [],
    approvals: [],
    failed: [],
    provisioning: [],
    waiting: [],
    numbers: { mrrCents: 0, activeAgents: 0, hoursWeek: 0, deliveredWeek: 0 },
    counts: { clients: 0, agents: 0 },
  };
  if (!ids.length) return empty;
  const since = new Date(Date.now() - DAY);
  const week = new Date(Date.now() - 7 * DAY);

  const [delivered, approvals, failed, agents, firstDeliveries, week7, mrr] = await Promise.all([
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
      .where(and(inArray(s.deliverables.orgId, ids), gte(s.deliverables.createdAt, since)))
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
      .where(and(inArray(s.approvals.orgId, ids), eq(s.approvals.status, "pending")))
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
      .where(and(inArray(s.runs.orgId, ids), eq(s.runs.status, "failed"), gte(s.runs.createdAt, new Date(Date.now() - 3 * DAY))))
      .orderBy(desc(s.runs.createdAt))
      .limit(5),
    db()
      .select({ ...agentCols, orgName: s.organizations.name })
      .from(s.agents)
      .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
      .where(inArray(s.agents.orgId, ids)),
    db()
      .select({ agentId: s.deliverables.agentId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(s.deliverables)
      .where(inArray(s.deliverables.orgId, ids))
      .groupBy(s.deliverables.agentId),
    db()
      .select({
        hours: sql<number>`coalesce(sum(${s.deliverables.hoursSaved}), 0)`.mapWith(Number),
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(s.deliverables)
      .where(and(inArray(s.deliverables.orgId, ids), gte(s.deliverables.createdAt, week))),
    mrrCents(agencyId, ids),
  ]);

  const delivering = new Set(firstDeliveries.map((d) => d.agentId));
  const live = agents.filter((a) => a.status === "active" || a.status === "provisioning");
  return {
    delivered,
    approvals,
    failed,
    provisioning: agents.filter((a) => a.status === "provisioning"),
    waiting: live.filter((a) => a.status === "active" && !delivering.has(a.id)),
    numbers: {
      mrrCents: mrr,
      activeAgents: agents.filter((a) => a.status === "active").length,
      hoursWeek: week7[0]?.hours ?? 0,
      deliveredWeek: week7[0]?.n ?? 0,
    },
    counts: { clients: orgs.filter((o) => o.kind === "client").length, agents: agents.filter((a) => a.status !== "archived").length },
  };
}

export async function listClients(agencyId: string) {
  const orgs = (await agencyOrgs(agencyId)).filter((o) => o.kind === "client");
  const ids = orgs.map((o) => o.id);
  if (!ids.length) return [];
  const [agentCounts, lastDel, subs] = await Promise.all([
    db()
      .select({ orgId: s.agents.orgId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(s.agents)
      .where(and(inArray(s.agents.orgId, ids), ne(s.agents.status, "archived")))
      .groupBy(s.agents.orgId),
    db()
      .select({ orgId: s.deliverables.orgId, at: sql<Date>`max(${s.deliverables.createdAt})`.mapWith((v) => new Date(v)) })
      .from(s.deliverables)
      .where(inArray(s.deliverables.orgId, ids))
      .groupBy(s.deliverables.orgId),
    db()
      .select({ orgId: s.subscriptions.orgId, status: s.subscriptions.status, planName: s.plans.name, priceCents: s.plans.priceCents })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(and(inArray(s.subscriptions.orgId, ids), eq(s.plans.orgId, agencyId), ne(s.subscriptions.status, "canceled"))),
  ]);
  return orgs.map((o) => {
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
}

export async function getClient(agencyId: string, slug: string) {
  const org = (await agencyOrgs(agencyId)).find((o) => o.slug === slug && o.kind === "client");
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

export async function listAgents(agencyId: string) {
  const ids = await agencyOrgIds(agencyId);
  if (!ids.length) return [];
  const week = new Date(Date.now() - 7 * DAY);
  const [rows, stats, wfs] = await Promise.all([
    db()
      .select({ ...agentCols, orgName: s.organizations.name, orgSlug: s.organizations.slug, orgKind: s.organizations.kind })
      .from(s.agents)
      .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
      .where(and(inArray(s.agents.orgId, ids), ne(s.agents.status, "archived")))
      .orderBy(asc(s.organizations.name), asc(s.agents.name)),
    db()
      .select({
        agentId: s.deliverables.agentId,
        last: sql<Date>`max(${s.deliverables.createdAt})`.mapWith((v) => new Date(v)),
        hours: sql<number>`coalesce(sum(case when ${s.deliverables.createdAt} >= ${week} then ${s.deliverables.hoursSaved} else 0 end), 0)`.mapWith(Number),
      })
      .from(s.deliverables)
      .where(inArray(s.deliverables.orgId, ids))
      .groupBy(s.deliverables.agentId),
    db()
      .select({ agentId: s.workflows.agentId, n: sql<number>`count(*)`.mapWith(Number), next: sql<Date | null>`min(${s.workflows.nextRunAt})`.mapWith((v) => (v ? new Date(v) : null)) })
      .from(s.workflows)
      .where(and(inArray(s.workflows.orgId, ids), eq(s.workflows.enabled, true)))
      .groupBy(s.workflows.agentId),
  ]);
  return rows.map((r) => {
    const st = stats.find((x) => x.agentId === r.id);
    const wf = wfs.find((x) => x.agentId === r.id);
    return { ...r, lastDeliveryAt: st?.last ?? null, hoursWeek: st?.hours ?? 0, workflows: wf?.n ?? 0, nextRunAt: wf?.next ?? null };
  });
}

/** One agent, only if it belongs to the authorized agency tree. */
export async function getAgent(agencyId: string, agentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const ids = await agencyOrgIds(agencyId);
  if (!ids.length) return null;
  const rows = await db()
    .select({ agent: s.agents, org: s.organizations })
    .from(s.agents)
    .innerJoin(s.organizations, eq(s.organizations.id, s.agents.orgId))
    .where(and(eq(s.agents.id, agentId), inArray(s.agents.orgId, ids)))
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
  const ids = await agencyOrgIds(agencyId);
  if (!ids.length) return null;
  const rows = await db()
    .select({ d: s.discoveries, orgName: s.organizations.name, orgSlug: s.organizations.slug })
    .from(s.discoveries)
    .innerJoin(s.organizations, eq(s.organizations.id, s.discoveries.orgId))
    .where(and(eq(s.discoveries.id, discoveryId), inArray(s.discoveries.orgId, ids)))
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
