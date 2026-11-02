import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db/client";
import { sha256 } from "@/server/security/crypto";
import { resolveBrand, type PortalBrand } from "@/server/queries/portal";

type Org = typeof schema.organizations.$inferSelect;

/**
 * Who an auth page is for. Client and customer flows (an invite token, ?org=, or a `next` into /p/<slug> or an invite)
 * are branded as the client's provider — never as Roster. Agency sign-up and sign-in keep Roster branding (null).
 */
export async function authBrand(sp: { org?: string; token?: string; next?: string }): Promise<PortalBrand | null> {
  try {
    let token = sp.token;
    let slug = sp.org;
    const next = typeof sp.next === "string" ? sp.next : "";
    if (!token && next.startsWith("/invite")) token = new URLSearchParams(next.split("?")[1] ?? "").get("token") ?? undefined;
    if (!token && next.startsWith("/invite/")) token = next.slice("/invite/".length).split(/[?#]/)[0];
    if (!slug) slug = /^\/p\/([a-z0-9-]{1,64})(?:[/?#]|$)/.exec(next)?.[1];

    let org: Org | undefined;
    if (token && token.length < 200) {
      const [inv] = await db()
        .select({ orgId: schema.invitations.orgId })
        .from(schema.invitations)
        .where(and(eq(schema.invitations.tokenHash, sha256(token)), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date())))
        .limit(1);
      if (inv) [org] = await db().select().from(schema.organizations).where(eq(schema.organizations.id, inv.orgId)).limit(1);
    }
    if (!org && slug && /^[a-z0-9-]{1,64}$/.test(slug)) {
      [org] = await db().select().from(schema.organizations).where(and(eq(schema.organizations.slug, slug), isNull(schema.organizations.deletedAt))).limit(1);
    }
    if (!org || org.kind === "agency") return null;

    const chain: Org[] = [org];
    let parentId = org.parentId;
    while (parentId && chain.length < 3) {
      const [p] = await db().select().from(schema.organizations).where(eq(schema.organizations.id, parentId)).limit(1);
      if (!p) break;
      chain.push(p);
      parentId = p.parentId;
    }
    return resolveBrand(chain as Parameters<typeof resolveBrand>[0]);
  } catch {
    return null;
  }
}
