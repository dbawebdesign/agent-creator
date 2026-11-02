import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AgentOrb } from "@/components/ui/agent-orb";
import { whenLabel } from "@/components/portal/deliverable-card";
import { ChannelIcon } from "@/components/portal/icons";
import { CHANNEL_LABEL } from "@/components/portal/lib";
import { Thread } from "@/components/portal/thread";
import { getPortal, getRequest } from "@/server/queries/portal";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const p = await getPortal(org);
  const r = await getRequest(p.org.id, id);
  return { title: r?.subject ?? "Request" };
}

export default async function RequestPage({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org: slug, id } = await params;
  const p = await getPortal(slug);
  const r = await getRequest(p.org.id, id);
  if (!r) notFound();
  const tz = p.org.timezone;
  const channel = CHANNEL_LABEL[r.channel] ?? r.channel;
  const replyHere = r.channel === "portal";
  const first = r.messages[0];
  const last = r.messages.at(-1);
  const note =
    r.channel === "email"
      ? `This conversation happened over email${r.who ? ` with ${r.who}` : ""}. Replies go through that inbox.`
      : r.channel === "sms"
        ? "This conversation happened over text. Replies go through that number."
        : r.channel === "slack"
          ? "This conversation happened in Slack. Reply in the Slack thread."
          : "This conversation came in through your connected tools.";

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pt-5 md:px-6 md:pt-8">
      <Link
        href={`/p/${slug}/requests`}
        className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Requests
      </Link>
      <div className="mt-4 grid gap-10 md:grid-cols-[minmax(0,1fr)_220px] md:gap-12">
        <div className="min-w-0">
          <header className="mb-8 animate-rise">
            <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.02em] text-ink text-balance md:text-[26px]">
              {r.subject || `Conversation with ${r.agent.name}`}
            </h1>
            {/* On desktop the same facts live in the side rail. */}
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-ink-3 md:hidden">
              <ChannelIcon channel={r.channel} className="text-ink-3" />
              {channel}
              <span aria-hidden className="text-ink-3">
                ·
              </span>
              <Link
                href={`/p/${slug}/team/${r.agent.id}`}
                className="text-ink-2 hover:text-ink"
              >
                {r.agent.name}
              </Link>
              {r.who ? (
                <>
                  <span aria-hidden className="text-ink-3">
                    ·
                  </span>{" "}
                  {r.who}
                </>
              ) : null}
            </p>
          </header>
          <Thread
            slug={slug}
            agent={r.agent}
            conversationId={replyHere ? r.id : null}
            canReply={replyHere && p.canAct}
            youName={p.user.name ?? "You"}
            messages={r.messages.map((m) => ({
              id: m.id,
              author: m.author,
              body: m.body,
              at: m.createdAt.toISOString(),
              when: whenLabel(m.createdAt, tz),
              authorName:
                m.authorName ?? (m.author === "contact" ? r.who : null),
            }))}
            replyNote={replyHere ? undefined : note}
          />
        </div>

        <aside className="hidden md:block" aria-label="About this request">
          <dl className="sticky top-24 grid gap-y-5 text-[13px]">
            <div>
              <dt className="text-ink-3">With</dt>
              <dd className="mt-1 flex min-w-0 items-center gap-2 text-ink-2">
                <AgentOrb seed={r.agent.seed} name={r.agent.name} size={20} />
                <Link
                  href={`/p/${slug}/team/${r.agent.id}`}
                  className="truncate font-medium hover:text-ink"
                >
                  {r.agent.name}
                </Link>
              </dd>
              <dd className="mt-0.5 truncate text-[12.5px] text-ink-3">
                {r.agent.role}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Came in by</dt>
              <dd className="mt-1 inline-flex items-center gap-1.5 text-ink-2">
                <ChannelIcon channel={r.channel} className="text-ink-3" />{" "}
                {channel}
              </dd>
            </div>
            {r.who ? (
              <div>
                <dt className="text-ink-3">From</dt>
                <dd className="mt-1 break-words text-ink-2">{r.who}</dd>
              </div>
            ) : null}
            {first ? (
              <div>
                <dt className="text-ink-3">Started</dt>
                <dd className="mt-1 text-ink-2">
                  <time dateTime={first.createdAt.toISOString()}>
                    {whenLabel(first.createdAt, tz)}
                  </time>
                </dd>
              </div>
            ) : null}
            {last && last !== first ? (
              <div>
                <dt className="text-ink-3">Last message</dt>
                <dd className="mt-1 text-ink-2">
                  <time dateTime={last.createdAt.toISOString()}>
                    {whenLabel(last.createdAt, tz)}
                  </time>
                </dd>
              </div>
            ) : null}
          </dl>
        </aside>
      </div>
    </div>
  );
}
