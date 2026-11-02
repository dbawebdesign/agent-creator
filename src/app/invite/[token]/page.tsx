import Link from "next/link";
import { eq } from "drizzle-orm";
import { BrandMark } from "@/components/portal/shell";
import { orgChain } from "@/server/auth/access";
import { findUserByEmail, getCurrentUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { resolveBrand } from "@/server/queries/portal";
import { sha256 } from "@/server/security/crypto";
import { InviteForm } from "./form";
import "@/components/portal/portal.css";
import { brandVars } from "@/components/portal/brand-color";

export const metadata = { title: "You’re invited", robots: { index: false } };

function Shell({ accent, children }: { accent: string | null; children: React.ReactNode }) {
  return (
    <div className="portal-root flex min-h-dvh items-start justify-center px-4 pt-[12vh] pb-16" data-brand={accent ? "" : undefined}>
      {accent ? <style>{brandVars(accent)}</style> : null}
      <div className="w-full max-w-[400px] animate-rise">{children}</div>
    </div>
  );
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = /^[A-Za-z0-9_-]{20,200}$/.test(token);
  const [row] = valid
    ? await db()
        .select({ inv: schema.invitations, inviter: schema.users.name })
        .from(schema.invitations)
        .leftJoin(schema.users, eq(schema.users.id, schema.invitations.invitedBy))
        .where(eq(schema.invitations.tokenHash, sha256(token)))
        .limit(1)
    : [];
  const chain = row ? await orgChain(row.inv.orgId) : [];
  const org = chain[0];
  const expired = !row || !org || row.inv.acceptedAt || row.inv.expiresAt < new Date();

  if (expired) {
    return (
      <Shell accent={null}>
        <div className="rounded-2xl border border-line bg-surface p-7 text-center shadow-sm">
          <p className="text-[16px] font-semibold text-ink">{row?.inv.acceptedAt ? "This invite was already used" : "This invite has expired"}</p>
          <p className="mt-1.5 text-[13.5px] text-ink-3">Ask whoever invited you to send a fresh link{row?.inv.acceptedAt ? ", or sign in if it was you." : "."}</p>
          <Link href="/login" className="mt-6 inline-block text-[13.5px] font-medium text-accent-text hover:underline">
            Sign in
          </Link>
        </div>
      </Shell>
    );
  }

  const brand = resolveBrand(chain);
  const email = row.inv.email.toLowerCase();
  const current = await getCurrentUser();
  const mismatch = current && current.email.toLowerCase() !== email;
  const mode = current ? "join" : (await findUserByEmail(email)) ? "signin" : "signup";
  const inviter = row.inviter?.split(/\s+/)[0];
  const forCustomer = org.kind === "customer";

  return (
    <Shell accent={brand.accent}>
      <div className="mb-8 flex items-center justify-center gap-2.5">
        <BrandMark name={brand.name} logoUrl={brand.logoUrl} size={30} />
        <span className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{brand.name}</span>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm md:p-7">
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink text-balance">
          {inviter ? `${inviter} invited you to ${org.name}` : `You’re invited to ${org.name}`}
        </h1>
        <p className="mt-1.5 text-[13.5px] text-ink-3 text-pretty">
          {forCustomer
            ? `Your AI teammates from ${brand.name} — their finished work, approvals and requests, all in one place.`
            : "See what your AI team finished, approve their work in a tap, and ask for anything."}
        </p>
        <div className="mt-6">
          {mismatch ? (
            <div className="space-y-4">
              <p className="rounded-md bg-warn-soft px-3 py-2.5 text-[13px] text-warn">
                You’re signed in as {current.email}, but this invite is for {email}.
              </p>
              <form action="/logout" method="post">
                <button type="submit" className="w-full rounded-lg border border-line bg-surface py-2.5 text-[13.5px] font-medium text-ink hover:bg-surface-2">
                  Sign out, then reopen this link
                </button>
              </form>
            </div>
          ) : (
            <InviteForm token={token} mode={mode} email={email} orgName={org.name} />
          )}
        </div>
      </div>
      {!brand.whiteLabel ? <p className="mt-8 text-center text-[12px] text-ink-3">Powered by Roster</p> : null}
    </Shell>
  );
}
