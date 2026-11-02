"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, Check, Loader2, PenLine, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { reviewDeliverableAction } from "@/app/p/[org]/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { cn } from "@/lib/utils";

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
}) {
  const [mode, setMode] = useState<"idle" | "changes">("idle");
  const [text, setText] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<"approve" | "changes" | null>(null);
  const router = useRouter();
  const current = local ?? status;

  if (current === "approved") {
    return (
      <Done tone="good" icon={<Check className="size-4" aria-hidden />} next={local ? next : null}>
        Approved{sendsOnApprove && local ? ` — ${agentName} is sending it now` : ""}.
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
      toast.success(action === "approve" ? (sendsOnApprove ? "Approved — sending now" : "Approved") : `Sent to ${agentName}`, {
        description: action === "approve" ? `${agentName} will remember you liked this.` : `${agentName} will revise it and deliver a new version.`,
      });
      router.refresh();
    });
  };

  return (
    <div
      className={cn(
        "z-20 mt-6 rounded-xl border border-line p-3",
        // Only work that's waiting on you follows you down the page.
        needsReview ? "sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] bg-raised/95 shadow-lg backdrop-blur-md md:bottom-6" : "bg-surface shadow-sm",
      )}
    >
      {mode === "idle" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 pl-1 text-[13.5px] text-ink-2">
            {needsReview ? (sendsOnApprove ? `${agentName} will send this once you approve.` : "Does this look right?") : "How did they do?"}
          </p>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1 sm:flex-none"
              onClick={() => {
                setMode("changes");
              }}
              disabled={pending}
            >
              <PenLine aria-hidden /> Request changes
            </Button>
            <Button variant="accent" size="lg" className="flex-1 sm:flex-none" onClick={() => run("approve")} disabled={pending} aria-busy={pending}>
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
