"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { PortalMarkdown as Markdown } from "./markdown";
import { AgentOrb, Avatar } from "@/components/ui/agent-orb";
import { AskComposer } from "./composer";
import { cn } from "@/lib/utils";

export type ThreadMsg = {
  id: string;
  author: "agent" | "user" | "contact" | "system";
  body: string;
  at: string; // ISO
  when: string; // pre-formatted in org tz
  authorName: string | null;
};

/**
 * A conversation with one teammate. While a reply is on its way, refreshes quietly until it lands.
 */
export function Thread({
  slug,
  agent,
  messages,
  conversationId,
  canReply,
  youName,
  emptyHint,
  replyNote,
}: {
  slug: string;
  agent: { id: string; name: string; role: string; seed: string };
  messages: ThreadMsg[];
  conversationId: string | null;
  canReply: boolean;
  youName: string;
  emptyHint?: string;
  replyNote?: React.ReactNode;
}) {
  const router = useRouter();
  const last = messages.at(-1);
  const awaiting = Boolean(last && last.author !== "agent" && last.author !== "system" && Date.now() - new Date(last.at).getTime() < 1000 * 60 * 5);
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;

  useEffect(() => {
    if (!awaiting) return;
    const t = setInterval(() => router.refresh(), 3500);
    return () => clearInterval(t);
  }, [awaiting, router]);

  // Only follow new messages as they arrive — never jump on first paint.
  const seen = useRef({ count, awaiting });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { count, awaiting };
    if (count > prev.count || (awaiting && !prev.awaiting)) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [count, awaiting]);

  return (
    <div>
      {messages.length ? (
        <ol className="space-y-5" aria-live="polite">
          {messages.map((m) => {
            const mine = m.author === "user";
            const isAgent = m.author === "agent";
            const name = isAgent ? agent.name : mine ? (m.authorName ?? youName) : (m.authorName ?? (m.author === "system" ? "Note" : "Customer"));
            return (
              <li key={m.id} className={cn("flex gap-3", mine && "flex-row-reverse")}>
                {isAgent ? <AgentOrb seed={agent.seed} size={28} className="mt-0.5" /> : <Avatar name={name} size={28} className="mt-0.5" />}
                <div className={cn("min-w-0 max-w-[85%]", mine && "flex flex-col items-end")}>
                  <p className={cn("mb-1 text-[12px] text-ink-4", mine && "text-right")}>
                    <span className="font-medium text-ink-3">{mine ? "You" : name}</span> · <time dateTime={m.at}>{m.when}</time>
                  </p>
                  <div
                    className={cn(
                      "rounded-2xl px-3.5 py-2.5 text-[14px]",
                      mine ? "rounded-tr-md bg-surface-2 text-ink ring-1 ring-line/60" : "rounded-tl-md border border-line bg-surface text-ink-2",
                    )}
                  >
                    <Markdown className="portal-bubble">{m.body}</Markdown>
                  </div>
                </div>
              </li>
            );
          })}
          {awaiting ? (
            <li className="flex gap-3" role="status">
              <AgentOrb seed={agent.seed} size={28} className="mt-0.5" live />
              <div className="mt-1 inline-flex items-center gap-2 rounded-2xl rounded-tl-md border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-3">
                <span className="flex gap-1" aria-hidden>
                  <span className="size-1.5 animate-pulse-soft rounded-full bg-ink-4" />
                  <span className="size-1.5 animate-pulse-soft rounded-full bg-ink-4 [animation-delay:200ms]" />
                  <span className="size-1.5 animate-pulse-soft rounded-full bg-ink-4 [animation-delay:400ms]" />
                </span>
                {agent.name} is working on it
              </div>
            </li>
          ) : null}
        </ol>
      ) : (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13.5px] text-ink-3">
          {emptyHint ?? `Ask ${agent.name} for something — they’ll reply right here.`}
        </p>
      )}
      <div ref={endRef} />
      {canReply ? (
        <AskComposer
          slug={slug}
          agents={[agent]}
          lockAgent
          conversationId={conversationId ?? undefined}
          placeholder={messages.length ? `Reply to ${agent.name}…` : `Ask ${agent.name} for anything…`}
          onSent={() => router.refresh()}
          className="mt-5"
        />
      ) : replyNote ? (
        <div className="mt-5 rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-ink-3">{replyNote}</div>
      ) : null}
    </div>
  );
}
