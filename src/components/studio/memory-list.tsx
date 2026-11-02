"use client";

import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { RelativeTime } from "@/components/shared/relative-time";
import { forgetMemory } from "@/app/a/_actions/agents";

type M = { id: string; kind: string; content: string; importance: number; source: string | null; createdAt: Date };
const KIND: Record<string, string> = { fact: "Facts", preference: "Preferences", person: "People", episode: "Episodes" };

export function MemoryList({ agency, agentId, memories, canEdit }: { agency: string; agentId: string; memories: M[]; canEdit: boolean }) {
  const [items, remove] = useOptimistic(memories, (state, id: string) => state.filter((m) => m.id !== id));
  const [, start] = useTransition();
  const groups = ["preference", "person", "fact", "episode"].map((k) => [k, items.filter((m) => m.kind === k)] as const).filter(([, l]) => l.length);
  return (
    <div className="space-y-10">
      {groups.map(([kind, list]) => (
        <section key={kind}>
          <h2 className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold text-ink">
            {KIND[kind]} <span className="tabular text-[12.5px] font-normal text-ink-4">{list.length}</span>
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
            {list.map((m) => (
              <li key={m.id} className="group flex items-start gap-3 px-4 py-3 sm:px-5">
                <span className="mt-[7px] flex shrink-0 gap-0.5" aria-label={`Importance ${m.importance} of 5`}>
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} className={i < m.importance ? "size-1 rounded-full bg-accent" : "size-1 rounded-full bg-line-strong"} />
                  ))}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] leading-relaxed text-ink-2">{m.content}</p>
                  <p className="mt-0.5 text-[12px] text-ink-4">
                    {m.source ? `${m.source} · ` : ""}
                    <RelativeTime date={m.createdAt} />
                  </p>
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    aria-label="Forget this memory"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-4 opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
                    onClick={() =>
                      start(async () => {
                        remove(m.id);
                        const r = await forgetMemory(agency, agentId, m.id);
                        if (r.ok) toast.success("Forgotten");
                        else toast.error(r.error);
                      })
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
