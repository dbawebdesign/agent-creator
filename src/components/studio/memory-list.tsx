"use client";

import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil, X } from "lucide-react";
import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/field";
import { editMemory, forgetMemory } from "@/app/a/_actions/agents";

type M = { id: string; kind: string; content: string; importance: number; source: string | null; createdAt: Date };
type Kind = "fact" | "preference" | "person" | "episode";
const KIND: Record<string, string> = { fact: "Facts", preference: "Preferences", person: "People", episode: "Episodes" };
const KIND_ONE: Record<Kind, string> = { fact: "Fact", preference: "Preference", person: "Person", episode: "Episode" };

type Action = { type: "remove"; id: string } | { type: "edit"; id: string; patch: Partial<M> };

export function MemoryList({ agency, agentId, memories, canEdit }: { agency: string; agentId: string; memories: M[]; canEdit: boolean }) {
  const [items, apply] = useOptimistic(memories, (state, a: Action) =>
    a.type === "remove" ? state.filter((m) => m.id !== a.id) : state.map((m) => (m.id === a.id ? { ...m, ...a.patch } : m)),
  );
  const [, start] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const groups = ["preference", "person", "fact", "episode"].map((k) => [k, items.filter((m) => m.kind === k)] as const).filter(([, l]) => l.length);
  return (
    <div className="space-y-10">
      {groups.map(([kind, list]) => (
        <section key={kind}>
          <h2 className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold text-ink">
            {KIND[kind]} <span className="tabular text-[12.5px] font-normal text-ink-3">{list.length}</span>
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
            {list.map((m) =>
              editing === m.id ? (
                <li key={m.id} className="px-4 py-3 sm:px-5">
                  <MemoryEditor
                    memory={m}
                    onCancel={() => setEditing(null)}
                    onSave={(patch) =>
                      start(async () => {
                        setEditing(null);
                        apply({ type: "edit", id: m.id, patch });
                        const r = await editMemory(agency, agentId, { memoryId: m.id, kind: patch.kind as Kind, content: patch.content!, importance: patch.importance! });
                        if (r.ok) toast.success("Memory updated");
                        else toast.error(r.error);
                      })
                    }
                  />
                </li>
              ) : (
                <li key={m.id} className="group flex items-start gap-3 px-4 py-3 sm:px-5">
                  <span className="mt-[7px] flex shrink-0 gap-0.5" aria-label={`Importance ${m.importance} of 5`}>
                    {Array.from({ length: 5 }, (_, i) => (
                      <span key={i} className={i < m.importance ? "size-1 rounded-full bg-accent" : "size-1 rounded-full bg-line-strong"} />
                    ))}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] leading-relaxed text-ink-2">{m.content}</p>
                    <p className="mt-0.5 text-[12px] text-ink-3">
                      {m.source ? `${m.source} · ` : ""}
                      <RelativeTime date={m.createdAt} />
                    </p>
                  </div>
                  {canEdit ? (
                    <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100">
                      <button
                        type="button"
                        aria-label="Edit this memory"
                        className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
                        onClick={() => setEditing(m.id)}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Forget this memory"
                        className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
                        onClick={() =>
                          start(async () => {
                            apply({ type: "remove", id: m.id });
                            const r = await forgetMemory(agency, agentId, m.id);
                            if (r.ok) toast.success("Forgotten");
                            else toast.error(r.error);
                          })
                        }
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MemoryEditor({ memory, onSave, onCancel }: { memory: M; onSave: (p: { kind: string; content: string; importance: number }) => void; onCancel: () => void }) {
  const [content, setContent] = useState(memory.content);
  const [kind, setKind] = useState<Kind>((memory.kind as Kind) ?? "fact");
  const [importance, setImportance] = useState(memory.importance);
  const submit = () => content.trim().length >= 3 && onSave({ kind, content: content.trim(), importance });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
      className="space-y-3"
    >
      <Textarea autoFocus value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} className="min-h-20 text-[13.5px]" aria-label="Memory" />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Kind" className="h-8 w-auto text-[12.5px]">
          {(Object.keys(KIND_ONE) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_ONE[k]}
            </option>
          ))}
        </Select>
        <Select value={String(importance)} onChange={(e) => setImportance(Number(e.target.value))} aria-label="Importance" className="h-8 w-auto text-[12.5px]">
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>
              {n === 5 ? "5 · Always remember" : n === 1 ? "1 · Minor" : `${n}`}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={content.trim().length < 3}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
