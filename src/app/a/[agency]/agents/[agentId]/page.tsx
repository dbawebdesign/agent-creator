import Link from "next/link";
import { notFound } from "next/navigation";
import { Brain, CalendarClock, Inbox, Library, Mail, Monitor, Radio, ShieldAlert, Sparkles, Zap } from "lucide-react";
import { ApprovalActions } from "@/components/studio/approval-actions";
import { requireOrg } from "@/server/auth/access";
import { agentApprovals, agentChannels, agentDeliverables, agentKnowledge, agentMemories, agentValue, agentWorkflows, getAgent } from "@/server/queries/studio";
import { RelativeTime } from "@/components/shared/relative-time";
import { DeliverableList } from "@/components/studio/deliverable-list";
import { CHANNEL_LABEL, hours, microsToDollars, SectionHeading, Stat, TextLink } from "@/components/studio/bits";
import { describeTrigger } from "@/components/studio/cron";
import { cn } from "@/lib/utils";

export default async function AgentOverview({ params, searchParams }: { params: Promise<{ agency: string; agentId: string }>; searchParams: Promise<{ welcome?: string }> }) {
  const [{ agency: slug, agentId }, sp] = await Promise.all([params, searchParams]);
  const { org: agency } = await requireOrg(slug, "viewer");
  const found = await getAgent(agency.id, agentId);
  if (!found) notFound();
  const { agent, inbox } = found;
  const [deliverables, workflows, value, memories, knowledge, channels, approvals] = await Promise.all([
    agentDeliverables(agent.orgId, agent.id, 8),
    agentWorkflows(agent.orgId, agent.id),
    agentValue(agent.orgId, agent.id),
    agentMemories(agent.orgId, agent.id),
    agentKnowledge(agent.orgId, agent.id),
    agentChannels(agent.orgId, agent.id),
    agentApprovals(agent.orgId, agent.id),
  ]);
  const base = `/a/${slug}/agents/${agent.id}`;
  const enabled = workflows.filter((w) => w.enabled);
  const weekly = enabled.reduce((s, w) => {
    if (w.trigger.type !== "schedule") return s + w.hoursSavedPerRun * 3;
    const dow = w.trigger.cron.split(" ")[4] ?? "*";
    const per = dow === "*" ? 7 : dow === "1-5" ? 5 : dow.split(",").length;
    return s + w.hoursSavedPerRun * per;
  }, 0);
  const channelKinds = [...new Set([...(agent.config.defaultDelivery ?? []), ...channels.filter((c) => c.status === "connected").map((c) => c.kind), ...enabled.flatMap((w) => w.deliverTo)])];

  const stack = [
    { icon: Brain, label: "Memory", value: `${memories.length} memor${memories.length === 1 ? "y" : "ies"}`, href: `${base}/memory`, ok: memories.length > 0 },
    { icon: Library, label: "Knowledge", value: `${knowledge.length} source${knowledge.length === 1 ? "" : "s"}`, href: `${base}/knowledge`, ok: knowledge.length > 0 },
    { icon: Mail, label: "Inbox", value: inbox ?? "Not assigned", ok: !!inbox },
    { icon: Monitor, label: "Computer", value: agent.computerStatus === "ready" ? "Cloud computer ready" : agent.computerStatus === "starting" ? "Starting…" : agent.computerStatus === "error" ? "Error" : "Worker runtime", ok: agent.computerStatus !== "error" },
    { icon: Radio, label: "Channels", value: channelKinds.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") || "Portal", ok: true },
  ];

  return (
    <div className="space-y-12">
      {sp.welcome ? (
        <div className="flex items-start gap-3 rounded-xl border border-accent/25 bg-accent-soft/60 px-5 py-4 animate-rise">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <div className="text-[13.5px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">{agent.name} is on the roster.</span> The first overnight deliverable is queued — it lands in the client’s portal by morning. Share the inbox address so the team can email {agent.name} directly.
          </div>
        </div>
      ) : null}

      {approvals.length ? (
        <section aria-label="Waiting for approval" className="space-y-2">
          {approvals.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-warn/25 bg-warn-soft px-4 py-3">
              <ShieldAlert className="size-4 shrink-0 text-warn" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-ink">{a.description}</p>
                <p className="text-[12px] text-ink-3">
                  Waiting for approval · <RelativeTime date={a.createdAt} />
                </p>
              </div>
              <ApprovalActions agency={slug} approvalId={a.id} />
            </div>
          ))}
        </section>
      ) : null}

      <section aria-label="Value delivered" className="grid grid-cols-2 gap-y-6 rounded-xl border border-line bg-surface px-5 py-5 shadow-xs sm:grid-cols-4 sm:divide-x sm:divide-line sm:px-0">
        <Stat className="sm:px-6" label="Hours saved" value={hours(value.hours)} sub="all time" />
        <Stat className="sm:px-6" label="Deliverables" value={value.delivered} sub={value.approved ? `${value.approved} approved` : "to date"} />
        <Stat className="sm:px-6" label="Capacity" value={`${Math.round(weekly)} h`} sub="per week, scheduled" />
        <Stat className="sm:px-6" label="AI cost" value={microsToDollars(value.costMicros)} sub={`${value.runs} run${value.runs === 1 ? "" : "s"} · agency only`} />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0">
          <SectionHeading title="Recent deliverables" count={value.delivered} />
          <DeliverableList
            items={deliverables}
            empty={
              <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
                <Sparkles className="mx-auto size-5 text-ink-4" aria-hidden />
                <p className="mt-3 text-[14px] font-medium text-ink">No deliverables yet</p>
                <p className="mt-1 text-[13px] text-ink-3">The first overnight deliverable will appear here by morning.</p>
              </div>
            }
          />
        </section>

        <div className="space-y-10">
          <section>
            <SectionHeading title="Workflows" count={workflows.length} action={<TextLink href={`${base}/workflows`}>Manage</TextLink>} />
            {workflows.length ? (
              <ul className="space-y-px">
                {workflows.map((w) => {
                  const Icon = w.trigger.type === "schedule" ? CalendarClock : w.trigger.type === "event" ? Inbox : Zap;
                  return (
                    <li key={w.id} className={cn("flex gap-3 rounded-lg px-1 py-2.5", !w.enabled && "opacity-50")}>
                      <Icon className="mt-0.5 size-4 shrink-0 text-ink-4" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-medium text-ink">{w.name}</p>
                        <p className="text-[12.5px] text-ink-3">
                          {w.enabled ? describeTrigger(w.trigger) : "Off"}
                          {w.enabled && w.nextRunAt ? (
                            <>
                              {" · next "}
                              <RelativeTime date={w.nextRunAt} />
                            </>
                          ) : null}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-3">No workflows yet.</p>
            )}
          </section>

          <section>
            <SectionHeading title="The stack" />
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-xs">
              {stack.map((s) => {
                const inner = (
                  <>
                    <s.icon className="size-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="text-[13px] text-ink-2">{s.label}</span>
                    <span className={cn("ml-auto truncate pl-3 text-right text-[12.5px]", s.ok ? "text-ink-3" : "text-ink-4")}>{s.value}</span>
                  </>
                );
                return (
                  <li key={s.label}>
                    {s.href ? (
                      <Link href={s.href} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50">
                        {inner}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 px-4 py-3">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
