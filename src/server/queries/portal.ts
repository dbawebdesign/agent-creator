/**
 * Portal read models (owner: portal slice). Every query takes an orgId that the caller has already
 * authorized with requireOrg(slug). Nothing here returns tokens, cost, model names or run traces.
 */
import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { cache } from "react";
import {
  requireOrg,
  orgChain,
  hasRole,
  type Org,
  type OrgAccess,
  type Role,
} from "@/server/auth/access";
import { db, schema } from "@/server/db/client";
import type { ChannelKind, WorkflowTrigger } from "@/server/db/schema";
import { env } from "@/server/env";
import { agentEmail as apiAgentEmail } from "@/server/api/v1";
import { emailDomainFor } from "@/server/channels/domains";
import { displayFirstName } from "@/components/portal/lib";
import { providerStatus } from "@/server/channels/service";

export type PortalBrand = {
  /** Name shown in the header: the provider brand (client branding for customers). */
  name: string;
  accent: string | null;
  logoUrl: string | null;
  whiteLabel: boolean;
};

export type PortalContext = {
  access: OrgAccess;
  org: Org;
  brand: PortalBrand;
  /** Client orgs can resell to customers. */
  canResell: boolean;
  /** member+ (viewers can only look). */
  canAct: boolean;
  isAdmin: boolean;
  /** Agency staff (or a parent client) looking at this portal. */
  viewingAs: { name: string; href: string | null } | null;
  user: { id: string; name: string | null; email: string; firstName: string };
  needsYouCount: number;
};

function firstOf<T>(
  chain: Org[],
  pick: (o: Org) => T | undefined | null,
): T | null {
  for (const o of chain) {
    const v = pick(o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/**
 * Agency-only drafting notes (the Architect's offline notice lives in spec.draftNote and must stay in Studio).
 * Defence in depth: if one ever lands in client-visible text, drop that sentence.
 */
const AGENCY_ONLY_NOTE =
  /[^.!?\n]*(no AI model was used|offline extractor|drafted (?:by the )?offline|review every workflow)[^.!?\n]*[.!?]?\s*/gi;
export function clientSafeText(text: string | null): string | null {
  if (!text) return text;
  const out = text.replace(AGENCY_ONLY_NOTE, "").trim();
  return out || null;
}

/** Branding cascade: self → parent → grandparent, field by field. */
export function resolveBrand(chain: Org[]): PortalBrand {
  const org = chain[0]!;
  // Customers see their provider (the client) as the brand; clients see themselves.
  const provider = org.kind === "customer" ? (chain[1] ?? org) : org;
  const fromProvider = org.kind === "customer" ? chain.slice(1) : chain;
  return {
    name: provider.branding?.displayName?.trim() || provider.name,
    accent: firstOf(fromProvider, (o) =>
      isHex(o.branding?.accent) ? o.branding.accent : null,
    ),
    logoUrl: firstOf(fromProvider, (o) =>
      isSafeUrl(o.branding?.logoUrl) ? o.branding.logoUrl : null,
    ),
    // Clients see their agency's name, never ours: "Powered by Roster" is opt-in (branding.showPoweredBy).
    whiteLabel: !chain.some(
      (o) =>
        (o.branding as { showPoweredBy?: unknown } | null)?.showPoweredBy ===
        true,
    ),
  };
}

function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}
function isSafeUrl(v: unknown): v is string {
  return typeof v === "string" && /^https:\/\/[^\s"'<>]+$/.test(v);
}

export const getPortal = cache(async (slug: string): Promise<PortalContext> => {
  const access = await requireOrg(slug, "viewer");
  const { org, user } = access;
  // Portals are for clients and customers. Agencies have the Studio.
  if (org.kind === "agency") {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  const chain = await orgChain(org.id);
  const brand = resolveBrand(chain);
  const viewingAs = access.inherited
    ? {
        name: access.via.name,
        href:
          access.via.kind === "agency"
            ? `/a/${access.via.slug}`
            : `/p/${access.via.slug}`,
      }
    : null;
  const needsYouCount = await countNeedsYou(org.id);
  const name = user.name?.trim() || null;
  return {
    access,
    org,
    brand,
    canResell: org.kind === "client",
    canAct: hasRole(access, "member"),
    isAdmin: hasRole(access, "admin"),
    viewingAs,
    user: {
      id: user.id,
      name,
      email: user.email,
      // Without a name, the email's local part ("linda.m") becomes "Linda"; a lowercase name is capitalized.
      firstName: displayFirstName(
        name?.split(/\s+/)[0] ??
          user.email.split("@")[0]!.split(/[._+-]/)[0]!,
      ),
    },
    needsYouCount,
  };
});

async function countNeedsYou(orgId: string): Promise<number> {
  const [d] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.deliverables)
    .where(
      and(
        eq(schema.deliverables.orgId, orgId),
        eq(schema.deliverables.needsReview, true),
        inArray(schema.deliverables.status, ["new", "seen"]),
      ),
    );
  const [a] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.orgId, orgId),
        eq(schema.approvals.status, "pending"),
        // Counted once: approvals riding along with a pending review.
        sql`not exists (select 1 from deliverables d where d.org_id = ${orgId} and d.run_id = ${schema.approvals.runId} and d.needs_review and d.status in ('new','seen'))`,
      ),
    );
  return (d?.n ?? 0) + (a?.n ?? 0);
}

/* ------------------------------------------------------------------ Today */

export type AgentLite = {
  id: string;
  name: string;
  role: string;
  seed: string;
  status: string;
};

const agentLite = {
  id: schema.agents.id,
  name: schema.agents.name,
  role: schema.agents.role,
  seed: sql<string>`coalesce(${schema.agents.avatarSeed}, ${schema.agents.id}::text)`,
  status: schema.agents.status,
};

export type DeliverableCard = {
  id: string;
  title: string;
  kind: string;
  preview: string | null;
  status: string;
  needsReview: boolean;
  deliveredVia: ChannelKind[];
  hoursSaved: number;
  createdAt: Date;
  agent: AgentLite;
};

const deliverableCard = {
  id: schema.deliverables.id,
  title: schema.deliverables.title,
  kind: schema.deliverables.kind,
  preview: schema.deliverables.preview,
  status: schema.deliverables.status,
  needsReview: schema.deliverables.needsReview,
  deliveredVia: schema.deliverables.deliveredVia,
  hoursSaved: schema.deliverables.hoursSaved,
  createdAt: schema.deliverables.createdAt,
  agent: agentLite,
};

export type ApprovalCard = {
  id: string;
  action: string;
  description: string;
  createdAt: Date;
  agent: AgentLite;
};

export async function getToday(orgId: string) {
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24);
  const [recent, approvals, overnight, agents, nextRun] = await Promise.all([
    db()
      .select({ ...deliverableCard, runId: schema.deliverables.runId })
      .from(schema.deliverables)
      .innerJoin(
        schema.agents,
        eq(schema.agents.id, schema.deliverables.agentId),
      )
      .where(
        and(
          eq(schema.deliverables.orgId, orgId),
          ne(schema.deliverables.status, "archived"),
        ),
      )
      .orderBy(desc(schema.deliverables.createdAt))
      .limit(30),
    db()
      .select({
        id: schema.approvals.id,
        action: schema.approvals.action,
        description: schema.approvals.description,
        createdAt: schema.approvals.createdAt,
        runId: schema.approvals.runId,
        agent: agentLite,
      })
      .from(schema.approvals)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.approvals.agentId))
      .where(
        and(
          eq(schema.approvals.orgId, orgId),
          eq(schema.approvals.status, "pending"),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(20),
    db()
      .select({
        n: sql<number>`count(*)::int`,
        hours: sql<number>`coalesce(sum(${schema.deliverables.hoursSaved}), 0)::float`,
      })
      .from(schema.deliverables)
      .where(
        and(
          eq(schema.deliverables.orgId, orgId),
          gte(schema.deliverables.createdAt, since),
        ),
      ),
    listAgentsLite(orgId),
    db()
      .select({
        id: schema.workflows.id,
        nextRunAt: schema.workflows.nextRunAt,
        name: schema.workflows.name,
        agentName: schema.agents.name,
        agentSeed: sql<string>`coalesce(${schema.agents.avatarSeed}, ${schema.agents.id}::text)`,
      })
      .from(schema.workflows)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.workflows.agentId))
      .where(
        and(
          eq(schema.workflows.orgId, orgId),
          eq(schema.workflows.enabled, true),
          sql`${schema.workflows.nextRunAt} is not null`,
          inArray(schema.agents.status, ["active", "provisioning"]),
        ),
      )
      .orderBy(asc(schema.workflows.nextRunAt))
      .limit(5),
  ]);
  const pendingRuns = new Set(approvals.map((a) => a.runId).filter(Boolean));
  // One card per piece of work: an older item awaiting review with the same teammate and title (a re-run or a
  // revision) is superseded by the newest one, so it isn't shown twice. `recent` is newest first.
  const seenTitles = new Set<string>();
  const superseded = new Set<string>();
  for (const d of recent) {
    if (!(d.needsReview && (d.status === "new" || d.status === "seen"))) continue;
    const key = `${d.agent.name}|${reviewTitleKey(d.title)}`;
    if (seenTitles.has(key)) superseded.add(d.id);
    else seenTitles.add(key);
  }
  const needsReview = recent
    .filter(
      (d) =>
        d.needsReview &&
        (d.status === "new" || d.status === "seen") &&
        !superseded.has(d.id),
    )
    .map((d) => ({
      ...d,
      sendsOnApprove: Boolean(d.runId && pendingRuns.has(d.runId)),
    }));
  const reviewRuns = new Set(needsReview.map((d) => d.runId).filter(Boolean));
  const feed = recent.filter(
    (d) => !superseded.has(d.id) && !needsReview.some((n) => n.id === d.id),
  );
  return {
    needsReview: needsReview as (DeliverableCard & {
      sendsOnApprove: boolean;
    })[],
    // Approvals that ride along with a review are decided from that review.
    approvals: approvals.filter(
      (a) => !a.runId || !reviewRuns.has(a.runId),
    ) as ApprovalCard[],
    feed: feed as DeliverableCard[],
    overnight: { count: overnight[0]?.n ?? 0, hours: overnight[0]?.hours ?? 0 },
    agents,
    nextRun: nextRun[0] ?? null,
    upcoming: nextRun,
  };
}

export async function listAgentsLite(orgId: string): Promise<AgentLite[]> {
  return db()
    .select(agentLite)
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        inArray(schema.agents.status, ["active", "paused", "provisioning"]),
      ),
    )
    .orderBy(asc(schema.agents.createdAt));
}

/** "Renewals due in 30 days (revised)" and "renewals due in 30 days" are the same piece of work. */
export function reviewTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\((?:revised|revision|v\d+|updated)\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------ Deliverable */

async function getDeliverableUncached(orgId: string, id: string) {
  if (!isUuid(id)) return null;
  const rows = await db()
    .select({
      d: schema.deliverables,
      agent: agentLite,
      workflowName: schema.workflows.name,
    })
    .from(schema.deliverables)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.deliverables.agentId))
    .leftJoin(
      schema.workflows,
      eq(schema.workflows.id, schema.deliverables.workflowId),
    )
    .where(
      and(eq(schema.deliverables.orgId, orgId), eq(schema.deliverables.id, id)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { d } = row;
  // The send/act approval riding along with this delivery, if any: pending means approving sends it.
  const [link] = d.runId
    ? await db()
        .select({
          status: schema.approvals.status,
          payload: schema.approvals.payload,
          decidedAt: schema.approvals.decidedAt,
        })
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.orgId, orgId),
            eq(schema.approvals.runId, d.runId),
          ),
        )
        .orderBy(desc(schema.approvals.createdAt))
        .limit(1)
    : [];
  const to =
    link && typeof link.payload?.to === "string"
      ? (link.payload.to as string).slice(0, 200)
      : null;
  const sends = await draftSends(orgId, d.data ?? null);
  return {
    sends,
    sendsOnApprove: link?.status === "pending",
    sendTo:
      link && (link.status === "pending" || link.status === "approved")
        ? to
        : null,
    sentAt: link?.status === "approved" ? link.decidedAt : null,
    id: d.id,
    title: d.title,
    kind: d.kind,
    preview: d.preview,
    body: d.body,
    status: d.status,
    needsReview: d.needsReview,
    deliveredVia: d.deliveredVia,
    hoursSaved: d.hoursSaved,
    feedback: d.feedback,
    createdAt: d.createdAt,
    seenAt: d.seenAt,
    agent: row.agent as AgentLite,
    workflowName: row.workflowName,
  };
}

/** A draft the team sent (or held) when this deliverable was approved. Status is plain-language-ready. */
export type DraftSend = {
  to: string;
  channel: ChannelKind;
  status: "sent" | "sending" | "not_sent" | "failed" | "held";
};

/** Maps a recorded outbound message to what the client is told. A simulated send is never called "Sent". */
export function draftSendStatus(
  m: { deliveryStatus: string; simulated?: unknown } | undefined,
): DraftSend["status"] {
  if (!m) return "sending";
  if (m.deliveryStatus === "failed") return "failed";
  if (m.deliveryStatus === "sent" || m.deliveryStatus === "delivered")
    return m.simulated ? "not_sent" : "sent";
  return "sending";
}

function draftList<K extends string>(
  v: unknown,
  key: K,
): Array<{ to: string } & Record<K, string>> {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (x): x is { to: string } & Record<K, string> =>
        !!x &&
        typeof x === "object" &&
        typeof (x as Record<string, unknown>).to === "string" &&
        typeof (x as Record<string, unknown>)[key] === "string",
    )
    .slice(0, 20);
}

/** Sends recorded by the engine on approval (data.sentDrafts / data.heldDrafts), with live status, org-scoped. */
async function draftSends(
  orgId: string,
  data: Record<string, unknown> | null,
): Promise<DraftSend[]> {
  const sent = draftList(data?.sentDrafts, "messageId").filter((x) =>
    isUuid(x.messageId),
  );
  const held = draftList(data?.heldDrafts, "reason");
  const rows = sent.length
    ? await db()
        .select({
          id: schema.messages.id,
          deliveryStatus: schema.messages.deliveryStatus,
          meta: schema.messages.meta,
          channel: schema.conversations.channel,
        })
        .from(schema.messages)
        .innerJoin(
          schema.conversations,
          and(
            eq(schema.conversations.id, schema.messages.conversationId),
            eq(schema.conversations.orgId, orgId),
          ),
        )
        .where(
          and(
            eq(schema.messages.orgId, orgId),
            inArray(
              schema.messages.id,
              sent.map((x) => x.messageId),
            ),
          ),
        )
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [
    ...sent.map((x): DraftSend => {
      const m = byId.get(x.messageId);
      return {
        to: x.to.slice(0, 200),
        channel: m?.channel ?? "email",
        status: draftSendStatus(
          m && {
            deliveryStatus: m.deliveryStatus,
            simulated: (m.meta as Record<string, unknown> | null)?.simulated,
          },
        ),
      };
    }),
    ...held.map(
      (x): DraftSend => ({
        to: x.to.slice(0, 200),
        channel: "email",
        status: "held",
      }),
    ),
  ];
}

/** The next piece of work waiting on the client, so review can flow item to item. */
export async function nextToReview(orgId: string, excludeId: string) {
  const [row] = await db()
    .select({ id: schema.deliverables.id, title: schema.deliverables.title })
    .from(schema.deliverables)
    .where(
      and(
        eq(schema.deliverables.orgId, orgId),
        eq(schema.deliverables.needsReview, true),
        inArray(schema.deliverables.status, ["new", "seen"]),
        ne(schema.deliverables.id, excludeId),
      ),
    )
    .orderBy(desc(schema.deliverables.createdAt))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------- Team */

export type WorkflowLite = {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  outputKind: string;
  deliverTo: ChannelKind[];
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  hoursSavedPerRun: number;
};

export type TeamMember = AgentLite & {
  summary: string | null;
  email: string | null;
  phone: string | null;
  workflows: WorkflowLite[];
  delivered30d: number;
  hours30d: number;
};

/**
 * Agent addresses use the public API's helper with the org's verified white-label domain (emailDomainFor walks
 * customer → client → agency), so a per-agency email domain shows up here the moment it's verified.
 */
export function agentEmail(
  handle: string | null,
  domain?: string,
): string | null {
  const address = apiAgentEmail(handle, domain);
  // A dev/reserved domain (agents.roster.local) can't receive mail and leaks the platform: show no address.
  return address && deliverableDomain(address.split("@")[1] ?? "")
    ? address
    : null;
}

/**
 * Can people email the team? One status, from the channels service (provider keys) and the org's effective
 * domain (domains.ts), in the same three states the Studio shows:
 * - "receiving": outbound + inbound are on and the domain is routable, so addresses work both ways.
 * - "sending_only": the team can send, but mail to their addresses won't arrive yet.
 * - "not_set_up": nothing goes out or comes in.
 * Clients see addresses (and copy buttons) only while "receiving".
 */
export type EmailReadiness = "receiving" | "sending_only" | "not_set_up";
export const EMAIL_READINESS_LABEL: Record<EmailReadiness, string> = {
  receiving: "Receiving",
  sending_only: "Sending only",
  not_set_up: "Not set up",
};
export function emailReadinessFrom(
  p: { email: boolean; emailInbound: boolean },
  domain: string,
): EmailReadiness {
  if (!p.email || !deliverableDomain(domain)) return "not_set_up";
  return p.emailInbound ? "receiving" : "sending_only";
}
export async function emailReadiness(orgId: string): Promise<EmailReadiness> {
  return emailReadinessFrom(providerStatus(), await emailDomainFor(orgId));
}

/** False for reserved, non-routable TLDs (RFC 2606/6761 and friends) a client could never email. */
export function deliverableDomain(domain: string): boolean {
  return (
    domain.includes(".") &&
    !/\.(local|localhost|test|invalid|example|internal|lan|home\.arpa)$/i.test(
      domain,
    )
  );
}

export async function getTeam(orgId: string): Promise<TeamMember[]> {
  const agents = await db()
    .select({
      ...agentLite,
      summary: schema.agents.summary,
      emailHandle: schema.agents.emailHandle,
      phone: schema.agents.phoneNumber,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        inArray(schema.agents.status, ["active", "paused", "provisioning"]),
      ),
    )
    .orderBy(asc(schema.agents.createdAt));
  if (!agents.length) return [];
  const ids = agents.map((a) => a.id);
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  const [wfs, stats] = await Promise.all([
    db()
      .select({
        id: schema.workflows.id,
        agentId: schema.workflows.agentId,
        name: schema.workflows.name,
        trigger: schema.workflows.trigger,
        outputKind: schema.workflows.outputKind,
        deliverTo: schema.workflows.deliverTo,
        enabled: schema.workflows.enabled,
        nextRunAt: schema.workflows.nextRunAt,
        lastRunAt: schema.workflows.lastRunAt,
        hoursSavedPerRun: schema.workflows.hoursSavedPerRun,
      })
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.orgId, orgId),
          inArray(schema.workflows.agentId, ids),
        ),
      )
      .orderBy(asc(schema.workflows.createdAt)),
    db()
      .select({
        agentId: schema.deliverables.agentId,
        n: sql<number>`count(*)::int`,
        hours: sql<number>`coalesce(sum(${schema.deliverables.hoursSaved}), 0)::float`,
      })
      .from(schema.deliverables)
      .where(
        and(
          eq(schema.deliverables.orgId, orgId),
          gte(schema.deliverables.createdAt, since),
        ),
      )
      .groupBy(schema.deliverables.agentId),
  ]);
  const domain = await emailDomainFor(orgId);
  // An address nobody can write to is worse than none: only hand it out while email is receiving.
  const receiving =
    emailReadinessFrom(providerStatus(), domain) === "receiving";
  return agents.map((a) => {
    const s = stats.find((x) => x.agentId === a.id);
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      seed: a.seed,
      status: a.status,
      summary: clientSafeText(a.summary),
      email: receiving ? agentEmail(a.emailHandle, domain) : null,
      phone: a.phone,
      workflows: wfs.filter((w) => w.agentId === a.id),
      delivered30d: s?.n ?? 0,
      hours30d: s?.hours ?? 0,
    };
  });
}

async function getAgentPageUncached(
  orgId: string,
  agentId: string,
  userId: string,
) {
  if (!isUuid(agentId)) return null;
  const team = await getTeam(orgId);
  const agent = team.find((a) => a.id === agentId);
  if (!agent) return null;
  const [work, convo] = await Promise.all([
    db()
      .select(deliverableCard)
      .from(schema.deliverables)
      .innerJoin(
        schema.agents,
        eq(schema.agents.id, schema.deliverables.agentId),
      )
      .where(
        and(
          eq(schema.deliverables.orgId, orgId),
          eq(schema.deliverables.agentId, agentId),
          ne(schema.deliverables.status, "archived"),
        ),
      )
      .orderBy(desc(schema.deliverables.createdAt))
      .limit(6),
    db()
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.orgId, orgId),
          eq(schema.conversations.agentId, agentId),
          eq(schema.conversations.channel, "portal"),
          or(
            eq(schema.conversations.userId, userId),
            isNull(schema.conversations.userId),
          ),
        ),
      )
      .orderBy(desc(schema.conversations.lastMessageAt))
      .limit(1),
  ]);
  const conversationId = convo[0]?.id ?? null;
  const messages = conversationId
    ? await getMessages(orgId, conversationId, 40)
    : [];
  return { agent, work: work as DeliverableCard[], conversationId, messages };
}

/* --------------------------------------------------------------- Requests */

export type ThreadMessage = {
  id: string;
  author: "agent" | "user" | "contact" | "system";
  body: string;
  createdAt: Date;
  deliveryStatus: string;
  authorName: string | null;
};

async function getMessages(
  orgId: string,
  conversationId: string,
  limit = 200,
): Promise<ThreadMessage[]> {
  const rows = await db()
    .select({
      id: schema.messages.id,
      author: schema.messages.author,
      body: schema.messages.body,
      createdAt: schema.messages.createdAt,
      deliveryStatus: schema.messages.deliveryStatus,
      meta: schema.messages.meta,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.orgId, orgId),
        eq(schema.messages.conversationId, conversationId),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit);
  return rows.reverse().map((m) => ({
    id: m.id,
    author: m.author,
    body: m.body,
    createdAt: m.createdAt,
    deliveryStatus: m.deliveryStatus,
    authorName:
      typeof m.meta?.authorName === "string"
        ? m.meta.authorName
        : m.author === "contact" && typeof m.meta?.from === "string"
          ? m.meta.from
          : null,
  }));
}

export type RequestRow = {
  id: string;
  channel: ChannelKind;
  subject: string | null;
  lastMessageAt: Date;
  agent: AgentLite;
  lastBody: string | null;
  lastAuthor: string | null;
  who: string | null;
  count: number;
};

export async function listRequests(orgId: string): Promise<RequestRow[]> {
  const rows = await db()
    .select({
      id: schema.conversations.id,
      channel: schema.conversations.channel,
      subject: schema.conversations.subject,
      lastMessageAt: schema.conversations.lastMessageAt,
      agent: agentLite,
      who: sql<
        string | null
      >`coalesce(${schema.users.name}, ${schema.contacts.name}, ${schema.contacts.email}, ${schema.contacts.phone}, (select m.meta->>'from' from messages m where m.conversation_id = ${schema.conversations.id} and m.org_id = ${schema.conversations.orgId} and m.author = 'contact' order by m.created_at limit 1))`,
      lastBody: sql<
        string | null
      >`(select m.body from messages m where m.conversation_id = ${schema.conversations.id} and m.org_id = ${orgId} order by m.created_at desc limit 1)`,
      lastAuthor: sql<
        string | null
      >`(select m.author from messages m where m.conversation_id = ${schema.conversations.id} and m.org_id = ${orgId} order by m.created_at desc limit 1)`,
      count: sql<number>`(select count(*)::int from messages m where m.conversation_id = ${schema.conversations.id} and m.org_id = ${orgId})`,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.agents,
      eq(schema.agents.id, schema.conversations.agentId),
    )
    .leftJoin(schema.users, eq(schema.users.id, schema.conversations.userId))
    .leftJoin(
      schema.contacts,
      eq(schema.contacts.id, schema.conversations.contactId),
    )
    .where(
      and(
        eq(schema.conversations.orgId, orgId),
        // Delivery notifications (the team emailing you finished work) aren't requests.
        sql`coalesce(${schema.conversations.externalThreadId}, '') not like 'deliverable:%'`,
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(100);
  return rows.filter((r) => r.count > 0) as RequestRow[];
}

async function getRequestUncached(orgId: string, id: string) {
  if (!isUuid(id)) return null;
  const rows = await db()
    .select({
      id: schema.conversations.id,
      channel: schema.conversations.channel,
      subject: schema.conversations.subject,
      lastMessageAt: schema.conversations.lastMessageAt,
      agent: agentLite,
      who: sql<
        string | null
      >`coalesce(${schema.users.name}, ${schema.contacts.name}, ${schema.contacts.email}, ${schema.contacts.phone}, (select m.meta->>'from' from messages m where m.conversation_id = ${schema.conversations.id} and m.org_id = ${schema.conversations.orgId} and m.author = 'contact' order by m.created_at limit 1))`,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.agents,
      eq(schema.agents.id, schema.conversations.agentId),
    )
    .leftJoin(schema.users, eq(schema.users.id, schema.conversations.userId))
    .leftJoin(
      schema.contacts,
      eq(schema.contacts.id, schema.conversations.contactId),
    )
    .where(
      and(
        eq(schema.conversations.orgId, orgId),
        eq(schema.conversations.id, id),
      ),
    )
    .limit(1);
  const c = rows[0];
  if (!c) return null;
  return {
    ...c,
    agent: c.agent as AgentLite,
    messages: await getMessages(orgId, id),
  };
}

/* ---------------------------------------------------------------- Connect */

export async function getConnect(orgId: string) {
  const [team, slack, sms, emailStatus] = await Promise.all([
    getTeam(orgId),
    db()
      .select({
        status: schema.channelConnections.status,
        config: schema.channelConnections.config,
      })
      .from(schema.channelConnections)
      .where(
        and(
          eq(schema.channelConnections.orgId, orgId),
          eq(schema.channelConnections.kind, "slack"),
        ),
      )
      .limit(1),
    db()
      .select({
        id: schema.channelConnections.id,
        agentId: schema.channelConnections.agentId,
      })
      .from(schema.channelConnections)
      .where(
        and(
          eq(schema.channelConnections.orgId, orgId),
          eq(schema.channelConnections.kind, "sms"),
        ),
      ),
    emailReadiness(orgId),
  ]);
  const smsByAgent = new Map(
    sms.filter((c) => c.agentId).map((c) => [c.agentId!, c.id]),
  );
  const s = slack[0];
  const teamName =
    typeof s?.config?.teamName === "string" ? s.config.teamName : null;
  return {
    agents: team.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      seed: a.seed,
      email: a.email,
      phone: a.phone,
      status: a.status,
      smsConnectionId: smsByAgent.get(a.id) ?? null,
    })),
    emailStatus,
    slack: s ? { status: s.status, teamName } : null,
    appUrl: env().APP_URL,
  };
}

/* ----------------------------------------------------------------- Resell */

export async function getResell(orgId: string) {
  const [customers, plans, agents, knowledge] = await Promise.all([
    db()
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        status: schema.organizations.status,
        createdAt: schema.organizations.createdAt,
      })
      .from(schema.organizations)
      .where(
        and(
          eq(schema.organizations.parentId, orgId),
          eq(schema.organizations.kind, "customer"),
          isNull(schema.organizations.deletedAt),
        ),
      )
      .orderBy(asc(schema.organizations.createdAt)),
    db()
      .select()
      .from(schema.plans)
      .where(and(eq(schema.plans.orgId, orgId), eq(schema.plans.active, true)))
      .orderBy(asc(schema.plans.priceCents)),
    listAgentsLite(orgId),
    // What a reseller MAY choose to share with a customer's copy (nothing is shared unless ticked).
    // Discovery-call transcripts are never offered: they're about the reseller's own business.
    db()
      .select({
        id: schema.knowledgeSources.id,
        title: schema.knowledgeSources.title,
        kind: schema.knowledgeSources.kind,
        agentId: schema.knowledgeSources.agentId,
        chunkCount: schema.knowledgeSources.chunkCount,
      })
      .from(schema.knowledgeSources)
      .where(
        and(
          eq(schema.knowledgeSources.orgId, orgId),
          eq(schema.knowledgeSources.status, "ready"),
          ne(schema.knowledgeSources.kind, "transcript"),
        ),
      )
      .orderBy(asc(schema.knowledgeSources.title))
      .limit(200),
  ]);
  const customerIds = customers.map((c) => c.id);
  const [subs, theirAgents] = customerIds.length
    ? await Promise.all([
        db()
          .select({
            id: schema.subscriptions.id,
            orgId: schema.subscriptions.orgId,
            status: schema.subscriptions.status,
            planName: schema.plans.name,
            priceCents: schema.plans.priceCents,
            currency: schema.plans.currency,
          })
          .from(schema.subscriptions)
          .innerJoin(
            schema.plans,
            eq(schema.plans.id, schema.subscriptions.planId),
          )
          .where(
            and(
              inArray(schema.subscriptions.orgId, customerIds),
              eq(schema.plans.orgId, orgId),
              inArray(schema.subscriptions.status, [
                "active",
                "trialing",
                "past_due",
              ]),
            ),
          ),
        db()
          .select({
            ...agentLite,
            orgId: schema.agents.orgId,
            sourceAgentId: schema.agents.sourceAgentId,
          })
          .from(schema.agents)
          .where(
            and(
              inArray(schema.agents.orgId, customerIds),
              ne(schema.agents.status, "archived"),
            ),
          ),
      ])
    : [[], []];
  const rows = customers.map((c) => {
    const mine = subs.filter((s) => s.orgId === c.id);
    return {
      ...c,
      plans: mine.map((s) => ({
        id: s.id,
        name: s.planName,
        priceCents: s.priceCents,
        status: s.status,
      })),
      monthlyCents: mine
        .filter((s) => s.status !== "past_due")
        .reduce((n, s) => n + s.priceCents, 0),
      agents: theirAgents
        .filter((a) => a.orgId === c.id)
        .map((a) => ({ id: a.id, name: a.name, seed: a.seed, role: a.role })),
    };
  });
  const monthlyCents = rows.reduce((n, r) => n + r.monthlyCents, 0);
  return { customers: rows, plans, agents, monthlyCents, knowledge };
}

/* --------------------------------------------------------------- Settings */

export type NotifyPrefs = {
  channels: ChannelKind[];
  cadence: "instant" | "digest";
};
export const DEFAULT_PREFS: NotifyPrefs = {
  channels: ["email"],
  cadence: "instant",
};

export function readPrefs(org: Org, userId: string): NotifyPrefs {
  const all = (org.settings?.notificationPrefs ?? {}) as Record<
    string,
    Partial<NotifyPrefs>
  >;
  const p = all[userId];
  return {
    channels: Array.isArray(p?.channels)
      ? (p.channels as ChannelKind[])
      : DEFAULT_PREFS.channels,
    cadence: p?.cadence === "digest" ? "digest" : "instant",
  };
}

export async function getSettings(orgId: string) {
  const [members, invites] = await Promise.all([
    db()
      .select({
        id: schema.memberships.id,
        userId: schema.users.id,
        role: schema.memberships.role,
        name: schema.users.name,
        email: schema.users.email,
        createdAt: schema.memberships.createdAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.orgId, orgId))
      .orderBy(asc(schema.memberships.createdAt)),
    db()
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.role,
        expiresAt: schema.invitations.expiresAt,
        createdAt: schema.invitations.createdAt,
      })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.orgId, orgId),
          isNull(schema.invitations.acceptedAt),
          gte(schema.invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(schema.invitations.createdAt)),
  ]);
  return { members, invites };
}

/* ---------------------------------------------------------------- helpers */

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v,
  );
}

export type { Role };

/* Detail reads are cached per request: the segment layout checks existence (so a miss is a real 404, outside
   any loading boundary) and the page reuses the same result. */
export const getDeliverable = cache(getDeliverableUncached);
export const getRequest = cache(getRequestUncached);
export const getAgentPage = cache(getAgentPageUncached);

/* ----------------------------------------------------------------- ⌘K */

export type PaletteDeliverable = {
  id: string;
  title: string;
  agentName: string;
};

/** What the portal's ⌘K offers before you type: teammates, what's waiting on you, and recent work. Org-scoped. */
export async function getPaletteData(orgId: string): Promise<{
  agents: AgentLite[];
  needs: PaletteDeliverable[];
  recent: PaletteDeliverable[];
}> {
  const pick = {
    id: schema.deliverables.id,
    title: schema.deliverables.title,
    agentName: schema.agents.name,
  };
  const [agents, needs, recent] = await Promise.all([
    listAgentsLite(orgId),
    db()
      .select(pick)
      .from(schema.deliverables)
      .innerJoin(
        schema.agents,
        eq(schema.agents.id, schema.deliverables.agentId),
      )
      .where(
        and(
          eq(schema.deliverables.orgId, orgId),
          eq(schema.deliverables.needsReview, true),
          inArray(schema.deliverables.status, ["new", "seen"]),
        ),
      )
      .orderBy(desc(schema.deliverables.createdAt))
      .limit(5),
    db()
      .select(pick)
      .from(schema.deliverables)
      .innerJoin(
        schema.agents,
        eq(schema.agents.id, schema.deliverables.agentId),
      )
      .where(
        and(
          eq(schema.deliverables.orgId, orgId),
          ne(schema.deliverables.status, "archived"),
        ),
      )
      .orderBy(desc(schema.deliverables.createdAt))
      .limit(6),
  ]);
  return { agents, needs, recent };
}

/** Title search over this org's deliverables for ⌘K. Capped at 8; LIKE wildcards in the query are literal. */
export async function searchDeliverables(
  orgId: string,
  q: string,
): Promise<PaletteDeliverable[]> {
  const term = q.trim().slice(0, 100);
  if (!term) return [];
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db()
    .select({
      id: schema.deliverables.id,
      title: schema.deliverables.title,
      agentName: schema.agents.name,
    })
    .from(schema.deliverables)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.deliverables.agentId))
    .where(
      and(
        eq(schema.deliverables.orgId, orgId),
        ne(schema.deliverables.status, "archived"),
        sql`${schema.deliverables.title} ilike ${`%${escaped}%`}`,
      ),
    )
    .orderBy(desc(schema.deliverables.createdAt))
    .limit(8);
}
