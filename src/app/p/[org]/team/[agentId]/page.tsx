import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { AgentOrb } from "@/components/ui/agent-orb";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/portal/copy";
import {
  DeliverableCardView,
  whenLabel,
} from "@/components/portal/deliverable-card";
import { ChannelIcon } from "@/components/portal/icons";
import {
  CHANNEL_LABEL,
  capitalize,
  clockTime,
  dayWord,
  humanizeTrigger,
  shortHours,
} from "@/components/portal/lib";
import { agentStatus } from "@/components/portal/status";
import { Thread } from "@/components/portal/thread";
import { getAgentPage, getPortal } from "@/server/queries/portal";
import { WorkflowSwitch } from "@/components/portal/workflow-switch";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; agentId: string }>;
}) {
  const { org, agentId } = await params;
  const p = await getPortal(org);
  const page = await getAgentPage(p.org.id, agentId, p.user.id);
  return { title: page?.agent.name ?? "Teammate" };
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ org: string; agentId: string }>;
}) {
  const { org: slug, agentId } = await params;
  const p = await getPortal(slug);
  const page = await getAgentPage(p.org.id, agentId, p.user.id);
  if (!page) notFound();
  const { agent, work, messages, conversationId } = page;
  const tz = p.org.timezone;
  const st = agentStatus(agent);
  const lite = {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    seed: agent.seed,
  };

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pt-5 md:px-6 md:pt-8">
      <Link
        href={`/p/${slug}/team`}
        className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Team
      </Link>

      <header className="mt-5 animate-rise">
        <div className="flex items-center gap-4">
          <AgentOrb
            seed={agent.seed}
            name={agent.name}
            size={56}
            live={agent.status === "active"}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-ink md:text-[28px]">
                {agent.name}
              </h1>
              {st ? <Badge tone={st.tone}>{st.label}</Badge> : null}
            </div>
            <p className="text-[14px] text-ink-3">{agent.role}</p>
          </div>
        </div>
        <div className="sm:pl-[72px]">
          {agent.summary ? (
            <p className="mt-4 max-w-[62ch] text-[14.5px] leading-relaxed text-ink-2 text-pretty">
              {agent.summary}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {agent.email ? (
              <span className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface pr-1 pl-3 text-[13px] text-ink-2">
                <Mail className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                <span className="truncate">{agent.email}</span>
                <CopyButton
                  value={agent.email}
                  label={`Copy ${agent.name}'s email`}
                  toastLabel="Email address copied"
                  className="size-6 rounded-full [&_svg]:size-3.5"
                />
              </span>
            ) : null}
            {agent.phone ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface pr-1 pl-3 text-[13px] text-ink-2 tabular">
                <Phone className="size-3.5 text-ink-3" aria-hidden />
                {agent.phone}
                <CopyButton
                  value={agent.phone}
                  label={`Copy ${agent.name}'s number`}
                  toastLabel="Number copied"
                  className="size-6 rounded-full [&_svg]:size-3.5"
                />
              </span>
            ) : null}
            <Link
              href={`/p/${slug}/connect`}
              className="inline-flex h-8 items-center rounded-full px-2 text-[13px] font-medium text-accent-text hover:bg-accent-soft"
            >
              More ways to reach {agent.name}
            </Link>
          </div>
        </div>
      </header>

      <div className="mt-10 grid gap-10 md:grid-cols-[minmax(0,1fr)_300px] md:gap-12">
        <div className="min-w-0 space-y-10">
          <section aria-labelledby="work">
            <h2 id="work" className="mb-3 text-[13px] font-semibold text-ink">
              Recent work
            </h2>
            {work.length ? (
              <ul className="grid gap-3">
                {work.map((d) => (
                  <li key={d.id}>
                    <DeliverableCardView
                      d={d}
                      slug={slug}
                      tz={tz}
                      compact
                      hideAgent
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13.5px] text-ink-3">
                {agent.name}&rsquo;s finished work will show up here.
              </p>
            )}
          </section>

          <section aria-labelledby="talk">
            <h2 id="talk" className="mb-4 text-[13px] font-semibold text-ink">
              Talk to {agent.name}
            </h2>
            <Thread
              slug={slug}
              agent={lite}
              conversationId={conversationId}
              canReply={p.canAct && agent.status !== "paused"}
              youName={p.user.name ?? "You"}
              messages={messages.map((m) => ({
                id: m.id,
                author: m.author,
                body: m.body,
                at: m.createdAt.toISOString(),
                when: whenLabel(m.createdAt, tz),
                authorName: m.authorName,
              }))}
              replyNote={
                agent.status === "paused"
                  ? `${agent.name} is paused right now.`
                  : undefined
              }
            />
          </section>
        </div>

        <aside className="space-y-8">
          <section aria-labelledby="does">
            <h2 id="does" className="mb-3 text-[13px] font-semibold text-ink">
              What {agent.name} does
            </h2>
            {agent.workflows.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
                {agent.workflows.map((w) => (
                  <li key={w.id} className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[13.5px] font-medium text-ink">
                        {w.name}
                      </p>
                      {p.isAdmin ? (
                        <WorkflowSwitch
                          slug={slug}
                          workflowId={w.id}
                          name={w.name}
                          enabled={w.enabled}
                        />
                      ) : !w.enabled ? (
                        <Badge>Paused</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[13px] text-ink-3">
                      {capitalize(humanizeTrigger(w.trigger))}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                      {w.deliverTo.length ? (
                        <span
                          className="inline-flex items-center gap-1.5"
                          aria-label={`Delivered to ${w.deliverTo.map((c) => CHANNEL_LABEL[c]).join(", ")}`}
                        >
                          {w.deliverTo.map((c) => (
                            <ChannelIcon key={c} channel={c} />
                          ))}
                        </span>
                      ) : null}
                      {w.enabled && w.nextRunAt ? (
                        <span>
                          Next {dayWord(w.nextRunAt, tz)} at{" "}
                          {clockTime(w.nextRunAt, tz)}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-3">Works on request.</p>
            )}
          </section>

          {agent.delivered30d > 0 ? (
            <section
              aria-label="This month"
              className="grid grid-cols-2 divide-x divide-line rounded-xl border border-line bg-surface shadow-sm"
            >
              <div className="p-4">
                <p className="text-[22px] font-semibold tracking-[-0.02em] text-ink tabular">
                  {agent.delivered30d}
                </p>
                <p className="text-[12px] text-ink-3">delivered this month</p>
              </div>
              <div className="p-4">
                <p className="text-[22px] font-semibold tracking-[-0.02em] text-ink tabular">
                  {shortHours(agent.hours30d) || "—"}
                </p>
                <p className="text-[12px] text-ink-3">saved for you</p>
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
