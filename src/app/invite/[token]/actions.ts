"use server";

import { and, eq, gt, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIp, getCurrentUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { audit } from "@/server/security/audit";
import { sha256 } from "@/server/security/crypto";
import { rateLimit } from "@/server/security/rate-limit";

export type InviteState = { error?: string } | undefined;

const input = z.object({
  token: z.string().min(20).max(200),
});

/**
 * Accept an invitation. Security model (see security-r2 H2):
 * - The invite link is visible to whoever sent it, so holding it proves nothing about the invitee.
 * - Acceptance therefore needs a signed-in account whose email is VERIFIED and equals the invite email.
 *   Everyone else gets an email sign-in link to the invited address (InviteForm), which verifies the
 *   address and returns here signed in.
 * - Accepting never creates accounts, never signs anyone in, and never marks an email verified.
 */
export async function acceptInvite(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const parsed = input.safeParse({ token: formData.get("token") });
  if (!parsed.success) return { error: "This invite link isn’t valid." };
  const { token } = parsed.data;
  const h = await headers();
  const ip = clientIp(h) ?? "unknown";
  const rl = await rateLimit(`invite:${ip}`, 12, 60);
  if (!rl.ok) return { error: "Too many tries. Wait a minute and try again." };

  const [invite] = await db()
    .select({
      inv: schema.invitations,
      slug: schema.organizations.slug,
      kind: schema.organizations.kind,
    })
    .from(schema.invitations)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.invitations.orgId),
    )
    .where(
      and(
        eq(schema.invitations.tokenHash, sha256(token)),
        isNull(schema.invitations.acceptedAt),
        gt(schema.invitations.expiresAt, new Date()),
        isNull(schema.organizations.deletedAt),
      ),
    )
    .limit(1);
  if (!invite)
    return {
      error: "This invite has expired or was already used. Ask for a new one.",
    };
  const email = invite.inv.email.toLowerCase();

  const current = await getCurrentUser();
  if (!current) return { error: "Sign in as the invited address first." };
  if (current.email.toLowerCase() !== email)
    return {
      error: `This invite is for ${email}. Sign out and open the link again.`,
    };
  if (!current.emailVerifiedAt)
    return { error: `Confirm ${email} first: we’ll email you a sign-in link.` };
  const userId = current.id;

  // Single use: claim the invite atomically, then add the membership.
  const claimed = await db()
    .update(schema.invitations)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(schema.invitations.id, invite.inv.id),
        isNull(schema.invitations.acceptedAt),
      ),
    )
    .returning({ id: schema.invitations.id });
  if (!claimed.length) return { error: "This invite was already used." };
  await db()
    .insert(schema.memberships)
    .values({ userId, orgId: invite.inv.orgId, role: invite.inv.role })
    .onConflictDoNothing({
      target: [schema.memberships.userId, schema.memberships.orgId],
    });
  await audit({
    orgId: invite.inv.orgId,
    actorType: "user",
    actorId: userId,
    action: "invitation.accepted",
    targetType: "invitation",
    targetId: invite.inv.id,
    ip,
  });
  redirect(
    invite.kind === "agency" ? `/a/${invite.slug}` : `/p/${invite.slug}`,
  );
}
