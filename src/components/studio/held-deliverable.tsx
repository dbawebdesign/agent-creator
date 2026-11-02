import { Clock, Eye } from "lucide-react";
import { Markdown } from "@/components/shared/markdown";
import { OUTPUT_LABEL } from "./bits";

/** "6:00 AM EST" (with "tomorrow" / weekday when not today) in the client's timezone. */
export function releaseLabel(releaseAt: Date, timezone: string) {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(releaseAt);
  const day = fmt(releaseAt) === fmt(new Date()) ? "" : fmt(releaseAt) === fmt(new Date(Date.now() + 86_400_000)) ? "tomorrow " : `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(releaseAt)} `;
  return `${day}${time}`.trim();
}

/**
 * A finished deliverable the agent is holding until its release time. The client hasn't seen it yet; the agency can
 * read it here (read-only). Server-rendered: the preview is a native disclosure, no client JS.
 */
export function HeldDeliverable({
  title,
  kind,
  preview,
  body,
  releaseAt,
  timezone,
  clientName,
}: {
  title: string;
  kind: string;
  preview: string | null;
  body: string;
  releaseAt: Date;
  timezone: string;
  clientName: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface shadow-xs">
      <div className="flex items-start gap-3 px-4 py-4">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Clock className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink">{title}</p>
          {preview ? <p className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-ink-3">{preview}</p> : null}
          <p className="mt-2 text-[12.5px] font-medium text-ink-2">
            Finished · held until {releaseLabel(releaseAt, timezone)}
            <span className="font-normal text-ink-3"> · {clientName} sees it then</span>
          </p>
        </div>
      </div>
      {body ? (
        <details className="group border-t border-line">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium text-accent hover:underline [&::-webkit-details-marker]:hidden">
            <Eye className="size-3.5" aria-hidden />
            <span className="group-open:hidden">Preview {(OUTPUT_LABEL[kind] ?? "deliverable").toLowerCase()}</span>
            <span className="hidden group-open:inline">Hide preview</span>
            <span className="ml-auto font-normal text-ink-4">Read-only</span>
          </summary>
          <div className="max-h-[60vh] overflow-y-auto border-t border-line px-4 py-4">
            <Markdown>{body}</Markdown>
          </div>
        </details>
      ) : null}
    </div>
  );
}
