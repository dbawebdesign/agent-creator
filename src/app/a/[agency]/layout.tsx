import Link from "next/link";
import { notFound } from "next/navigation";
import { StudioShell } from "@/components/studio/shell";
import { Toaster } from "@/components/shared/toaster";
import { requireOrg, userOrgs } from "@/server/auth/access";
import { getShellData } from "@/server/queries/studio";
import { signOut } from "@/app/(auth)/actions";

export default async function StudioLayout({ children, params }: { children: React.ReactNode; params: Promise<{ agency: string }> }) {
  const { agency: slug } = await params;
  const access = await requireOrg(slug, "viewer");
  if (access.org.kind !== "agency") notFound();
  const [shell, orgs] = await Promise.all([getShellData(access.org.id), userOrgs(access.user.id)]);
  const agencies = orgs.filter((o) => o.org.kind === "agency").map((o) => ({ name: o.org.name, slug: o.org.slug }));
  if (!agencies.some((a) => a.slug === access.org.slug)) agencies.unshift({ name: access.org.name, slug: access.org.slug });
  return (
    <>
      <StudioShell
        agency={{ name: access.org.name, slug: access.org.slug }}
        agencies={agencies}
        user={{ name: access.user.name, email: access.user.email }}
        clients={shell.clients}
        agents={shell.agents}
        signOut={signOut}
      >
        {!access.user.emailVerifiedAt ? (
          <div role="status" className="border-b border-warn/25 bg-warn-soft px-4 py-2.5 text-[13px] text-ink-2 sm:px-6 md:px-10">
            <span className="font-medium text-ink">Verify your email.</span> Inviting people and billing unlock once you confirm {access.user.email}.{" "}
            <Link href={`/magic-link?next=${encodeURIComponent(`/a/${slug}`)}`} className="font-medium text-ink underline underline-offset-2">
              Send me a link
            </Link>
          </div>
        ) : null}
        {children}
      </StudioShell>
      <Toaster />
    </>
  );
}
