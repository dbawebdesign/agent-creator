"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Check, Clock, Copy, FileUp, MessageCircleQuestion, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { retrySetup } from "@/app/a/_actions/agents";

/** The first overnight deliverable, shown as a pending row until it lands. */
export function FirstDeliverableRow({
  title,
  description,
  status,
  lands,
}: {
  title: string;
  description: string;
  status: "queued" | "running" | "waiting_approval" | "failed" | "canceled" | "succeeded";
  lands: string | null;
}) {
  const failed = status === "failed" || status === "canceled";
  const label = failed ? "Didn’t finish" : status === "running" ? "Working on it now" : status === "waiting_approval" ? "Waiting for approval" : "Queued";
  return (
    <div className={cn("rounded-xl border px-4 py-4", failed ? "border-bad/25 bg-bad-soft" : "border-dashed border-line-strong bg-surface")}>
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg", failed ? "bg-bad/10 text-bad" : "bg-accent-soft text-accent")}>
          {failed ? <TriangleAlert className="size-3.5" aria-hidden /> : status === "running" ? <span className="size-3 animate-spin rounded-full border-2 border-accent/25 border-t-accent" /> : <Clock className="size-3.5" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink">{title}</p>
          {description ? <p className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-ink-3">{description}</p> : null}
          <p className="mt-2 text-[12.5px] font-medium text-ink-2">
            {label}
            {!failed && lands ? <span className="font-normal text-ink-3"> · lands {lands}</span> : null}
            {failed ? <span className="font-normal text-ink-3"> · see Activity for the trace</span> : null}
          </p>
        </div>
      </div>
    </div>
  );
}

function questionsEmail(agentName: string, clientName: string, questions: string[], needs: { title: string; why: string }[]) {
  const lines = [`Hi ${clientName} team,`, "", `${agentName} starts tonight. A few things will help it get the details right from day one.`];
  if (questions.length) {
    lines.push("", "Could you confirm:");
    questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  }
  if (needs.length) {
    lines.push("", "And if you can send these over:");
    needs.forEach((n) => lines.push(`- ${n.title}${n.why ? ` (${n.why})` : ""}`));
  }
  lines.push("", "Thanks!");
  return lines.join("\n");
}

/** "Before tonight": what the proposal asked for, as a checklist the agency can work through. */
export function BeforeTonight({
  knowledgeHref,
  agentName,
  clientName,
  needs,
  questions,
  haveTitles,
  firstDone = false,
}: {
  knowledgeHref: string;
  agentName: string;
  clientName: string;
  needs: { title: string; why: string }[];
  questions: string[];
  haveTitles: string[];
  /** The first deliverable already ran: don't promise uploads will change it. */
  firstDone?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const have = haveTitles.map((t) => t.toLowerCase());
  const isDone = (title: string) => have.some((h) => h.includes(title.toLowerCase()) || title.toLowerCase().includes(h));
  if (!needs.length && !questions.length) return null;
  return (
    <section aria-labelledby="before-tonight" className="rounded-xl border border-line bg-surface shadow-xs">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 id="before-tonight" className="text-[14px] font-semibold text-ink">
            {firstDone ? "Still to collect" : "Before tonight"}
          </h2>
          <p className="text-[12.5px] text-ink-3">
            {firstDone ? `What the proposal asked for. Each one sharpens what ${agentName} delivers next.` : "What the proposal asked for. Each one makes the first deliverable sharper."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(questionsEmail(agentName, clientName, questions, needs.filter((n) => !isDone(n.title))));
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-medium text-ink-2 shadow-xs transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {copied ? <Check className="size-3.5 text-good" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy as email to client"}
        </button>
      </div>
      <ul className="divide-y divide-line">
        {needs.length ? (
          <li className="bg-surface-2/40 px-4 py-2 text-[12px] font-medium text-ink-3" aria-hidden>
            Knowledge to collect
          </li>
        ) : null}
        {needs.map((n) => {
          const done = isDone(n.title);
          return (
            <li key={`k-${n.title}`} className="flex items-start gap-3 px-4 py-3">
              <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border", done ? "border-transparent bg-good text-white" : "border-line-strong text-transparent")} aria-hidden>
                <Check className="size-3" strokeWidth={3} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13.5px] text-ink", done && "text-ink-3 line-through decoration-ink-4")}>{n.title}</p>
                {n.why ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{n.why}</p> : null}
              </div>
              {!done ? (
                <Link href={knowledgeHref} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-accent hover:underline">
                  <FileUp className="size-3.5" aria-hidden /> Add
                </Link>
              ) : (
                <span className="sr-only">Added</span>
              )}
            </li>
          );
        })}
        {questions.length ? (
          <li className="bg-surface-2/40 px-4 py-2 text-[12px] font-medium text-ink-3" aria-hidden>
            Confirm with {clientName}
          </li>
        ) : null}
        {questions.map((q) => (
          <li key={`q-${q}`} className="flex items-start gap-3 px-4 py-3">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
            <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-ink-2">
              <span className="sr-only">Confirm with the client: </span>
              {q}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Re-render the server page every few seconds while something is still setting up. */
export function AutoRefresh({ every = 2500 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [router, every]);
  return null;
}

/** Retry a stalled setup (re-runs provisioning, then activates). */
export function RetrySetupButton({ agency, agentId, agentName }: { agency: string; agentId: string; agentName: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="primary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retrySetup(agency, agentId);
          if (!r.ok) return void toast.error(r.error);
          toast.success(`${agentName} is set up`);
          router.refresh();
        })
      }
    >
      <RotateCw className={cn("!size-3.5", pending && "animate-spin")} /> {pending ? "Retrying…" : "Retry setup"}
    </Button>
  );
}
