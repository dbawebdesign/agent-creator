import Link from "next/link";
import { ArrowRight, LayoutTemplate } from "lucide-react";
import { requireOrg } from "@/server/auth/access";
import { listBlueprints } from "@/server/queries/studio";
import { AgentOrb } from "@/components/ui/agent-orb";
import { EmptyState } from "@/components/ui/empty";
import { RelativeTime } from "@/components/shared/relative-time";
import { describeTrigger } from "@/components/studio/cron";

export const metadata = { title: "Blueprints" };

type Spec = { role?: string; summary?: string; workflows?: { name?: string; trigger?: { type: string; cron?: string; event?: string } }[]; weeklyHoursSaved?: number };

export default async function BlueprintsPage({ params }: { params: Promise<{ agency: string }> }) {
  const { agency: slug } = await params;
  const { org } = await requireOrg(slug, "viewer");
  const blueprints = await listBlueprints(org.id);
  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <header className="mb-8">
        <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">Blueprints</h1>
        <p className="mt-1 max-w-[62ch] text-[14px] text-ink-3">Your proven AI employees, packaged. Hire one for a new client in a minute — no discovery call needed.</p>
      </header>
      {blueprints.length ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {blueprints.map((b) => {
            const spec = b.spec as Spec;
            const wfs = spec.workflows ?? [];
            return (
              <li key={b.id} className="flex flex-col rounded-xl border border-line bg-surface p-5 shadow-xs">
                <div className="flex items-start gap-3">
                  <AgentOrb seed={b.id} size={34} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{b.name}</p>
                    <p className="truncate text-[12.5px] text-ink-3">{[b.vertical, spec.role].filter(Boolean).join(" · ") || "Blueprint"}</p>
                  </div>
                  <span className="tabular shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3">v{b.version}</span>
                </div>
                {b.summary || spec.summary ? <p className="mt-3 line-clamp-2 text-[13.5px] leading-relaxed text-ink-2">{b.summary ?? spec.summary}</p> : null}
                {wfs.length ? (
                  <ul className="mt-4 space-y-1.5 border-t border-line pt-4">
                    {wfs.slice(0, 4).map((w, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                        <span className="truncate text-ink-2">{w.name}</span>
                        <span className="shrink-0 text-ink-4">{w.trigger ? describeTrigger(w.trigger) : ""}</span>
                      </li>
                    ))}
                    {wfs.length > 4 ? <li className="text-[12px] text-ink-3">+{wfs.length - 4} more</li> : null}
                  </ul>
                ) : null}
                <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                  <span className="text-[12px] text-ink-3">
                    Updated <RelativeTime date={b.updatedAt} />
                    {spec.weeklyHoursSaved ? ` · ~${spec.weeklyHoursSaved} h/week` : ""}
                  </span>
                  <Link href={`/a/${slug}/agents/new?blueprint=${b.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-ink hover:text-accent">
                    Hire for a client <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState icon={<LayoutTemplate />} title="No blueprints yet" body="Open any agent and choose “Save as blueprint” to reuse its job, workflows and voice for other clients." />
        </div>
      )}
    </div>
  );
}
