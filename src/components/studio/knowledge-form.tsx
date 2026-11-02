"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { addKnowledgeSource } from "@/app/a/_actions/agents";

export function KnowledgeForm({ agency, agentId }: { agency: string; agentId: string }) {
  const [kind, setKind] = useState<"text" | "url">("url");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addKnowledgeSource(agency, agentId, kind === "text" ? { kind, title, content } : { kind, url, title: title || undefined });
          if (!r.ok) return void toast.error(r.error);
          toast.success("Added — indexing now");
          setTitle("");
          setContent("");
          setUrl("");
        });
      }}
    >
      <div className="mb-4 inline-flex rounded-lg border border-line bg-surface-2 p-0.5" role="tablist" aria-label="Source type">
        {(["url", "text"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={cn("h-7 rounded-md px-3 text-[12.5px] font-medium transition-colors", kind === k ? "bg-surface text-ink shadow-xs" : "text-ink-3 hover:text-ink")}
          >
            {k === "url" ? "Link" : "Text"}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {kind === "url" ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <Input type="url" required placeholder="https://brandlord.co/pricing" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
            <Input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          </div>
        ) : (
          <>
            <Input required placeholder="Title, e.g. Pricing rules" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
            <Textarea required placeholder="Paste policies, price sheets, FAQs, SOPs…" value={content} onChange={(e) => setContent(e.target.value)} className="min-h-32" aria-label="Content" />
          </>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[12px] text-ink-3">Chunked and searchable by this agent within a minute.</p>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Adding…" : "Add source"}
        </Button>
      </div>
    </form>
  );
}
