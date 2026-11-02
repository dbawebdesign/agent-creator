import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { requireOrg } from "@/server/auth/access";
import { agentTotals, listAgents } from "@/server/queries/studio";
import { ListSearch, Pager, parsePage } from "@/components/studio/list-controls";
import { AgentOrb } from "@/components/ui/agent-orb";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { RelativeTime } from "@/components/shared/relative-time";
import { AgentStatus, hours } from "@/components/studio/bits";

export const metadata = { title: "Agents" };

export default async function AgentsPage({ params, searchParams }: { params: Promise<{ agency: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const [{ agency: slug }, sp] = await Promise.all([params, searchParams]);
  const { org } = await requireOrg(slug, "viewer");
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : undefined;
  const page = parsePage(sp.page);
  const [list, totals] = await Promise.all([listAgents(org.id, { page, q }), agentTotals(org.id)]);
  const agents = list.items;
  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">Agents</h1>
          <p className="mt-1 text-[14px] text-ink-3">
            {totals.count.toLocaleString()} on the roster · {hours(totals.hoursWeek)} saved this week
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {totals.count > 10 || q ? <ListSearch action={`/a/${slug}/agents`} q={q} placeholder="Search agents or clients" /> : null}
          <Link href={`/a/${slug}/agents/new`} className={buttonClass("primary", "md", "shrink-0")}>
            <Plus /> New agent
          </Link>
        </div>
      </header>
      {agents.length ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
          <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_110px_120px_120px] gap-4 border-b border-line px-5 py-2.5 text-[12px] font-medium text-ink-3 md:grid">
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
                    <AgentOrb seed={a.avatarSeed ?? a.id} size={30} name={a.name} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{a.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">{a.role}</span>
                    </span>
                  </span>
                  <span className="hidden truncate text-[13px] text-ink-2 md:block">
                    {a.orgName}
                    {a.orgKind === "customer" ? <span className="ml-1.5 text-[11.5px] text-ink-3">resale</span> : null}
                  </span>
                  <span className="justify-self-end md:justify-self-start">
                    <AgentStatus status={a.status} createdAt={a.createdAt} onlyExceptions />
                  </span>
                  <span className="hidden text-[12.5px] text-ink-3 md:block">{a.nextRunAt ? <RelativeTime date={a.nextRunAt} /> : <span className="text-ink-3">—</span>}</span>
                  <span className="tabular hidden text-right text-[13px] text-ink-2 md:block">{a.hoursWeek ? hours(a.hoursWeek) : <span className="text-ink-3">—</span>}</span>
                  <span className="col-span-2 truncate text-[12px] text-ink-3 md:hidden">
                    {a.orgName} · {a.workflows} workflow{a.workflows === 1 ? "" : "s"}
                    {a.lastDeliveryAt ? <> · delivered <RelativeTime date={a.lastDeliveryAt} /></> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : q ? (
        <p className="rounded-xl border border-dashed border-line px-5 py-8 text-center text-[13.5px] text-ink-3">No agents match “{q}”.</p>
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
      <Pager base={`/a/${slug}/agents`} page={list.page} more={list.more} q={q} shown={agents.length} />
    </div>
  );
}
