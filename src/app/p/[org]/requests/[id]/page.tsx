import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { whenLabel } from "@/components/portal/deliverable-card";
import { ChannelIcon } from "@/components/portal/icons";
import { CHANNEL_LABEL } from "@/components/portal/lib";
import { Thread } from "@/components/portal/thread";
import { getPortal, getRequest } from "@/server/queries/portal";

export async function generateMetadata({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const p = await getPortal(org);
  const r = await getRequest(p.org.id, id);
  return { title: r?.subject ?? "Request" };
}

export default async function RequestPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  const p = await getPortal(slug);
  const r = await getRequest(p.org.id, id);
  if (!r) notFound();
  const tz = p.org.timezone;
  const channel = CHANNEL_LABEL[r.channel] ?? r.channel;
  const replyHere = r.channel === "portal";
  const note =
    r.channel === "email"
      ? `This conversation happened over email${r.who ? ` with ${r.who}` : ""}. Replies go through that inbox.`
      : r.channel === "sms"
        ? "This conversation happened over text. Replies go through that number."
        : r.channel === "slack"
          ? "This conversation happened in Slack. Reply in the Slack thread."
          : "This conversation came in through your connected tools.";

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pt-5 md:px-6 md:pt-8">
      <Link
        href={`/p/${slug}/requests`}
        className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Requests
      </Link>
      <header className="mt-4 mb-8 animate-rise">
        <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.02em] text-ink text-balance md:text-[26px]">
          {r.subject || `Conversation with ${r.agent.name}`}
        </h1>
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-ink-3">
          <ChannelIcon channel={r.channel} className="text-ink-4" />
          {channel}
          <span aria-hidden className="text-ink-4">·</span>
          <Link href={`/p/${slug}/team/${r.agent.id}`} className="text-ink-2 hover:text-ink">
            {r.agent.name}
          </Link>
          {r.who ? (
            <>
              <span aria-hidden className="text-ink-4">·</span> {r.who}
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
          authorName: m.authorName ?? (m.author === "contact" ? r.who : null),
        }))}
        replyNote={replyHere ? undefined : note}
      />
    </div>
  );
}
