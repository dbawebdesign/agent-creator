"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowRight, Check, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import {
  decideApprovalAction,
  reviewDeliverableAction,
} from "@/app/p/[org]/actions";
import { AgentOrb } from "@/components/ui/agent-orb";
import { Button, buttonClass } from "@/components/ui/button";
import { KindIcon, kindLabel } from "./icons";
import { holdWithUndo, UNDO_MS } from "./undo";
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

export function NeedsYou({
  slug,
  items,
  canAct,
}: {
  slug: string;
  items: NeedsYouItem[];
  canAct: boolean;
}) {
  const [done, setDone] = useState<Record<string, "approved" | "declined">>({});
  const open = items.filter((i) => !done[i.id]);
  return (
    <section aria-labelledby="needs-you" className="mt-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="needs-you" className="text-[13px] font-semibold text-ink">
          Needs your OK
          <span className="ml-2 font-normal text-ink-3 tabular">
            {open.length}
          </span>
        </h2>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        {items.map((it) => (
          <Row
            key={it.id}
            slug={slug}
            item={it}
            canAct={canAct}
            state={done[it.id]}
            onDone={(s) => setDone((d) => ({ ...d, [it.id]: s }))}
          />
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
  const [holding, setHolding] = useState<null | (() => void)>(null);

  const commit = (kind: "approve" | "decline") => {
    setWhich(kind);
    start(async () => {
      const res =
        item.type === "approval"
          ? await decideApprovalAction({
              slug,
              approvalId: item.id,
              decision: kind === "approve" ? "approved" : "rejected",
            })
          : await reviewDeliverableAction({
              slug,
              deliverableId: item.id,
              action: "approve",
            });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // The row's own "Approved" / "Declined" state is the one confirmation.
      onDone(kind === "approve" ? "approved" : "declined");
    });
  };

  // An approval lets the agent act for you (send, post, book), so it waits a few seconds behind Undo.
  const approveAction = () => {
    const undo = holdWithUndo({
      title: `Approving in ${UNDO_MS / 1000} seconds`,
      description: item.type === "approval" ? item.description : undefined,
      commit: () => {
        setHolding(null);
        commit("approve");
      },
      onUndo: () => setHolding(null),
    });
    setHolding(() => undo);
  };

  const title = item.type === "deliverable" ? item.title : item.description;
  const href = item.type === "deliverable" ? `/p/${slug}/d/${item.id}` : null;
  const sends = item.type === "deliverable" && item.sendsOnApprove;

  return (
    <li
      className={cn(
        "flex flex-col gap-3 p-4 transition-opacity sm:flex-row sm:items-center sm:gap-4 md:px-5",
        state && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AgentOrb
          seed={item.agent.seed}
          name={item.agent.name}
          size={32}
          className="mt-0.5"
        />
        <div className="min-w-0">
          <p className="text-[12.5px] text-ink-3">
            <span className="font-medium text-ink-2">{item.agent.name}</span>
            {item.type === "deliverable"
              ? sends
                ? " wants to send this"
                : " wants your review"
              : " is asking first"}
            <span aria-hidden> · </span>
            {item.when}
          </p>
          {href ? (
            <Link
              href={href}
              className="mt-0.5 block text-[14.5px] font-semibold tracking-[-0.01em] text-ink hover:underline hover:decoration-line-strong hover:underline-offset-4"
            >
              {title}
            </Link>
          ) : (
            <p className="mt-0.5 text-[14.5px] font-semibold tracking-[-0.01em] text-ink">
              {title}
            </p>
          )}
          {item.type === "deliverable" && item.preview ? (
            <p className="mt-0.5 line-clamp-1 text-[13px] text-ink-3">
              {item.preview}
            </p>
          ) : null}
          {item.type === "deliverable" ? (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] text-ink-3">
              <KindIcon kind={item.kind} /> {kindLabel(item.kind)}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:items-center">
        {state ? (
          <span
            className={cn(
              "col-span-2 inline-flex items-center gap-1.5 text-[13px] font-medium",
              state === "approved" ? "text-good" : "text-ink-3",
            )}
          >
            <Check className="size-4" aria-hidden />{" "}
            {state === "approved" ? "Approved" : "Declined"}
          </span>
        ) : holding ? (
          <>
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-[13px] text-ink-2"
            >
              <Loader2 className="size-4 animate-spin text-ink-3" aria-hidden />{" "}
              Approving…
            </span>
            <Button variant="secondary" onClick={() => holding()}>
              <Undo2 aria-hidden /> Undo
            </Button>
          </>
        ) : sends ? (
          // Anything that leaves the building gets read first: no one-tap send from a list.
          <Link
            href={href!}
            className={cn(buttonClass("accent", "md"), "col-span-2")}
          >
            Review &amp; send <ArrowRight aria-hidden />
          </Link>
        ) : item.type === "deliverable" ? (
          <>
            <Link
              href={href!}
              className={cn(
                buttonClass("secondary", "md"),
                !canAct && "col-span-2",
              )}
            >
              Review <ArrowRight aria-hidden />
            </Link>
            {canAct ? (
              <Button
                variant="accent"
                onClick={() => commit("approve")}
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Check aria-hidden />
                )}
                Approve
              </Button>
            ) : null}
          </>
        ) : canAct ? (
          <>
            <Button
              variant="secondary"
              onClick={() => commit("decline")}
              disabled={pending}
            >
              {pending && which === "decline" ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Decline
            </Button>
            <Button
              variant="accent"
              onClick={approveAction}
              disabled={pending}
              aria-busy={pending}
            >
              {pending && which === "approve" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Check aria-hidden />
              )}
              Approve
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
