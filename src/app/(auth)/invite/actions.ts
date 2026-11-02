"use server";

import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { homePathFor } from "@/server/auth/access";
import { requireUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { audit } from "@/server/security/audit";
import { sha256 } from "@/server/security/crypto";

export async function acceptInvite(_prev: { error?: string } | undefined, formData: FormData): Promise<{ error?: string } | undefined> {
  const token = z.string().min(10).max(200).safeParse(formData.get("token"));
  if (!token.success) return { error: "This invitation link is invalid." };
  const user = await requireUser();
  const [inv] = await db()
    .select({ inv: schema.invitations, org: schema.organizations })
    .from(schema.invitations)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.invitations.orgId))
    .where(and(eq(schema.invitations.tokenHash, sha256(token.data)), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date())))
    .limit(1);
  if (!inv) return { error: "This invitation has expired or was already used." };
  if (inv.inv.email.toLowerCase() !== user.email.toLowerCase()) return { error: `This invitation is for ${inv.inv.email}. Sign in with that address to accept it.` };
  await db().transaction(async (tx) => {
    await tx.insert(schema.memberships).values({ userId: user.id, orgId: inv.org.id, role: inv.inv.role }).onConflictDoNothing();
    await tx.update(schema.invitations).set({ acceptedAt: new Date() }).where(eq(schema.invitations.id, inv.inv.id));
  });
  await audit({ orgId: inv.org.id, actorType: "user", actorId: user.id, action: "invitation.accepted", targetType: "invitation", targetId: inv.inv.id });
  redirect(inv.org.kind === "agency" ? `/a/${inv.org.slug}` : inv.org.kind ? `/p/${inv.org.slug}` : await homePathFor(user.id));
}
