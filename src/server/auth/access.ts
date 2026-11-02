import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/server/db/client";
import { requireUser, type SessionUser } from "./session";

export type Org = typeof schema.organizations.$inferSelect;
export type Role = "owner" | "admin" | "member" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export type OrgAccess = {
  user: SessionUser;
  org: Org;
  /** Effective role: direct membership, or inherited from an ancestor (agency staff). */
  role: Role;
  /** True when access comes from an ancestor org (e.g. agency staff viewing a client). */
  inherited: boolean;
  /** The org the membership actually lives on. */
  via: Org;
};

/** Ancestor chain [self, parent, grandparent] (max depth 3). */
export async function orgChain(orgId: string): Promise<Org[]> {
  const chain: Org[] = [];
  let current: string | null = orgId;
  for (let i = 0; i < 4 && current; i++) {
    const rows: Org[] = await db()
      .select()
      .from(schema.organizations)
      .where(and(eq(schema.organizations.id, current), isNull(schema.organizations.deletedAt)))
      .limit(1);
    const org = rows[0];
    if (!org) break;
    chain.push(org);
    current = org.parentId;
  }
  return chain;
}

/**
 * Resolve a user's access to an org. Memberships on an ancestor grant access to
 * descendants (agency → client → customer). Returns null when there is no access.
 */
export async function resolveAccess(user: SessionUser, orgId: string): Promise<OrgAccess | null> {
  const chain = await orgChain(orgId);
  const org = chain[0];
  if (!org) return null;
  const ids = chain.map((o) => o.id);
  const ms = await db()
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, user.id), inArray(schema.memberships.orgId, ids)));
  // Nearest membership wins (direct beats inherited).
  for (const o of chain) {
    const m = ms.find((x) => x.orgId === o.id);
    if (m) return { user, org, role: m.role, inherited: o.id !== org.id, via: o };
  }
  if (user.isPlatformAdmin) return { user, org, role: "owner", inherited: true, via: org };
  return null;
}

export async function orgBySlug(slug: string): Promise<Org | null> {
  const rows = await db()
    .select()
    .from(schema.organizations)
    .where(and(eq(schema.organizations.slug, slug), isNull(schema.organizations.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Page/action guard: the current user must have at least `min` on the org with `slug`.
 * 404s (not 403s) on missing access so org existence is not leaked.
 */
export const requireOrg = cache(async (slug: string, min: Role = "viewer"): Promise<OrgAccess> => {
  const user = await requireUser();
  const org = await orgBySlug(slug);
  if (!org) notFound();
  const access = await resolveAccess(user, org.id);
  if (!access || RANK[access.role] < RANK[min]) notFound();
  return access;
});

export async function requireOrgById(orgId: string, min: Role = "viewer"): Promise<OrgAccess> {
  const user = await requireUser();
  const access = await resolveAccess(user, orgId);
  if (!access || RANK[access.role] < RANK[min]) notFound();
  return access;
}

export function hasRole(access: Pick<OrgAccess, "role">, min: Role): boolean {
  return RANK[access.role] >= RANK[min];
}

/** All orgs the user belongs to directly, for the workspace switcher and post-login routing. */
export async function userOrgs(userId: string) {
  return db()
    .select({ org: schema.organizations, role: schema.memberships.role })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(and(eq(schema.memberships.userId, userId), isNull(schema.organizations.deletedAt)));
}

/** Where to send a user after login: agency console if they staff an agency, else their portal. */
export async function homePathFor(userId: string): Promise<string> {
  const orgs = await userOrgs(userId);
  const agency = orgs.find((o) => o.org.kind === "agency");
  if (agency) return `/a/${agency.org.slug}`;
  const portal = orgs[0];
  if (portal) return `/p/${portal.org.slug}`;
  return "/onboarding";
}

export async function redirectHome(userId: string): Promise<never> {
  redirect(await homePathFor(userId));
}
