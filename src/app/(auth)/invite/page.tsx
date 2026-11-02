import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getCurrentUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { sha256 } from "@/server/security/crypto";
import { AcceptForm } from "./accept-form";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const row = token
    ? (
        await db()
          .select({ email: schema.invitations.email, role: schema.invitations.role, orgName: schema.organizations.name, branding: schema.organizations.branding })
          .from(schema.invitations)
          .innerJoin(schema.organizations, eq(schema.organizations.id, schema.invitations.orgId))
          .where(and(eq(schema.invitations.tokenHash, sha256(token)), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date())))
          .limit(1)
      )[0]
    : undefined;
  if (!token || !row) {
    return (
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">This invitation isn’t valid</h1>
        <p className="mt-1.5 text-[14px] text-ink-3">It may have expired or already been used. Ask whoever invited you for a new link.</p>
      </div>
    );
  }
  const user = await getCurrentUser();
  const next = `/invite?token=${encodeURIComponent(token)}`;
  const name = row.branding.displayName || row.orgName;
  return (
    <div>
      <p className="text-[13px] font-medium text-ink-3">You’re invited</p>
      <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink">Join {name}</h1>
      <p className="mt-1.5 mb-7 text-[14px] text-ink-3">
        As {row.role === "owner" ? "an owner" : `a ${row.role}`} · for {row.email}
      </p>
      {user ? (
        <AcceptForm token={token} />
      ) : (
        <div className="space-y-2.5">
          <Link href={`/magic-link?next=${encodeURIComponent(next)}`} className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-ink text-sm font-medium text-canvas hover:bg-ink-2">
            Continue with email
          </Link>
          <Link href={`/login?next=${encodeURIComponent(next)}`} className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-line bg-surface text-sm font-medium text-ink hover:bg-surface-2">
            I have a password
          </Link>
        </div>
      )}
    </div>
  );
}
