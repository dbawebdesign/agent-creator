"use client";

import { useMemo, useState } from "react";
import { Popover as P } from "radix-ui";
import { CalendarClock, Check, ChevronDown, Clock, HelpCircle, Inbox, Library, Loader2, Repeat, Sparkles, Zap } from "lucide-react";
import type { AgentSpec, WorkflowSpec } from "@/server/agents/spec";
import { AgentOrb } from "@/components/ui/agent-orb";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, OUTPUT_LABEL } from "../bits";
import { buildCron, DAY_NAMES, describeTrigger, parseCadence, type Cadence } from "../cron";

export type DraftWorkflow = WorkflowSpec & { _id: string; _on: boolean };
export type Draft = Omit<AgentSpec, "workflows"> & { workflows: DraftWorkflow[] };

const CHANNELS = ["portal", "email", "slack", "sms", "api", "mcp"] as const;

export function toDraft(spec: AgentSpec): Draft {
  return { ...spec, workflows: spec.workflows.map((w, i) => ({ ...w, _id: `w${i}`, _on: true })) };
}

export function fromDraft(d: Draft): AgentSpec {
  const workflows = d.workflows.filter((w) => w._on).map(({ _id, _on, ...w }) => w);
  return { ...d, workflows, weeklyHoursSaved: estimateWeekly(d) };
}

function runsPerWeek(t: WorkflowSpec["trigger"]): number {
  if (t.type === "manual") return 1;
  if (t.type === "event") return 5;
  const c = parseCadence(t.cron).cadence;
  return { hourly: 50, daily: 7, weekdays: 5, weekly: 1, monthly: 0.25, custom: 1 }[c];
}

/** Scale the Architect's own weekly estimate by what's still switched on. */
export function estimateWeekly(d: Draft): number {
  const all = d.workflows.reduce((s, w) => s + runsPerWeek(w.trigger) * w.hoursSavedPerRun, 0);
  const on = d.workflows.filter((w) => w._on).reduce((s, w) => s + runsPerWeek(w.trigger) * w.hoursSavedPerRun, 0);
  if (!all) return d.weeklyHoursSaved;
  const base = d.weeklyHoursSaved > 0 ? d.weeklyHoursSaved * (on / all) : on;
  return Math.round(base * 10) / 10;
}

export function ProposalReview({
  draft,
  setDraft,
  clientName,
  onHire,
  hiring,
  onStartOver,
  priceLabel,
}: {
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
  clientName: string;
  onHire: () => void;
  hiring: boolean;
  onStartOver: () => void;
  priceLabel: string | null;
}) {
  const weekly = useMemo(() => estimateWeekly(draft), [draft]);
  const onCount = draft.workflows.filter((w) => w._on).length;
  const channels = useMemo(() => [...new Set(draft.workflows.filter((w) => w._on).flatMap((w) => w.deliverTo))], [draft.workflows]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setWf = (id: string, patch: Partial<DraftWorkflow>) =>
    setDraft((d) => ({ ...d, workflows: d.workflows.map((w) => (w._id === id ? { ...w, ...patch } : w)) }));
  const seed = `${draft.name}-${clientName}`;
  const firstName = draft.name || "your agent";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 animate-fade-in lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        {/* Identity */}
        <div className="flex items-start gap-4">
          <AgentOrb seed={seed} name={draft.name} size={52} className="mt-1" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-accent">Proposed for {clientName}</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="relative -ml-1 inline-grid max-w-full">
                <span aria-hidden className="invisible col-start-1 row-start-1 px-1 text-[26px] font-semibold tracking-[-0.025em] whitespace-pre">
                  {draft.name || "Name"}
                </span>
                <input
                  aria-label="Agent name"
                  size={1}
                  value={draft.name}
                  maxLength={40}
                  placeholder="Name"
                  onChange={(e) => set("name", e.target.value)}
                  className="col-start-1 row-start-1 w-full min-w-0 rounded-md bg-transparent px-1 text-[26px] font-semibold tracking-[-0.025em] text-ink hover:bg-surface-2/60 focus:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                />
              </span>
              <span className="text-[26px] font-light text-ink-4 max-sm:hidden">·</span>
              <input
                aria-label="Role"
                value={draft.role}
                maxLength={80}
                onChange={(e) => set("role", e.target.value)}
                className="min-w-0 flex-1 rounded-md bg-transparent text-[20px] font-medium max-sm:basis-full tracking-[-0.015em] text-ink-2 hover:bg-surface-2/60 focus:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
              />
            </div>
            <textarea
              aria-label="Summary"
              value={draft.summary}
              maxLength={280}
              rows={2}
              onChange={(e) => set("summary", e.target.value)}
              className="mt-2 w-full resize-none rounded-md bg-transparent text-[14.5px] leading-relaxed text-ink-3 [field-sizing:content] hover:bg-surface-2/60 focus:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            />
            {/* How this draft was made (e.g. offline, no AI model). Agency-only; never copied into client-facing questions. */}
            {draft.draftNote ? <p className="mt-1 text-[12.5px] text-ink-4">{draft.draftNote}</p> : null}
          </div>
        </div>

        {/* Workflows */}
        <section className="mt-10" aria-labelledby="wf-h">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="wf-h" className="text-[14px] font-semibold text-ink">
              What {firstName} will do <span className="ml-1 font-normal text-ink-4 tabular">{onCount} of {draft.workflows.length}</span>
            </h2>
            <span className="text-[12.5px] text-ink-3 max-sm:hidden">Switch off anything you don’t want yet</span>
          </div>
          <div className="space-y-3">
            {draft.workflows.map((w, i) => (
              <WorkflowCard
                key={w._id}
                w={w}
                onChange={(p) => setWf(w._id, p)}
                canDisable={onCount > 1 || !w._on}
                repeatProblem={!!w.problem && draft.workflows.slice(0, i).some((x) => x.problem.trim() === w.problem.trim())}
              />
            ))}
          </div>
        </section>

        {/* First deliverable */}
        <section className="mt-10">
          <h2 className="mb-3 text-[14px] font-semibold text-ink">First overnight deliverable</h2>
          <div className="relative overflow-hidden rounded-xl border border-accent/25 bg-accent-soft/60 p-5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-accent shadow-xs">
                <Sparkles className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <input
                  aria-label="First deliverable title"
                  value={draft.firstDeliverable.title}
                  onChange={(e) => set("firstDeliverable", { ...draft.firstDeliverable, title: e.target.value })}
                  className="w-full rounded bg-transparent text-[15px] font-semibold text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                />
                <textarea
                  aria-label="First deliverable description"
                  value={draft.firstDeliverable.description}
                  rows={2}
                  onChange={(e) => set("firstDeliverable", { ...draft.firstDeliverable, description: e.target.value })}
                  className="mt-1 w-full resize-none rounded bg-transparent text-[13.5px] leading-relaxed text-ink-2 [field-sizing:content] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                />
                <p className="mt-2 text-[12.5px] text-ink-3">Lands in {clientName}’s portal tomorrow morning — the moment they see it working.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Knowledge + questions */}
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-ink">
              <Library className="size-4 text-ink-3" aria-hidden /> Knowledge to request
            </h2>
            {draft.knowledgeNeeds.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                {draft.knowledgeNeeds.map((k, i) => (
                  <li key={i} className="px-4 py-3">
                    <p className="text-[13.5px] font-medium text-ink">{k.title}</p>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{k.why}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-3">Nothing extra — the call covered it.</p>
            )}
          </section>
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-ink">
              <HelpCircle className="size-4 text-ink-3" aria-hidden /> Confirm with {clientName.split(/\s+/)[0]}
            </h2>
            {draft.openQuestions.length ? (
              <ol className="space-y-2.5">
                {draft.openQuestions.map((q, i) => (
                  <li key={i} className="flex gap-3 text-[13.5px] leading-relaxed text-ink-2">
                    <span className="tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-ink-3">{i + 1}</span>
                    {q}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-ink-3">No open questions.</p>
            )}
          </section>
        </div>

        {draft.resaleIdea ? (
          <section className="mt-10">
            <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-ink">
              <Repeat className="size-4 text-ink-3" aria-hidden /> Resale idea
            </h2>
            <p className="max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">{draft.resaleIdea}</p>
          </section>
        ) : null}

        <details className="group mt-10 rounded-lg border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[13.5px] font-medium text-ink [&::-webkit-details-marker]:hidden">
            Job description, voice and approvals
            <ChevronDown className="size-4 text-ink-4 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="space-y-4 border-t border-line px-4 py-4">
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Instructions</span>
              <Textarea value={draft.instructions} onChange={(e) => set("instructions", e.target.value)} className="min-h-48 font-mono text-[12.5px]" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Voice</span>
              <Input value={draft.voice} onChange={(e) => set("voice", e.target.value)} />
            </label>
            <div>
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Waits for approval before</span>
              <div className="flex flex-wrap gap-1.5">
                {draft.requireApprovalFor.length ? (
                  draft.requireApprovalFor.map((a) => (
                    <span key={a} className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[12px] text-ink-2">
                      {a.replace(/_/g, " ")}
                    </span>
                  ))
                ) : (
                  <span className="text-[12.5px] text-ink-3">Nothing — fully autonomous</span>
                )}
              </div>
            </div>
            {draft.seedMemories.length ? (
              <div>
                <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Remembers from the call</span>
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-2">
                  {draft.seedMemories.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>

        <div className="mt-8 pb-4 max-lg:pb-24">
          <button type="button" onClick={onStartOver} className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
            Start over with a different call
          </button>
        </div>
      </div>

      {/* Mobile hire bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 border-t border-line bg-canvas px-4 py-3 shadow-[0_-4px_16px_rgb(0_0_0/0.06)] lg:hidden">
        <div className="min-w-0 flex-1">
          <p className="tabular text-[15px] font-semibold text-ink">{weekly} h / week</p>
          <p className="truncate text-[12px] text-ink-3">{onCount} workflow{onCount === 1 ? "" : "s"} · {priceLabel ?? "flat rate"}</p>
        </div>
        <Button variant="primary" size="lg" onClick={onHire} disabled={hiring || !draft.name.trim()}>
          {hiring ? <Loader2 className="animate-spin" /> : null}
          Hire {draft.name || "agent"}
        </Button>
      </div>

      {/* Summary rail */}
      <aside className="max-lg:hidden lg:sticky lg:top-8 lg:self-start">
        <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
          <div className="text-[12.5px] text-ink-3">Saves about</div>
          <div className="tabular mt-0.5 text-[34px] font-semibold leading-none tracking-[-0.03em] text-ink">
            {weekly}
            <span className="ml-1 text-[15px] font-medium tracking-normal text-ink-3">hours / week</span>
          </div>
          <dl className="mt-5 space-y-2.5 border-t border-line pt-4 text-[13px]">
            <Row label="Workflows">{onCount} on</Row>
            <Row label="Delivers to">{channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") || "Portal"}</Row>
            <Row label="Approvals">{draft.requireApprovalFor.length ? `${draft.requireApprovalFor.length} rule${draft.requireApprovalFor.length > 1 ? "s" : ""}` : "None"}</Row>
            {priceLabel ? <Row label="Price">{priceLabel}</Row> : null}
          </dl>
          <Button variant="primary" size="lg" className="mt-5 w-full" onClick={onHire} disabled={hiring || !draft.name.trim()}>
            {hiring ? <Loader2 className="animate-spin" /> : null}
            Hire {draft.name || "agent"}
          </Button>
          <p className="mt-3 text-center text-[12px] leading-relaxed text-ink-3">
            Sets up memory, knowledge, an inbox, a computer and channels. Live in under a minute.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-3">{label}</dt>
      <dd className="truncate text-right font-medium text-ink-2">{children}</dd>
    </div>
  );
}

function WorkflowCard({ w, onChange, canDisable, repeatProblem }: { w: DraftWorkflow; onChange: (p: Partial<DraftWorkflow>) => void; canDisable: boolean; repeatProblem?: boolean }) {
  const [open, setOpen] = useState(false);
  const TriggerIcon = w.trigger.type === "schedule" ? CalendarClock : w.trigger.type === "event" ? Inbox : Zap;
  return (
    <article className={cn("rounded-xl border bg-surface shadow-xs transition-all duration-200", w._on ? "border-line" : "border-dashed border-line bg-transparent opacity-60")}>
      <div className="flex items-start gap-4 p-4 sm:p-5">
        <div className="min-w-0 flex-1">
          <input
            aria-label="Workflow name"
            value={w.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="w-full rounded bg-transparent text-[15px] font-semibold tracking-[-0.01em] text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          />
          {w.problem && !repeatProblem ? <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">{w.problem}</p> : null}

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <SchedulePicker w={w} onChange={onChange} icon={<TriggerIcon className="size-3.5" aria-hidden />} />
            <label className="relative">
              <span className="sr-only">Output</span>
              <select
                value={w.outputKind}
                onChange={(e) => onChange({ outputKind: e.target.value as WorkflowSpec["outputKind"] })}
                className="h-7 appearance-none rounded-full border border-line bg-surface-2/60 pr-6 pl-2.5 text-[12.5px] font-medium text-ink-2 hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
              >
                {Object.entries(OUTPUT_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-ink-4" aria-hidden />
            </label>
            <label className="flex h-7 items-center gap-1 rounded-full border border-line bg-surface-2/60 px-2.5 text-[12.5px] font-medium text-ink-2">
              <Clock className="size-3.5 text-ink-4" aria-hidden />
              <input
                type="number"
                min={0}
                max={200}
                step={0.25}
                value={w.hoursSavedPerRun}
                onChange={(e) => onChange({ hoursSavedPerRun: Math.max(0, Number(e.target.value) || 0) })}
                className="tabular w-[4.5ch] bg-transparent text-right focus:outline-none"
                aria-label="Hours saved per run"
              />
              h saved / run
            </label>
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            <span className="text-[12px] text-ink-3">Delivers to</span>
            <Menu>
              <MenuTrigger className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 data-[state=open]:bg-surface-2" aria-label={`Delivery channels: ${w.deliverTo.map((c) => CHANNEL_LABEL[c] ?? c).join(", ")}`}>
                {w.deliverTo.map((c) => CHANNEL_LABEL[c] ?? c).join(", ")}
                <ChevronDown className="size-3 text-ink-3" aria-hidden />
              </MenuTrigger>
              <MenuContent className="w-48">
                {CHANNELS.map((c) => {
                  const on = w.deliverTo.includes(c);
                  return (
                    <MenuItem
                      key={c}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      onSelect={(e) => {
                        e.preventDefault();
                        const next = on ? w.deliverTo.filter((x) => x !== c) : CHANNELS.filter((x) => x === c || w.deliverTo.includes(x));
                        if (next.length) onChange({ deliverTo: next });
                      }}
                    >
                      <span className="flex-1">{CHANNEL_LABEL[c]}</span>
                      {on ? <Check className="text-accent" /> : null}
                    </MenuItem>
                  );
                })}
              </MenuContent>
            </Menu>
          </div>

          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-3 hover:text-ink" aria-expanded={open}>
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
            {open ? "Hide procedure" : "Procedure"}
          </button>
          {open ? (
            <Textarea
              value={w.instructions}
              onChange={(e) => onChange({ instructions: e.target.value })}
              className="mt-2 min-h-32 text-[13px] animate-fade-in"
              aria-label="Procedure"
            />
          ) : null}
        </div>
        <Switch checked={w._on} onCheckedChange={(v) => (v || canDisable) && onChange({ _on: v })} aria-label={w._on ? `Turn off ${w.name}` : `Turn on ${w.name}`} className="mt-1" />
      </div>
    </article>
  );
}

function SchedulePicker({ w, onChange, icon }: { w: DraftWorkflow; onChange: (p: Partial<DraftWorkflow>) => void; icon: React.ReactNode }) {
  const label = describeTrigger(w.trigger);
  if (w.trigger.type !== "schedule") {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-2/60 px-2.5 text-[12.5px] font-medium text-ink-2">
        <span className="text-ink-4">{icon}</span>
        {label}
      </span>
    );
  }
  const cron = w.trigger.cron;
  const parsed = parseCadence(cron);
  const update = (cadence: Cadence, time: string, day: number) => {
    if (cadence === "custom") return;
    onChange({ trigger: { type: "schedule", cron: buildCron(cadence, time, day) } });
  };
  return (
    <P.Root>
      <P.Trigger className="inline-flex h-7 items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 text-[12.5px] font-medium text-accent transition-colors hover:border-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
        {icon}
        {label}
        <ChevronDown className="size-3 opacity-60" aria-hidden />
      </P.Trigger>
      <P.Portal>
        <P.Content sideOffset={6} align="start" className="z-50 w-72 rounded-lg border border-line bg-raised p-3 shadow-md animate-fade-in">
          <p className="mb-2 text-[12px] font-medium text-ink-3">Runs</p>
          <div className="grid grid-cols-2 gap-2">
            <Select value={parsed.cadence} onChange={(e) => update(e.target.value as Cadence, parsed.time, parsed.day)} aria-label="Cadence" className="h-8 text-[13px]">
              <option value="weekdays">Weekdays</option>
              <option value="daily">Every day</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="hourly">Hourly</option>
              {parsed.cadence === "custom" ? <option value="custom">Custom</option> : null}
            </Select>
            <Input type="time" value={parsed.time} onChange={(e) => update(parsed.cadence, e.target.value, parsed.day)} aria-label="Time" className="h-8 text-[13px]" disabled={parsed.cadence === "hourly"} />
          </div>
          {parsed.cadence === "weekly" ? (
            <Select value={parsed.day} onChange={(e) => update("weekly", parsed.time, Number(e.target.value))} aria-label="Day of week" className="mt-2 h-8 text-[13px]">
              {DAY_NAMES.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          ) : null}
          {parsed.cadence === "monthly" ? (
            <Select value={parsed.day} onChange={(e) => update("monthly", parsed.time, Number(e.target.value))} aria-label="Day of month" className="mt-2 h-8 text-[13px]">
              {Array.from({ length: 28 }, (_, i) => (
                <option key={i} value={i + 1}>
                  Day {i + 1}
                </option>
              ))}
            </Select>
          ) : null}
          <p className="mt-2.5 font-mono text-[11px] text-ink-3">{cron} · client’s time zone</p>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
