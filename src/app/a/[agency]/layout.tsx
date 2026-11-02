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
        {children}
      </StudioShell>
      <Toaster />
    </>
  );
}
