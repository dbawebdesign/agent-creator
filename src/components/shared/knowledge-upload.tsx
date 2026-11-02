"use client";

/**
 * Drag-and-drop (or pick) files into an org's or agent's knowledge base.
 * Posts each file to POST /api/orgs/[orgId]/knowledge/upload, one at a time, with progress.
 *
 *   <KnowledgeUpload orgId={org.id} agentId={agent.id} />
 */
import { CheckCircle2, FileUp, Loader2, X, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ACCEPT = ".csv,.tsv,.txt,.md,.json,.html,.htm,.pdf,.docx";
const EXTENSIONS = new Set(["csv", "tsv", "tab", "txt", "text", "md", "markdown", "json", "html", "htm", "pdf", "docx"]);
const MAX_BYTES = 10 * 1024 * 1024;

type Item = {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: "queued" | "uploading" | "processing" | "done" | "error";
  message?: string;
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function precheck(file: File): string | null {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (!EXTENSIONS.has(ext)) return "Not a supported type. Use CSV, TSV, TXT, Markdown, JSON, HTML, PDF or DOCX.";
  if (file.size > MAX_BYTES) return "Over 10 MB.";
  if (file.size === 0) return "This file is empty.";
  return null;
}

type UploadResult = { ok: true; duplicate: boolean; truncated: boolean } | { ok: false; message: string };

function send(orgId: string, agentId: string | undefined, file: File, onProgress: (p: number) => void): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    if (agentId) form.append("agentId", agentId);
    xhr.open("POST", `/api/orgs/${encodeURIComponent(orgId)}/knowledge/upload`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as { file?: { duplicate?: boolean; truncated?: boolean }; error?: { message?: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.file) {
        resolve({ ok: true, duplicate: Boolean(body.file.duplicate), truncated: Boolean(body.file.truncated) });
      } else if (xhr.status === 401) {
        resolve({ ok: false, message: "Your session expired. Sign in again." });
      } else {
        resolve({ ok: false, message: body?.error?.message ?? "Upload failed. Try again." });
      }
    };
    xhr.onerror = () => resolve({ ok: false, message: "Network error. Check your connection and try again." });
    xhr.send(form);
  });
}

export function KnowledgeUpload({ orgId, agentId, className }: { orgId: string; agentId?: string; className?: string }) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const busy = items.some((i) => i.state === "queued" || i.state === "uploading" || i.state === "processing");

  const update = (key: string, patch: Partial<Item>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const start = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const batch = files.map((f, n) => {
        const problem = precheck(f);
        const item: Item = { key: `${Date.now()}-${n}-${f.name}`, name: f.name, size: f.size, progress: 0, state: problem ? "error" : "queued", message: problem ?? undefined };
        return { file: f, item };
      });
      setItems((cur) => [...batch.map((b) => b.item), ...cur].slice(0, 20));
      let added = 0;
      for (const { file, item } of batch) {
        if (item.state === "error") continue;
        update(item.key, { state: "uploading" });
        const res = await send(orgId, agentId, file, (p) => update(item.key, { progress: p, state: p >= 1 ? "processing" : "uploading" }));
        if (res.ok) {
          added += res.duplicate ? 0 : 1;
          update(item.key, {
            state: "done",
            progress: 1,
            message: res.duplicate ? "Already in the knowledge base." : res.truncated ? "Added (very long, so only the first part is kept)." : "Added. Indexing takes a few seconds.",
          });
        } else {
          update(item.key, { state: "error", message: res.message });
        }
      }
      if (added > 0) {
        toast.success(added === 1 ? "File added to knowledge" : `${added} files added to knowledge`);
        router.refresh();
      }
    },
    [orgId, agentId, router],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void start(Array.from(e.dataTransfer.files));
  };

  return (
    <div className={cn("space-y-2", className)}>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors duration-150",
          "focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15",
          dragging ? "border-accent bg-accent/5" : "border-line-strong bg-surface hover:bg-surface-2",
        )}
      >
        <FileUp className="size-5 text-ink-3" aria-hidden />
        <span className="text-[13.5px] font-medium text-ink">
          {dragging ? "Drop to upload" : "Drop files here or "}
          {!dragging ? <span className="text-accent underline-offset-2 hover:underline">choose files</span> : null}
        </span>
        <span className="text-[12.5px] text-ink-3">CSV, TSV, TXT, Markdown, JSON, HTML, PDF or DOCX · up to 10 MB each</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void start(files);
          }}
        />
      </label>

      {items.length > 0 ? (
        <ul className="space-y-1.5" aria-live="polite">
          {items.map((i) => (
            <li key={i.key} className="rounded-md border border-line bg-surface px-3 py-2">
              <div className="flex items-center gap-2 text-[13px]">
                {i.state === "done" ? (
                  <CheckCircle2 className="size-4 shrink-0 text-good" aria-hidden />
                ) : i.state === "error" ? (
                  <XCircle className="size-4 shrink-0 text-bad" aria-hidden />
                ) : (
                  <Loader2 className="size-4 shrink-0 animate-spin text-ink-3" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{i.name}</span>
                <span className="shrink-0 tabular-nums text-ink-3">{formatSize(i.size)}</span>
                {i.state === "done" || i.state === "error" ? (
                  <button
                    type="button"
                    aria-label={`Dismiss ${i.name}`}
                    className="-mr-1 rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
                    onClick={() => setItems((cur) => cur.filter((x) => x.key !== i.key))}
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
              {i.state === "uploading" || i.state === "processing" ? (
                <div className="mt-1.5">
                  <div className="h-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={`Uploading ${i.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(i.progress * 100)}>
                    <div className={cn("h-full rounded-full bg-accent transition-[width] duration-150", i.state === "processing" && "animate-pulse")} style={{ width: `${Math.max(4, Math.round(i.progress * 100))}%` }} />
                  </div>
                  <p className="mt-1 text-[12px] text-ink-3">{i.state === "processing" ? "Reading the file…" : `Uploading… ${Math.round(i.progress * 100)}%`}</p>
                </div>
              ) : i.message ? (
                <p className={cn("mt-0.5 pl-6 text-[12.5px]", i.state === "error" ? "text-bad" : "text-ink-3")}>{i.message}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
