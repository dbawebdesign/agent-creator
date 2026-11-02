"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowUp, Check, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { askTeam } from "@/app/p/[org]/actions";
import { AgentOrb } from "@/components/ui/agent-orb";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/utils";

type A = { id: string; name: string; role: string; seed: string };

/**
 * "Ask your team…" — one quiet line that grows when you type. Picks a teammate, sends via messageAgent.
 */
export function AskComposer({
  slug,
  agents,
  defaultAgentId,
  conversationId,
  placeholder,
  lockAgent,
  onSent,
  className,
  autoFocus,
  prefix,
}: {
  slug: string;
  agents: A[];
  defaultAgentId?: string;
  conversationId?: string;
  placeholder?: string;
  lockAgent?: boolean;
  onSent?: (conversationId: string) => void;
  className?: string;
  autoFocus?: boolean;
  /** Context prepended to the message (e.g. which deliverable this is about). */
  prefix?: string;
}) {
  const [agentId, setAgentId] = useState(defaultAgentId ?? agents[0]?.id ?? "");
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [sent, setSent] = useState<{
    name: string;
    conversationId: string;
  } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  if (!agent) return null;

  const submit = () => {
    const body = text.trim();
    if (!body || pending) return;
    start(async () => {
      const res = await askTeam({
        slug,
        agentId: agent.id,
        text: prefix ? `${prefix}\n\n${body}` : body,
        conversationId,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setText("");
      setSent({ name: agent.name, conversationId: res.conversationId });
      // One confirmation: the inline "{name} is on it. Follow along" line (or the thread itself, via onSent).
      if (onSent) onSent(res.conversationId);
      router.refresh();
    });
  };

  return (
    <div className={className}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={cn(
          "flex items-end gap-1.5 rounded-xl border border-line bg-surface p-1.5 shadow-sm transition-[border-color,box-shadow] duration-150",
          "focus-within:border-ink-3 focus-within:shadow-md focus-within:ring-3 focus-within:ring-[color-mix(in_oklab,var(--ink)_12%,transparent)]",
        )}
      >
        {lockAgent || agents.length < 2 ? (
          <span className="flex h-9 shrink-0 items-center pl-1.5 pr-0.5">
            <AgentOrb seed={agent.seed} name={agent.name} size={22} />
          </span>
        ) : (
          <Menu>
            <MenuTrigger
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg pr-1.5 pl-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2"
              aria-label={`Asking ${agent.name}. Change teammate`}
            >
              <AgentOrb seed={agent.seed} name={agent.name} size={22} />
              <span className="hidden sm:inline">{agent.name}</span>
              <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
            </MenuTrigger>
            <MenuContent align="start" className="w-64">
              <MenuLabel>Ask</MenuLabel>
              {agents.map((a) => (
                <MenuItem
                  key={a.id}
                  onSelect={() => setAgentId(a.id)}
                  className="h-auto py-1.5"
                >
                  <AgentOrb seed={a.seed} name={a.name} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">
                      {a.name}
                    </span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {a.role}
                    </span>
                  </span>
                  {a.id === agent.id ? (
                    <Check className="!text-ink" aria-hidden />
                  ) : null}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        <label
          htmlFor={`ask-${slug}-${conversationId ?? "new"}`}
          className="sr-only"
        >
          Message {agent.name}
        </label>
        <textarea
          id={`ask-${slug}-${conversationId ?? "new"}`}
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            if (sent) setSent(null);
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder ?? `Ask ${agent.name} for anything…`}
          className="min-h-9 flex-1 resize-none bg-transparent px-1.5 py-2 text-[14.5px] leading-5 text-ink placeholder:text-ink-3 focus:outline-none"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={!text.trim() || pending}
          aria-label={`Send message to ${agent.name}`}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg transition-[background,color,opacity] duration-150",
            text.trim()
              ? "bg-accent text-accent-ink hover:brightness-110"
              : "bg-surface-2 text-ink-3",
            "disabled:cursor-not-allowed",
          )}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </button>
      </form>
      {sent && !onSent ? (
        <p
          className="mt-2 flex items-center gap-1.5 px-1 text-[12.5px] text-ink-3 animate-fade-in"
          role="status"
        >
          <Check className="size-3.5 text-good" aria-hidden />
          {sent.name} is on it.
          <Link
            href={`/p/${slug}/requests/${sent.conversationId}`}
            className="font-medium text-ink-2 underline-offset-2 hover:underline"
          >
            Follow along
          </Link>
        </p>
      ) : null}
    </div>
  );
}
