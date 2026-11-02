import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { AgentOrb } from "@/components/ui/agent-orb";
import { EmptyState } from "@/components/ui/empty";
import { AskComposer } from "@/components/portal/composer";
import { whenLabel } from "@/components/portal/deliverable-card";
import { ChannelIcon } from "@/components/portal/icons";
import { CHANNEL_LABEL } from "@/components/portal/lib";
import {
  getPortal,
  listAgentsLite,
  listRequests,
} from "@/server/queries/portal";

export const metadata = { title: "Requests" };

function plain(md: string | null): string {
  if (!md) return "";
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|~-]+/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function RequestsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  const [rows, agents] = await Promise.all([
    listRequests(p.org.id),
    listAgentsLite(p.org.id),
  ]);
  const tz = p.org.timezone;

  return (
    <div className="mx-auto w-full max-w-[1040px] *:max-w-[720px] px-4 pt-8 md:px-6 md:pt-14">
      <header className="mb-6 animate-rise">
        <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-ink md:text-[28px]">
          Requests
        </h1>
        <p className="mt-1.5 text-[15px] text-ink-3 text-pretty">
          Everything you and your customers have asked your team — by email,
          text, Slack or right here.
        </p>
      </header>

      {p.canAct && agents.length ? (
        <AskComposer
          slug={slug}
          agents={agents.filter((a) => a.status !== "paused")}
          placeholder="Start a new request…"
          className="mb-8"
        />
      ) : null}

      {rows.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          {rows.map((r) => {
            const preview = plain(r.lastBody);
            const fromAgent = r.lastAuthor === "agent";
            return (
              <li key={r.id}>
                <Link
                  href={`/p/${slug}/requests/${r.id}`}
                  className="flex gap-3.5 px-4 py-4 transition-colors hover:bg-surface-2/60 md:px-5"
                >
                  <AgentOrb
                    seed={r.agent.seed}
                    name={r.agent.name}
                    size={32}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                        {r.subject || preview.slice(0, 80) || "Conversation"}
                      </p>
                      <time
                        dateTime={r.lastMessageAt.toISOString()}
                        className="shrink-0 text-[12px] text-ink-3 tabular"
                      >
                        {whenLabel(r.lastMessageAt, tz)}
                      </time>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[13px] text-ink-3">
                      <span className="text-ink-2">
                        {fromAgent ? r.agent.name : (r.who ?? "You")}:
                      </span>{" "}
                      {preview}
                    </p>
                    <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-3">
                      <ChannelIcon channel={r.channel} />
                      {CHANNEL_LABEL[r.channel] ?? r.channel}
                      <span aria-hidden>·</span>
                      with {r.agent.name}
                      {r.who && r.channel !== "portal" ? (
                        <>
                          <span aria-hidden>·</span> {r.who}
                        </>
                      ) : null}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-line-strong">
          <EmptyState
            icon={<MessagesSquare />}
            title="No requests yet"
            body="Email, text or message any teammate — every conversation shows up here so nothing gets lost."
          />
        </div>
      )}
    </div>
  );
}
