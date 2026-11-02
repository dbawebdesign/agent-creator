import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { requireOrg } from "@/server/auth/access";
import { listAgents } from "@/server/queries/studio";
import { AgentOrb } from "@/components/ui/agent-orb";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { RelativeTime } from "@/components/shared/relative-time";
import { AgentStatus, hours } from "@/components/studio/bits";

export const metadata = { title: "Agents" };

export default async function AgentsPage({ params }: { params: Promise<{ agency: string }> }) {
  const { agency: slug } = await params;
  const { org } = await requireOrg(slug, "viewer");
  const agents = await listAgents(org.id);
  const week = agents.reduce((s, a) => s + a.hoursWeek, 0);
  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">Agents</h1>
          <p className="mt-1 text-[14px] text-ink-3">
            {agents.length} on the roster · {hours(week)} saved this week
          </p>
        </div>
        <Link href={`/a/${slug}/agents/new`} className={buttonClass("primary", "md")}>
          <Plus /> New agent
        </Link>
      </header>
      {agents.length ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
          <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_110px_120px_120px] gap-4 border-b border-line px-5 py-2.5 text-[12px] font-medium text-ink-4 md:grid">
            <span>Agent</span>
            <span>Client</span>
            <span>Status</span>
            <span>Next run</span>
            <span className="text-right">Saved this week</span>
          </div>
          <ul className="divide-y divide-line">
            {agents.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/a/${slug}/agents/${a.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors hover:bg-surface-2/50 sm:px-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_110px_120px_120px]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <AgentOrb seed={a.avatarSeed ?? a.id} size={30} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{a.name}</span>
                      <span className="block truncate text-[12px] text-ink-4">{a.role}</span>
                    </span>
                  </span>
                  <span className="hidden truncate text-[13px] text-ink-2 md:block">
                    {a.orgName}
                    {a.orgKind === "customer" ? <span className="ml-1.5 text-[11.5px] text-ink-4">resale</span> : null}
                  </span>
                  <span className="justify-self-end md:justify-self-start">
                    <AgentStatus status={a.status} />
                  </span>
                  <span className="hidden text-[12.5px] text-ink-3 md:block">{a.nextRunAt ? <RelativeTime date={a.nextRunAt} /> : <span className="text-ink-4">—</span>}</span>
                  <span className="tabular hidden text-right text-[13px] text-ink-2 md:block">{a.hoursWeek ? hours(a.hoursWeek) : <span className="text-ink-4">—</span>}</span>
                  <span className="col-span-2 truncate text-[12px] text-ink-4 md:hidden">
                    {a.orgName} · {a.workflows} workflow{a.workflows === 1 ? "" : "s"}
                    {a.lastDeliveryAt ? <> · delivered <RelativeTime date={a.lastDeliveryAt} /></> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState
            icon={<Bot />}
            title="No agents yet"
            body="Paste a discovery call and the Architect will propose your first AI employee."
            action={
              <Link href={`/a/${slug}/agents/new`} className={buttonClass("primary", "md")}>
                <Plus /> New agent
              </Link>
            }
          />
        </div>
      )}
    </div>
  );
}
