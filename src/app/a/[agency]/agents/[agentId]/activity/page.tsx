import { notFound } from "next/navigation";
import { Activity, ChevronRight } from "lucide-react";
import { hasRole, requireOrg } from "@/server/auth/access";
import { agentRuns, getAgent, heldDeliverables } from "@/server/queries/studio";
import { HeldDeliverable, releaseLabel } from "@/components/studio/held-deliverable";
import { EmptyState } from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/badge";
import { RelativeTime } from "@/components/shared/relative-time";
import { microsToDollars } from "@/components/studio/bits";
import { cn } from "@/lib/utils";

export const metadata = { title: "Activity" };

const STATUS: Record<string, { tone: "good" | "bad" | "warn" | "accent" | "neutral"; label: string; pulse?: boolean }> = {
  succeeded: { tone: "good", label: "Succeeded" },
  failed: { tone: "bad", label: "Failed" },
  waiting_approval: { tone: "warn", label: "Waiting for approval" },
  running: { tone: "accent", label: "Running", pulse: true },
  queued: { tone: "neutral", label: "Queued", pulse: true },
  canceled: { tone: "neutral", label: "Canceled" },
};

const STEP: Record<string, string> = { thought: "Thought", tool_call: "Tool", tool_result: "Result", message: "Message", error: "Error" };

function duration(a: Date | null, b: Date | null) {
  if (!a || !b) return null;
  const s = Math.max(0, (b.getTime() - a.getTime()) / 1000);
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function stepText(data: Record<string, unknown>): string {
  for (const k of ["text", "summary", "message", "content", "result", "output", "error"]) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  const json = JSON.stringify(data.input ?? data, null, 2);
  return json === "{}" ? "" : json;
}

export default async function ActivityPage({ params }: { params: Promise<{ agency: string; agentId: string }> }) {
  const { agency: slug, agentId } = await params;
  const access = await requireOrg(slug, "viewer");
  const found = await getAgent(access.org.id, agentId);
  if (!found) notFound();
  const runs = await agentRuns(found.agent.orgId, found.agent.id, 40);
  // Finished-early deliverables still waiting for their release time: never call them "ready" (the client hasn't got them).
  const held = await heldDeliverables(found.agent.orgId, runs.filter((r) => r.status === "succeeded").map((r) => r.id));
  const tz = found.org.timezone;
  const totals = runs.reduce((t, r) => ({ tokens: t.tokens + r.inputTokens + r.outputTokens, cost: t.cost + r.costMicros }), { tokens: 0, cost: 0 });

  if (!runs.length) {
    return (
      <div className="rounded-xl border border-dashed border-line">
        <EmptyState icon={<Activity />} title="No runs yet" body="Every scheduled workflow, message and manual run shows up here with a full step trace." />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13.5px] text-ink-3">Every run with its step trace. Token usage and cost are visible to your agency only.</p>
        <p className="tabular text-[12.5px] text-ink-3">
          Last {runs.length} runs · {totals.tokens.toLocaleString()} tokens · {microsToDollars(totals.cost)}
        </p>
      </div>
      <ul className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
        {runs.map((r, i) => {
          const hold = held.find((h) => h.runId === r.id);
          const st = hold ? { tone: "accent" as const, label: `Ready · lands ${releaseLabel(hold.releaseAt, tz)}` } : (STATUS[r.status] ?? { tone: "neutral" as const, label: r.status });
          return (
            <li key={r.id} className={cn(i > 0 && "border-t border-line")}>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2/50 sm:px-5 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 shrink-0 text-ink-4 transition-transform group-open:rotate-90" aria-hidden />
                  <StatusDot tone={st.tone} pulse={st.pulse} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-ink">{r.workflowName ?? (r.trigger === "message" ? "Conversation reply" : r.trigger === "setup" ? "First deliverable" : "Manual run")}</p>
                    <p className="truncate text-[12.5px] text-ink-3">{hold ? `“${hold.title}” is ready · lands ${releaseLabel(hold.releaseAt, tz)}` : (r.error ?? r.summary ?? st.label)}</p>
                  </div>
                  <div className="tabular hidden shrink-0 text-right text-[12px] text-ink-3 sm:block">
                    <p>{(r.inputTokens + r.outputTokens).toLocaleString()} tok · {microsToDollars(r.costMicros)}</p>
                    <p>{duration(r.startedAt, r.finishedAt) ?? r.trigger}</p>
                  </div>
                  <RelativeTime date={r.createdAt} className="w-20 shrink-0 text-right text-[12px] text-ink-3" />
                </summary>
                <div className="border-t border-line bg-canvas/60 px-4 py-4 sm:px-5 sm:pl-12">
                  <div className="tabular mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
                    <span>Trigger: {r.trigger}</span>
                    <span>Input {r.inputTokens.toLocaleString()} tok</span>
                    <span>Output {r.outputTokens.toLocaleString()} tok</span>
                    <span>Cost {microsToDollars(r.costMicros)}</span>
                    {duration(r.startedAt, r.finishedAt) ? <span>Took {duration(r.startedAt, r.finishedAt)}</span> : null}
                  </div>
                  {hold ? (
                    <div className="mb-4">
                      <HeldDeliverable
                        title={hold.title}
                        kind={hold.kind}
                        preview={hold.preview}
                        body={hold.body}
                        releaseAt={hold.releaseAt}
                        timezone={tz}
                        clientName={found.org.name}
                        release={hasRole(access, "member") && found.agent.status !== "archived" ? { agency: slug, agentId: found.agent.id, runId: r.id } : undefined}
                      />
                    </div>
                  ) : null}
                  {r.steps.length ? (
                    <ol className="space-y-2">
                      {r.steps.map((s) => {
                        const text = stepText(s.data);
                        return (
                          <li key={s.id} className="flex gap-3">
                            <span className={cn("mt-0.5 w-16 shrink-0 text-[11.5px] font-medium", s.kind === "error" ? "text-bad" : s.kind === "tool_call" ? "text-accent" : "text-ink-3")}>{STEP[s.kind] ?? s.kind}</span>
                            <div className="min-w-0 flex-1">
                              {s.name ? <p className="font-mono text-[12px] text-ink-2">{s.name}</p> : null}
                              {text ? <pre className="mt-0.5 max-h-48 overflow-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-3">{text.slice(0, 4000)}</pre> : null}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="text-[12.5px] text-ink-3">No steps recorded.</p>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
