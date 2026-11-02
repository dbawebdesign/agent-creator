import Link from "next/link";
import { notFound } from "next/navigation";
import { Brain, CalendarClock, Inbox, Library, Mail, Monitor, Radio, ShieldAlert, Sparkles, Zap } from "lucide-react";
import { ApprovalActions } from "@/components/studio/approval-actions";
import { hasRole, requireOrg } from "@/server/auth/access";
import { agentApprovals, agentChannels, agentDeliverable, agentDeliverables, agentKnowledge, agentMemories, agentSetup, agentValue, agentWorkflows, getAgent, heldDeliverables } from "@/server/queries/studio";
import { HeldDeliverable, releaseLabel } from "@/components/studio/held-deliverable";
import { AutoRefresh, BeforeTonight, FirstDeliverableRow, RetrySetupButton } from "@/components/studio/setup-panel";
import { RelativeTime } from "@/components/shared/relative-time";
import { DeliverableList } from "@/components/studio/deliverable-list";
import { CHANNEL_LABEL, hours, isSetupStalled, microsToDollars, SectionHeading, Stat, TextLink } from "@/components/studio/bits";
import { describeTrigger } from "@/components/studio/cron";
import { cn } from "@/lib/utils";

export default async function AgentOverview({ params, searchParams }: { params: Promise<{ agency: string; agentId: string }>; searchParams: Promise<{ welcome?: string; d?: string }> }) {
  const [{ agency: slug, agentId }, sp] = await Promise.all([params, searchParams]);
  const access = await requireOrg(slug, "viewer");
  const agency = access.org;
  const found = await getAgent(agency.id, agentId);
  if (!found) notFound();
  const { agent, org, inbox } = found;
  const [deliverables, workflows, value, memories, knowledge, channels, approvals, setup] = await Promise.all([
    agentDeliverables(agent.orgId, agent.id, 8),
    agentWorkflows(agent.orgId, agent.id),
    agentValue(agent.orgId, agent.id),
    agentMemories(agent.orgId, agent.id),
    agentKnowledge(agent.orgId, agent.id),
    agentChannels(agent.orgId, agent.id),
    agentApprovals(agent.orgId, agent.id),
    agentSetup(agent.orgId, agent.id),
  ]);
  // ?d= deep link (⌘K, notifications): open it even when it's older than the recent list.
  if (sp.d && !deliverables.some((d) => d.id === sp.d)) {
    const one = await agentDeliverable(agent.orgId, agent.id, sp.d);
    if (one) deliverables.unshift(one);
  }
  const provisioning = agent.status === "provisioning";
  const hasRun = value.delivered > 0;
  // Finished early and held until the release time (the draft waits in the release job; the client hasn't seen it).
  const held = setup.firstRun?.status === "succeeded" ? (await heldDeliverables(agent.orgId, [setup.firstRun.id]))[0] : undefined;
  const first = setup.firstRun && setup.firstRun.status !== "succeeded" ? setup.firstRun : null;
  // Once the first run has finished (or failed), uploads can only help what comes next.
  const firstDone = hasRun || !!held || (!!setup.firstRun && setup.firstRun.status !== "queued" && setup.firstRun.status !== "running" && setup.firstRun.status !== "waiting_approval");
  const lands = first ? landsAt(first.releaseAt, setup.timezone) : null;
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

  // Setup normally finishes in under a minute; past 3 minutes, say where it stopped and offer a retry.
  const stalled = isSetupStalled(agent.status, agent.createdAt);
  // Memory and knowledge can legitimately be empty; the real setup steps are the inbox, computer and channels.
  const stalledAt = stack.find((l) => !l.ok && (l.label === "Inbox" || l.label === "Computer" || l.label === "Channels"))?.label ?? "Activation";

  return (
    <div className="space-y-12">
      {sp.welcome ? (
        <div className="flex items-start gap-3 rounded-xl border border-accent/25 bg-accent-soft/60 px-5 py-4 animate-rise">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <div className="text-[13.5px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">{agent.name} is on the roster.</span> {held ? <>“{held.title}” is finished and lands {releaseLabel(held.releaseAt, setup.timezone)}.</> : first ? <>“{first.title}” is queued{lands ? <> and lands {lands}</> : null}.</> : <>The first deliverable is on its way.</>} Work through “Before tonight” below, and share the inbox address so the team can email {agent.name} directly.
          </div>
        </div>
      ) : null}

      {approvals.length ? (
        <section aria-label="Waiting for approval" className="space-y-2">
          {approvals.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-warn/25 bg-warn-soft px-4 py-3">
              <ShieldAlert className="size-4 shrink-0 text-warn" aria-hidden />
              <div className="min-w-0 flex-1 basis-64">
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

      {provisioning ? (
        <section aria-label="Setting up" className={cn("rounded-xl border bg-surface shadow-xs", stalled ? "border-warn/30" : "border-line")} aria-live="polite">
          {stalled ? null : <AutoRefresh />}
          {stalled ? (
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
              <div className="min-w-0 flex-1 basis-56">
                <h2 className="text-[14px] font-semibold text-ink">Setup stalled at {stalledAt.toLowerCase()}</h2>
                <p className="text-[12.5px] text-ink-3">
                  Started <RelativeTime date={agent.createdAt} />. It usually takes under a minute, so something got stuck. Retrying is safe.
                </p>
              </div>
              {hasRole(access, "member") ? <RetrySetupButton agency={slug} agentId={agent.id} agentName={agent.name} /> : null}
            </div>
          ) : (
            <div className="border-b border-line px-4 py-3.5">
              <h2 className="text-[14px] font-semibold text-ink">Setting up {agent.name}</h2>
              <p className="text-[12.5px] text-ink-3">This page updates on its own. It usually takes under a minute.</p>
            </div>
          )}
          <ul className="divide-y divide-line">
            {stack.map((l) => (
              <li key={l.label} className="flex items-center gap-3 px-4 py-3">
                <l.icon className="size-4 shrink-0 text-ink-3" aria-hidden />
                <span className="text-[13.5px] text-ink">{l.label}</span>
                <span className="ml-auto truncate pl-3 text-[12.5px] text-ink-3">{l.ok ? l.value : stalled ? (l.label === stalledAt ? "Not finished" : "") : "Setting up…"}</span>
                {l.ok ? (
                  <span className="text-[12px] font-medium text-good">Ready</span>
                ) : stalled ? (
                  l.label === stalledAt ? <span className="text-[12px] font-medium text-warn">Stalled</span> : <span className="text-[12px] text-ink-3">None yet</span>
                ) : (
                  <span className="size-3.5 animate-spin rounded-full border-2 border-accent/25 border-t-accent" aria-label="In progress" />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : hasRun ? (
      <section aria-label="Value delivered" className="grid grid-cols-2 gap-y-6 rounded-xl border border-line bg-surface px-5 py-5 shadow-xs sm:grid-cols-4 sm:divide-x sm:divide-line sm:px-0">
          <Stat className="sm:px-6" label="Hours saved" value={hours(value.hours)} sub="all time" />
          <Stat className="sm:px-6" label="Deliverables" value={value.delivered} sub={value.approved ? `${value.approved} approved` : "to date"} />
          <Stat className="sm:px-6" label="Capacity" value={`${Math.round(weekly)} h`} sub="per week, scheduled" />
          <Stat className="sm:px-6" label="AI cost" value={microsToDollars(value.costMicros)} sub={`${value.runs} run${value.runs === 1 ? "" : "s"} · agency only`} />
        </section>
      ) : null}

      {provisioning ? (
        // Until setup finishes there is nothing to show below the setup card: no empty panels, no repeated stack.
        <p className="text-[13px] text-ink-3">Workflows and deliverables appear once {agent.name} is set up.</p>
      ) : (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-10">
          <section>
            <SectionHeading title={hasRun ? "Recent deliverables" : "First deliverable"} count={hasRun ? value.delivered : undefined} />
            {held ? (
              <div className={cn(hasRun && "mb-3")}>
                <HeldDeliverable
                  title={held.title}
                  kind={held.kind}
                  preview={held.preview}
                  body={held.body}
                  releaseAt={held.releaseAt}
                  timezone={setup.timezone}
                  clientName={org.name}
                  release={hasRole(access, "member") && agent.status !== "archived" ? { agency: slug, agentId: agent.id, runId: held.runId } : undefined}
                />
              </div>
            ) : null}
            {first ? (
              <div className={cn(hasRun && "mb-3")}>
                <FirstDeliverableRow title={first.title} description={first.description} status={first.status} lands={lands} />
              </div>
            ) : null}
            {hasRun || (!first && !held) ? (
              <DeliverableList
                items={deliverables}
                initialOpenId={sp.d}
                empty={
                  <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
                    <Sparkles className="mx-auto size-5 text-ink-4" aria-hidden />
                    <p className="mt-3 text-[14px] font-medium text-ink">No deliverables yet</p>
                    <p className="mt-1 text-[13px] text-ink-3">Finished work shows up here as {agent.name} delivers it.</p>
                  </div>
                }
              />
            ) : null}
          </section>
          {!hasRun ? (
            <BeforeTonight
              knowledgeHref={`${base}/knowledge`}
              agentName={agent.name}
              clientName={org.name}
              needs={setup.knowledgeNeeds}
              questions={setup.openQuestions}
              haveTitles={knowledge.map((k) => k.title)}
              firstDone={firstDone}
            />
          ) : null}
        </div>

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
                    <span className={cn("ml-auto truncate pl-3 text-right text-[12.5px]", s.ok ? "text-ink-3" : "text-ink-3")}>{s.value}</span>
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
      )}
    </div>
  );
}

/** "tomorrow at 6:00 AM" in the client's timezone, or null when it hands over as soon as it's done. */
function landsAt(releaseAt: Date | null, timezone: string) {
  if (!releaseAt) return "as soon as it’s done";
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(releaseAt);
  const today = fmt(new Date());
  const tomorrow = fmt(new Date(Date.now() + 86_400_000));
  const day = fmt(releaseAt) === today ? "today" : fmt(releaseAt) === tomorrow ? "tomorrow" : new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(releaseAt);
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(releaseAt).find((p) => p.type === "timeZoneName")?.value;
  return `${day} at ${time}${tz ? ` ${tz}` : ""}`;
}

