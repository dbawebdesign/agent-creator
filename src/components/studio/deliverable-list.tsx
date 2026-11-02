"use client";

import { useState } from "react";
import { FileText, Mail, MessageSquare, Table2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Markdown } from "@/components/shared/markdown";
import { RelativeTime } from "@/components/shared/relative-time";
import { hours, OUTPUT_LABEL, previewBeyondTitle } from "./bits";

type D = { id: string; title: string; preview: string | null; body: string; kind: string; status: string; needsReview: boolean; hoursSaved: number; createdAt: Date; deliveredVia: string[] };

const ICON: Record<string, typeof FileText> = { table: Table2, email_draft: Mail, message: MessageSquare };
const STATUS: Record<string, string> = { new: "New", seen: "Seen", approved: "Approved", changes_requested: "Changes requested", archived: "Archived" };

export function DeliverableList({ items, empty, initialOpenId }: { items: D[]; empty: React.ReactNode; initialOpenId?: string }) {
  const [open, setOpen] = useState<D | null>(() => items.find((d) => d.id === initialOpenId) ?? null);
  if (!items.length) return <>{empty}</>;
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
        {items.map((d) => {
          const Icon = ICON[d.kind] ?? FileText;
          return (
            <li key={d.id}>
              <button type="button" onClick={() => setOpen(d)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/50 focus-visible:bg-surface-2/50 sm:px-5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3">
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-ink">{d.title}</span>
                  {previewBeyondTitle(d.title, d.preview) ? <span className="mt-0.5 line-clamp-1 block text-[12.5px] text-ink-3">{previewBeyondTitle(d.title, d.preview)}</span> : null}
                  <span className="mt-1 block text-[12px] text-ink-3">
                    {OUTPUT_LABEL[d.kind] ?? d.kind} · {d.needsReview && d.status === "new" ? <span className="text-warn">Needs review</span> : STATUS[d.status] ?? d.status}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <RelativeTime date={d.createdAt} className="block text-[12px] text-ink-3" />
                  {d.hoursSaved ? <span className="tabular mt-1 block text-[12px] font-medium text-good">+{hours(d.hoursSaved)}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open ? (
          <DialogContent title={open.title} description={`${OUTPUT_LABEL[open.kind] ?? open.kind} · ${new Date(open.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}${open.deliveredVia.length ? ` · via ${open.deliveredVia.join(", ")}` : ""}`} wide className="max-w-2xl">
            <div className="-mx-5 max-h-[60vh] overflow-y-auto border-t border-line px-5 pt-4">
              <Markdown>{open.body}</Markdown>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
