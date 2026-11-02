import Link from "next/link";
import { AgentOrb } from "@/components/ui/agent-orb";
import type { DeliverableCard as Card } from "@/server/queries/portal";
import { DeliveredVia, KindIcon, kindLabel } from "./icons";
import { testModeChannels } from "./test-mode";
import { clockTime, dayWord, shortHours, capitalize } from "./lib";
import { cn } from "@/lib/utils";

export function whenLabel(date: Date, tz: string): string {
  const day = dayWord(date, tz);
  const t = clockTime(date, tz);
  return day === "today" ? t : `${capitalize(day)}, ${t}`;
}

export function DeliverableCardView({
  d,
  slug,
  tz,
  compact,
  hideAgent,
}: {
  d: Card;
  slug: string;
  tz: string;
  compact?: boolean;
  hideAgent?: boolean;
}) {
  const unseen = d.status === "new";
  return (
    <Link
      href={`/p/${slug}/d/${d.id}`}
      className={cn(
        "group block rounded-xl border border-line bg-surface shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:border-line-strong hover:shadow-md active:scale-[0.995]",
        compact ? "p-4" : "p-4 md:p-5",
      )}
    >
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
        {hideAgent ? null : (
          <>
            <AgentOrb seed={d.agent.seed} name={d.agent.name} size={20} />
            <span className="font-medium text-ink-2">{d.agent.name}</span>
            <span aria-hidden className="text-ink-3">
              ·
            </span>
          </>
        )}
        <time dateTime={d.createdAt.toISOString()} className="tabular">
          {whenLabel(d.createdAt, tz)}
        </time>
        {unseen ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            New
          </span>
        ) : null}
      </div>
      <h3
        className={cn(
          "mt-2.5 font-semibold tracking-[-0.01em] text-ink text-pretty",
          compact ? "text-[14.5px]" : "text-[15.5px]",
        )}
      >
        {d.title}
      </h3>
      {d.preview ? (
        <p className="mt-1 line-clamp-2 text-[13.5px] leading-relaxed text-ink-3 text-pretty">
          {d.preview}
        </p>
      ) : null}
      <div className="mt-3.5 flex items-center gap-3 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <KindIcon kind={d.kind} />
          {kindLabel(d.kind)}
        </span>
        <DeliveredVia via={d.deliveredVia} testMode={testModeChannels()} />
        {d.status === "approved" ? (
          <span className="text-good">Approved</span>
        ) : null}
        {d.status === "changes_requested" ? (
          <span className="text-warn">Changes requested</span>
        ) : null}
        {d.hoursSaved > 0 ? (
          <span className="ml-auto tabular">
            ~{shortHours(d.hoursSaved)} saved
          </span>
        ) : null}
      </div>
    </Link>
  );
}
