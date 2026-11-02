import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Mail } from "lucide-react";
import { requireOrg } from "@/server/auth/access";
import { getAgent } from "@/server/queries/studio";
import { AgentOrb } from "@/components/ui/agent-orb";
import { AgentStatus } from "@/components/studio/bits";
import { AgentMenu, AgentTabs, CopyInline } from "@/components/studio/agent-header";

export async function generateMetadata({ params }: { params: Promise<{ agency: string; agentId: string }> }) {
  const { agency, agentId } = await params;
  const { org } = await requireOrg(agency, "viewer");
  const found = await getAgent(org.id, agentId);
  return { title: found ? `${found.agent.name} · ${found.org.name}` : "Agent" };
}

export default async function AgentLayout({ children, params }: { children: React.ReactNode; params: Promise<{ agency: string; agentId: string }> }) {
  const { agency: slug, agentId } = await params;
  const { org: agency } = await requireOrg(slug, "viewer");
  const found = await getAgent(agency.id, agentId);
  if (!found) notFound();
  const { agent, org, inbox } = found;
  const base = `/a/${slug}/agents/${agent.id}`;
  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 pt-6 sm:px-6 md:px-10 md:pt-9">
      <nav aria-label="Breadcrumb" className="mb-5 flex items-center gap-1 text-[12.5px] text-ink-3">
        <Link href={`/a/${slug}/clients/${org.slug}`} className="hover:text-ink-2">{org.name}</Link>
        <ChevronRight className="size-3" aria-hidden />
        <span aria-current="page" className="truncate text-ink-3">{agent.name}</span>
      </nav>
      <header className="flex items-start gap-4">
        <AgentOrb seed={agent.avatarSeed ?? agent.id} size={48} live={agent.status === "active"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">{agent.name}</h1>
            <AgentStatus status={agent.status} />
          </div>
          <p className="mt-0.5 text-[14px] text-ink-3">
            {agent.role} for {org.name}
          </p>
          {inbox ? (
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-ink-4">
              <Mail className="size-3.5 shrink-0" aria-hidden />
              <CopyInline value={inbox} label="inbox address" />
            </div>
          ) : null}
        </div>
        <AgentMenu agency={slug} agentId={agent.id} status={agent.status} name={agent.name} portalHref={`/p/${org.slug}`} />
      </header>
      <div className="mt-6 border-b border-line">
        <AgentTabs base={base} />
      </div>
      <div className="py-8">{children}</div>
    </div>
  );
}
