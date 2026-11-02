"use server";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticate, clientIp, createSession, createUser, findUserByEmail, getCurrentUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { audit } from "@/server/security/audit";
import { sha256 } from "@/server/security/crypto";
import { rateLimit } from "@/server/security/rate-limit";

export type InviteState = { error?: string } | undefined;

const input = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().max(80).optional(),
  password: z.string().max(200).optional(),
});

export async function acceptInvite(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const parsed = input.safeParse({
    token: formData.get("token"),
    name: formData.get("name") ?? undefined,
    password: formData.get("password") ?? undefined,
  });
  if (!parsed.success) return { error: "This invite link isn’t valid." };
  const { token, name, password } = parsed.data;
  const h = await headers();
  const ip = clientIp(h) ?? "unknown";
  const rl = await rateLimit(`invite:${ip}`, 12, 60);
  if (!rl.ok) return { error: "Too many tries. Wait a minute and try again." };

  const [invite] = await db()
    .select({ inv: schema.invitations, slug: schema.organizations.slug, kind: schema.organizations.kind })
    .from(schema.invitations)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.invitations.orgId))
    .where(
      and(
        eq(schema.invitations.tokenHash, sha256(token)),
        isNull(schema.invitations.acceptedAt),
        gt(schema.invitations.expiresAt, new Date()),
        isNull(schema.organizations.deletedAt),
      ),
    )
    .limit(1);
  if (!invite) return { error: "This invite has expired or was already used. Ask for a new one." };
  const email = invite.inv.email.toLowerCase();

  // Who is accepting?
  let userId: string;
  const current = await getCurrentUser();
  if (current) {
    if (current.email.toLowerCase() !== email) return { error: `This invite is for ${email}. Sign out and open the link again.` };
    userId = current.id;
  } else {
    const existing = await findUserByEmail(email);
    if (existing) {
      const user = password ? await authenticate(email, password) : null;
      if (!user) return { error: "That password didn’t match." };
      userId = user.id;
    } else {
      if (!password || password.length < 8) return { error: "Choose a password with at least 8 characters." };
      const user = await createUser({ email, name: name || undefined, password });
      userId = user.id;
    }
  }

  // Single use: claim the invite atomically, then add the membership.
  const claimed = await db()
    .update(schema.invitations)
    .set({ acceptedAt: new Date() })
    .where(and(eq(schema.invitations.id, invite.inv.id), isNull(schema.invitations.acceptedAt)))
    .returning({ id: schema.invitations.id });
  if (!claimed.length) return { error: "This invite was already used." };
  await db()
    .insert(schema.memberships)
    .values({ userId, orgId: invite.inv.orgId, role: invite.inv.role })
    .onConflictDoNothing({ target: [schema.memberships.userId, schema.memberships.orgId] });
  // The invite link proves they control the address.
  await db()
    .update(schema.users)
    .set({ emailVerifiedAt: sql`coalesce(${schema.users.emailVerifiedAt}, now())` })
    .where(eq(schema.users.id, userId));
  await audit({
    orgId: invite.inv.orgId,
    actorType: "user",
    actorId: userId,
    action: "invitation.accepted",
    targetType: "invitation",
    targetId: invite.inv.id,
    ip,
  });
  if (!current) await createSession(userId);
  redirect(invite.kind === "agency" ? `/a/${invite.slug}` : `/p/${invite.slug}`);
}
