"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { decideApprovalAction, reviewDeliverableAction } from "@/app/p/[org]/actions";
import { AgentOrb } from "@/components/ui/agent-orb";
import { Button, buttonClass } from "@/components/ui/button";
import { KindIcon, kindLabel } from "./icons";
import { cn } from "@/lib/utils";

export type NeedsYouItem =
  | {
      type: "deliverable";
      id: string;
      title: string;
      preview: string | null;
      kind: string;
      when: string;
      agent: { name: string; seed: string };
      /** A send/act approval rides along with this review. */
      sendsOnApprove: boolean;
    }
  | {
      type: "approval";
      id: string;
      description: string;
      when: string;
      agent: { name: string; seed: string };
    };

export function NeedsYou({ slug, items, canAct }: { slug: string; items: NeedsYouItem[]; canAct: boolean }) {
  const [done, setDone] = useState<Record<string, "approved" | "declined">>({});
  const open = items.filter((i) => !done[i.id]);
  return (
    <section aria-labelledby="needs-you" className="mt-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="needs-you" className="text-[13px] font-semibold text-ink">
          Needs your OK
          <span className="ml-2 font-normal text-ink-4 tabular">{open.length}</span>
        </h2>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        {items.map((it) => (
          <Row key={it.id} slug={slug} item={it} canAct={canAct} state={done[it.id]} onDone={(s) => setDone((d) => ({ ...d, [it.id]: s }))} />
        ))}
      </ul>
    </section>
  );
}

function Row({
  slug,
  item,
  canAct,
  state,
  onDone,
}: {
  slug: string;
  item: NeedsYouItem;
  canAct: boolean;
  state?: "approved" | "declined";
  onDone: (s: "approved" | "declined") => void;
}) {
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<"approve" | "decline" | null>(null);

  const act = (kind: "approve" | "decline") => {
    setWhich(kind);
    start(async () => {
      const res =
        item.type === "approval"
          ? await decideApprovalAction({ slug, approvalId: item.id, decision: kind === "approve" ? "approved" : "rejected" })
          : await reviewDeliverableAction({ slug, deliverableId: item.id, action: "approve" });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onDone(kind === "approve" ? "approved" : "declined");
      toast.success(kind === "approve" ? (item.type === "deliverable" && item.sendsOnApprove ? "Approved — sending now" : "Approved") : "Declined", {
        description: kind === "approve" ? `${item.agent.name} will take it from here.` : `${item.agent.name} won't go ahead.`,
      });
    });
  };

  const title = item.type === "deliverable" ? item.title : item.description;
  const href = item.type === "deliverable" ? `/p/${slug}/d/${item.id}` : null;

  return (
    <li className={cn("relative flex flex-col gap-3 p-4 transition-opacity sm:flex-row sm:items-center sm:gap-4 md:px-5", state && "opacity-60")}>
      <span aria-hidden className="absolute top-4 bottom-4 left-0 w-[3px] rounded-r-full bg-accent" />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AgentOrb seed={item.agent.seed} size={32} className="mt-0.5" />
        <div className="min-w-0">
          <p className="text-[12.5px] text-ink-3">
            <span className="font-medium text-ink-2">{item.agent.name}</span>
            {item.type === "deliverable" ? (item.sendsOnApprove ? " wants to send this" : " wants your review") : " is asking first"}
            <span aria-hidden className="text-ink-4"> · </span>
            {item.when}
          </p>
          {href ? (
            <Link href={href} className="mt-0.5 block text-[14.5px] font-semibold tracking-[-0.01em] text-ink hover:underline hover:decoration-line-strong hover:underline-offset-4">
              {title}
            </Link>
          ) : (
            <p className="mt-0.5 text-[14.5px] font-semibold tracking-[-0.01em] text-ink">{title}</p>
          )}
          {item.type === "deliverable" && item.preview ? (
            <p className="mt-0.5 line-clamp-1 text-[13px] text-ink-3">{item.preview}</p>
          ) : null}
          {item.type === "deliverable" ? (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] text-ink-4">
              <KindIcon kind={item.kind} /> {kindLabel(item.kind)}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">
        {state ? (
          <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", state === "approved" ? "text-good" : "text-ink-3")}>
            <Check className="size-4" aria-hidden /> {state === "approved" ? "Approved" : "Declined"}
          </span>
        ) : item.type === "deliverable" ? (
          <>
            <Link href={href!} className={buttonClass("secondary", "md")}>
              Review <ArrowRight aria-hidden />
            </Link>
            {canAct ? (
              <Button variant="accent" onClick={() => act("approve")} disabled={pending} aria-busy={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Check aria-hidden />}
                {item.sendsOnApprove ? "Approve & send" : "Approve"}
              </Button>
            ) : null}
          </>
        ) : canAct ? (
          <>
            <Button variant="ghost" onClick={() => act("decline")} disabled={pending}>
              {pending && which === "decline" ? <Loader2 className="animate-spin" /> : null}
              Decline
            </Button>
            <Button variant="accent" onClick={() => act("approve")} disabled={pending} aria-busy={pending}>
              {pending && which === "approve" ? <Loader2 className="animate-spin" /> : <Check aria-hidden />}
              Approve
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
