import Link from "next/link";
import { StatusPill } from "@/components/portal/status-pill";
import { Mail, Phone, Users } from "lucide-react";
import { AgentOrb } from "@/components/ui/agent-orb";
import { EmptyState } from "@/components/ui/empty";
import {
  capitalize,
  humanizeTrigger,
  hoursPhrase,
} from "@/components/portal/lib";
import { agentStatus } from "@/components/portal/status";
import { getPortal, getTeam } from "@/server/queries/portal";

export const metadata = { title: "Team" };

export default async function TeamPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  const team = await getTeam(p.org.id);
  const hours = team.reduce((n, a) => n + a.hours30d, 0);

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pt-8 md:px-6 md:pt-14">
      <header className="mb-8 animate-rise">
        <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-ink md:text-[28px]">
          Your team
        </h1>
        <p className="mt-1.5 max-w-[60ch] text-[15px] text-ink-3 text-pretty">
          {team.length
            ? `${team.length === 1 ? "One teammate" : `${team.length} teammates`} working for ${p.org.name}. They do their jobs on schedule — no need to ask${hours > 0 ? `. This month they’ve saved you ${hoursPhrase(hours)}.` : "."}`
            : `Your AI teammates will appear here as soon as ${p.brand.name === p.org.name ? "your provider" : p.brand.name} hires them.`}
        </p>
      </header>

      {team.length ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {team.map((a, i) => {
            const st = agentStatus(a);
            const shown = a.workflows.filter((w) => w.enabled).slice(0, 3);
            const more =
              a.workflows.filter((w) => w.enabled).length - shown.length;
            return (
              <li
                key={a.id}
                className="animate-rise"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <Link
                  href={`/p/${slug}/team/${a.id}`}
                  className="group flex h-full flex-col rounded-xl border border-line bg-surface p-5 shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-md"
                >
                  <div className="flex items-start gap-3.5">
                    <AgentOrb seed={a.seed} name={a.name} size={44} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-[16px] font-semibold tracking-[-0.01em] text-ink">
                          {a.name}
                        </h2>
                        <StatusPill status={st} />
                      </div>
                      <p className="truncate text-[13px] text-ink-3">
                        {a.role}
                      </p>
                    </div>
                  </div>
                  {a.summary ? (
                    <p className="mt-3.5 line-clamp-2 text-[13.5px] leading-relaxed text-ink-2 text-pretty">
                      {a.summary}
                    </p>
                  ) : null}

                  {shown.length ? (
                    <ul className="mt-4 space-y-2 border-t border-line pt-4">
                      {shown.map((w) => (
                        <li key={w.id} className="text-[13px] leading-snug">
                          <span className="text-ink-2">{w.name}</span>
                          <span className="text-ink-3"> · </span>
                          <span className="text-ink-3">
                            {capitalize(humanizeTrigger(w.trigger))}
                          </span>
                        </li>
                      ))}
                      {more > 0 ? (
                        <li className="text-[12.5px] text-ink-3">
                          and {more} more
                        </li>
                      ) : null}
                    </ul>
                  ) : null}

                  <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-4 text-[12.5px] text-ink-3">
                    {a.email ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <Mail
                          className="size-3.5 shrink-0 text-ink-3"
                          aria-hidden
                        />
                        <span className="truncate">{a.email}</span>
                      </span>
                    ) : null}
                    {a.phone ? (
                      <span className="inline-flex items-center gap-1.5 tabular">
                        <Phone className="size-3.5 text-ink-3" aria-hidden />
                        {a.phone}
                      </span>
                    ) : null}
                    {a.delivered30d > 0 ? (
                      <span className="ml-auto text-ink-3 tabular">
                        {a.delivered30d} delivered this month
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-line-strong">
          <EmptyState
            icon={<Users />}
            title="No teammates yet"
            body="Once your AI employees are hired, you’ll meet them here — what they do, when, and how to reach them."
          />
        </div>
      )}
    </div>
  );
}
