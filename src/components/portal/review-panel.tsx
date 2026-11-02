"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, Check, Loader2, PenLine, RotateCcw, Send, ThumbsUp, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { reviewDeliverableAction } from "@/app/p/[org]/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { holdWithUndo, UNDO_MS } from "./undo";

export function ReviewPanel({
  slug,
  deliverableId,
  agentName,
  status,
  needsReview,
  sendsOnApprove,
  feedback,
  canAct,
  next,
  sendTo,
  sentAt,
}: {
  slug: string;
  deliverableId: string;
  agentName: string;
  status: string;
  needsReview: boolean;
  sendsOnApprove: boolean;
  feedback: string | null;
  canAct: boolean;
  /** The next item waiting on you, offered once this one is decided. */
  next?: { href: string; title: string } | null;
  /** Who the linked send goes to (e.g. an email address), and when it went, once approved. */
  sendTo?: string | null;
  sentAt?: string | null;
}) {
  const [mode, setMode] = useState<"idle" | "changes">("idle");
  const [text, setText] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<"approve" | "changes" | null>(null);
  const [holding, setHolding] = useState<null | (() => void)>(null);
  const router = useRouter();
  const current = local ?? status;

  if (current === "approved") {
    const sent = sendTo && (sendsOnApprove || sentAt);
    return (
      <Done tone="good" icon={sent ? <Send className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />} next={local ? next : null}>
        {sent ? (
          local ? (
            <span>
              Approved. {agentName} is sending it to <span className="font-semibold">{sendTo}</span> now.
            </span>
          ) : (
            <span>
              Approved and sent to <span className="font-semibold">{sendTo}</span>
              {sentAt ? <span className="font-normal"> · {sentAt}</span> : null}
            </span>
          )
        ) : local ? (
          `Thanks. ${agentName} will remember you liked this.`
        ) : (
          "Approved."
        )}
      </Done>
    );
  }
  if (current === "changes_requested") {
    return (
      <Done tone="warn" icon={<RotateCcw className="size-4" aria-hidden />} next={local ? next : null}>
        <span>
          You asked {agentName} for changes{feedback || text ? ":" : "."}
          {feedback || text ? <span className="mt-1 block text-ink-3">&ldquo;{feedback || text}&rdquo;</span> : null}
        </span>
      </Done>
    );
  }
  if (!canAct) return null;

  const run = (action: "approve" | "request_changes") => {
    setWhich(action === "approve" ? "approve" : "changes");
    start(async () => {
      const res = await reviewDeliverableAction({
        slug,
        deliverableId,
        action,
        feedback: action === "request_changes" ? text.trim() : undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setLocal(action === "approve" ? "approved" : "changes_requested");
      toast.success(action === "approve" ? (sendsOnApprove ? "Approved and sending" : "Approved") : `Sent to ${agentName}`, {
        description: action === "approve" ? (sendsOnApprove && sendTo ? `On its way to ${sendTo}.` : `${agentName} will remember you liked this.`) : `${agentName} will revise it and deliver a new version.`,
      });
      router.refresh();
    });
  };

  // Approving a send lets something leave the building: hold it a few seconds behind Undo.
  const approve = () => {
    if (!sendsOnApprove) return run("approve");
    const undo = holdWithUndo({
      title: `Sending in ${UNDO_MS / 1000} seconds`,
      description: sendTo ? `${agentName} will email ${sendTo}.` : `${agentName} will send it.`,
      commit: () => {
        setHolding(null);
        run("approve");
      },
      onUndo: () => setHolding(null),
    });
    setHolding(() => undo);
  };

  return (
    <div
      className={cn(
        "z-20 mt-6 rounded-xl border border-line p-3",
        // Only work that's waiting on you follows you down the page.
        needsReview ? "sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] bg-raised shadow-lg md:bottom-6" : "bg-surface shadow-sm",
      )}
    >
      {holding ? (
        <div className="flex flex-wrap items-center gap-3" role="status">
          <p className="flex min-w-0 flex-1 items-center gap-2 pl-1 text-[13.5px] text-ink-2">
            <Loader2 className="size-4 shrink-0 animate-spin text-ink-3" aria-hidden />
            <span className="min-w-0">Sending{sendTo ? <> to <span className="font-medium text-ink">{sendTo}</span></> : null} in a few seconds…</span>
          </p>
          <Button variant="secondary" size="lg" className="w-full sm:w-auto" onClick={() => holding()}>
            <Undo2 aria-hidden /> Undo
          </Button>
        </div>
      ) : mode === "idle" && !needsReview ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 pl-1 text-[13.5px] text-ink-2">How did {agentName} do?</p>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button variant="ghost" className="flex-1 sm:flex-none" onClick={() => setMode("changes")} disabled={pending}>
              <PenLine aria-hidden /> Request changes
            </Button>
            <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => run("approve")} disabled={pending} aria-busy={pending}>
              {pending && which === "approve" ? <Loader2 className="animate-spin" /> : <ThumbsUp aria-hidden />}
              Looks good
            </Button>
          </div>
        </div>
      ) : mode === "idle" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 pl-1 text-[13.5px] text-ink-2">
            {sendsOnApprove ? (sendTo ? <>{agentName} will send this to <span className="font-medium text-ink">{sendTo}</span> once you approve.</> : `${agentName} will send this once you approve.`) : "Does this look right?"}
          </p>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button variant="secondary" size="lg" className="flex-1 sm:flex-none" onClick={() => setMode("changes")} disabled={pending}>
              <PenLine aria-hidden /> Request changes
            </Button>
            <Button variant="accent" size="lg" className="flex-1 sm:flex-none" onClick={approve} disabled={pending} aria-busy={pending}>
              {pending && which === "approve" ? <Loader2 className="animate-spin" /> : <Check aria-hidden />}
              {sendsOnApprove ? "Approve & send" : "Approve"}
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) run("request_changes");
          }}
          className="animate-fade-in"
        >
          <label htmlFor="feedback" className="mb-2 block pl-1 text-[13px] font-medium text-ink-2">
            What should {agentName} change?
          </label>
          <Textarea
            id="feedback"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Make it shorter and lead with the dates."
            className="min-h-20 bg-surface"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) run("request_changes");
              if (e.key === "Escape") setMode("idle");
            }}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setMode("idle")} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={!text.trim() || pending} aria-busy={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              Send to {agentName}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Done({ tone, icon, children, next }: { tone: "good" | "warn"; icon: React.ReactNode; children: React.ReactNode; next?: { href: string; title: string } | null }) {
  return (
    <div className="mt-6 animate-fade-in">
      <div
        role="status"
        className={cn(
          "flex items-start gap-2.5 rounded-xl px-4 py-3 text-[13.5px] font-medium",
          tone === "good" ? "bg-good-soft text-good" : "bg-warn-soft text-warn",
        )}
      >
        <span className="mt-0.5">{icon}</span>
        {children}
      </div>
      {next ? (
        <Link
          href={next.href}
          className="group mt-3 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm transition-colors hover:border-line-strong"
        >
          <span className="min-w-0">
            <span className="block text-[12px] text-ink-3">Next up</span>
            <span className="block truncate text-[14px] font-medium text-ink">{next.title}</span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
