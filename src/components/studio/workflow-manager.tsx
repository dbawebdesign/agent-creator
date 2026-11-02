"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CalendarClock, ChevronDown, Inbox, Play, Plus, Workflow, Zap } from "lucide-react";
import type { WorkflowSpec } from "@/server/agents/spec";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { RelativeTime } from "@/components/shared/relative-time";
import { cn } from "@/lib/utils";
import { createWorkflow, runNow, toggleWorkflow, updateWorkflow } from "@/app/a/_actions/agents";
import { EmptyState } from "@/components/ui/empty";
import { CHANNEL_LABEL, OUTPUT_LABEL } from "./bits";
import { SchedulePicker } from "./new-agent/proposal";
import { buildCron, DAY_NAMES, describeTrigger, parseCadence, type Cadence } from "./cron";

type W = {
  id: string;
  name: string;
  instructions: string;
  trigger: { type: "schedule"; cron: string; timezone?: string } | { type: "event"; event: string } | { type: "manual" };
  outputKind: string;
  deliverTo: string[];
  hoursSavedPerRun: number;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
};

const CHANNELS = ["portal", "email", "slack", "sms", "api", "mcp"] as const;

export function WorkflowManager({
  agency,
  agentId,
  agentName,
  workflows,
  canEdit,
  defaultDelivery = ["portal"],
}: {
  agency: string;
  agentId: string;
  agentName: string;
  workflows: W[];
  canEdit: boolean;
  defaultDelivery?: string[];
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      {workflows.map((w) => (
        <WorkflowRow key={w.id} agency={agency} agentId={agentId} w={w} canEdit={canEdit} />
      ))}
      {!workflows.length && !adding ? (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState
            icon={<Workflow />}
            title="No workflows"
            body={`Add something ${agentName} should do on a schedule, when a message arrives, or when asked.`}
            action={
              canEdit ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus /> Add workflow
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : null}
      {canEdit && adding ? (
        <NewWorkflowForm agency={agency} agentId={agentId} defaultDelivery={defaultDelivery} onDone={() => setAdding(false)} />
      ) : null}
      {canEdit && workflows.length && !adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line px-4 py-3.5 text-[13.5px] font-medium text-ink-3 transition-colors hover:border-line-strong hover:text-ink focus:outline-none focus-visible:ring-3 focus-visible:ring-accent/15"
        >
          <Plus className="size-4" aria-hidden /> Add workflow
        </button>
      ) : null}
    </div>
  );
}

type TriggerKind = "schedule" | WorkflowEvent | "manual";
type WorkflowEvent = Extract<WorkflowSpec["trigger"], { type: "event" }>["event"];
const TRIGGER_OPTIONS: { value: TriggerKind; label: string }[] = [
  { value: "schedule", label: "On a schedule" },
  { value: "email.received", label: "When an email arrives" },
  { value: "sms.received", label: "When a text arrives" },
  { value: "slack.message", label: "When someone messages in Slack" },
  { value: "deliverable.approved", label: "When a deliverable is approved" },
  { value: "webhook", label: "When a webhook fires" },
  { value: "manual", label: "Only when asked" },
];
const OUTPUT_KINDS = ["report", "document", "table", "email_draft", "message", "action"] as const;

function NewWorkflowForm({ agency, agentId, defaultDelivery, onDone }: { agency: string; agentId: string; defaultDelivery: string[]; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<TriggerKind>("schedule");
  const [cron, setCron] = useState("0 8 * * 1-5");
  const [outputKind, setOutputKind] = useState<(typeof OUTPUT_KINDS)[number]>("report");
  const [deliverTo, setDeliverTo] = useState<string[]>(defaultDelivery.filter((c) => (CHANNELS as readonly string[]).includes(c)).length ? defaultDelivery : ["portal"]);
  const [hours, setHours] = useState(1);
  const trigger: WorkflowSpec["trigger"] = kind === "schedule" ? { type: "schedule", cron } : kind === "manual" ? { type: "manual" } : { type: "event", event: kind };
  return (
    <form
      className="space-y-4 rounded-xl border border-line bg-surface px-4 py-5 shadow-xs animate-fade-in sm:px-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createWorkflow(agency, agentId, {
            name,
            instructions,
            trigger,
            outputKind,
            deliverTo: deliverTo as (typeof CHANNELS)[number][],
            hoursSavedPerRun: hours,
          });
          if (r.ok) {
            toast.success(`${name.trim()} added`, { description: kind === "schedule" ? `Runs ${describeTrigger(trigger).toLowerCase()}.` : undefined });
            onDone();
          } else toast.error(r.error);
        });
      }}
    >
      <p className="text-[14px] font-medium text-ink">New workflow</p>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monday pipeline summary" maxLength={80} required autoFocus />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Runs</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value as TriggerKind)} className="w-64" aria-label="Trigger">
            {TRIGGER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        {kind === "schedule" ? (
          <div className="pb-1.5">
            <SchedulePicker trigger={trigger} onChange={(t) => t.type === "schedule" && setCron(t.cron)} icon={<CalendarClock className="size-3.5" aria-hidden />} />
          </div>
        ) : null}
      </div>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Procedure</span>
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Step by step: what to look at, what to produce, and what good looks like."
          className="min-h-32 text-[13px]"
          maxLength={6000}
          required
        />
      </label>
      <div className="flex flex-wrap items-start gap-6">
        <label>
          <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Produces</span>
          <Select value={outputKind} onChange={(e) => setOutputKind(e.target.value as (typeof OUTPUT_KINDS)[number])} className="w-40" aria-label="Output">
            {OUTPUT_KINDS.map((k) => (
              <option key={k} value={k}>
                {OUTPUT_LABEL[k]}
              </option>
            ))}
          </Select>
        </label>
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Delivers to</span>
          <ChannelToggles value={deliverTo} onChange={setDeliverTo} />
        </div>
        <label>
          <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Hours saved per run</span>
          <Input type="number" min={0} max={200} step={0.25} value={hours} onChange={(e) => setHours(Number(e.target.value) || 0)} className="tabular w-28" />
        </label>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Adding…" : "Add workflow"}
        </Button>
      </div>
    </form>
  );
}

function ChannelToggles({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CHANNELS.map((c) => {
        const on = value.includes(c);
        return (
          <button
            key={c}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? (value.length > 1 ? value.filter((x) => x !== c) : value) : [...value, c])}
            className={cn("h-7 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors", on ? "border-ink bg-ink text-canvas" : "border-line text-ink-3 hover:text-ink")}
          >
            {CHANNEL_LABEL[c]}
          </button>
        );
      })}
    </div>
  );
}

function WorkflowRow({ agency, agentId, w, canEdit }: { agency: string; agentId: string; w: W; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(w.enabled);
  const [pending, start] = useTransition();
  const [running, startRun] = useTransition();
  const [form, setForm] = useState({
    name: w.name,
    instructions: w.instructions,
    cron: w.trigger.type === "schedule" ? w.trigger.cron : "",
    deliverTo: w.deliverTo,
    hoursSavedPerRun: w.hoursSavedPerRun,
  });
  const Icon = w.trigger.type === "schedule" ? CalendarClock : w.trigger.type === "event" ? Inbox : Zap;
  const cad = parseCadence(form.cron || "0 9 * * *");

  const setCad = (c: Cadence, t: string, d: number) => c !== "custom" && setForm((f) => ({ ...f, cron: buildCron(c, t, d) }));

  return (
    <article className={cn("rounded-xl border border-line bg-surface shadow-xs transition-opacity", !enabled && !editing && "opacity-60")}>
      {/* Mobile: controls drop to their own row under the title so the name and schedule aren't truncated. */}
      <div className="group flex items-center gap-x-4 gap-y-3 px-4 py-4 max-sm:flex-wrap sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3 max-sm:self-start">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink sm:truncate">{w.name}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3 sm:truncate">
            {describeTrigger(w.trigger)} · {OUTPUT_LABEL[w.outputKind] ?? w.outputKind} → {w.deliverTo.map((c) => CHANNEL_LABEL[c] ?? c).join(", ")}
            {enabled && w.nextRunAt ? (
              <>
                {" · next "}
                <RelativeTime date={w.nextRunAt} />
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:pl-12">
          {canEdit ? (
            <>
              {/* Desktop: Run now / Edit appear on hover or keyboard focus; the switch always shows. Touch: always shown. */}
              <span
                className={cn(
                  "flex items-center gap-1.5 transition-opacity",
                  !editing && !running && "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100",
                )}
              >
              <Button
                size="sm"
                variant="secondary"
                disabled={running}
                onClick={() =>
                  startRun(async () => {
                    const r = await runNow(agency, agentId, w.id);
                    if (r.ok) toast.success(`${w.name} is running`, { description: "Follow it in Activity." });
                    else toast.error(r.error);
                  })
                }
                aria-label={`Run ${w.name} now`}
              >
                <Play className="!size-3.5" /> {running ? "Starting…" : "Run now"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
                Edit
                <ChevronDown className={cn("!size-3.5 transition-transform", editing && "rotate-180")} />
              </Button>
              </span>
              <Switch
                checked={enabled}
                disabled={pending}
                aria-label={enabled ? `Turn off ${w.name}` : `Turn on ${w.name}`}
                onCheckedChange={(v) => {
                  setEnabled(v);
                  start(async () => {
                    const r = await toggleWorkflow(agency, agentId, w.id, v);
                    if (!r.ok) {
                      setEnabled(!v);
                      toast.error(r.error);
                    } else toast.success(v ? `${w.name} is on` : `${w.name} is off`);
                  });
                }}
                className="ml-1.5 max-sm:ml-auto"
              />
            </>
          ) : null}
        </div>
      </div>
      {editing ? (
        <form
          className="space-y-4 border-t border-line px-4 py-5 animate-fade-in sm:px-5"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await updateWorkflow(agency, agentId, w.id, { ...form, cron: form.cron || undefined, deliverTo: form.deliverTo as (typeof CHANNELS)[number][], enabled });
              if (r.ok) {
                toast.success("Workflow saved");
                setEditing(false);
              } else toast.error(r.error);
            });
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Name</span>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          {w.trigger.type === "schedule" ? (
            <div>
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Schedule · {describeTrigger({ type: "schedule", cron: form.cron })}</span>
              <div className="flex flex-wrap gap-2">
                <Select value={cad.cadence} onChange={(e) => setCad(e.target.value as Cadence, cad.time, cad.day)} className="w-36" aria-label="Cadence">
                  <option value="weekdays">Weekdays</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="hourly">Hourly</option>
                  {cad.cadence === "custom" ? <option value="custom">Custom</option> : null}
                </Select>
                {cad.cadence === "weekly" ? (
                  <Select value={cad.day} onChange={(e) => setCad("weekly", cad.time, Number(e.target.value))} className="w-36" aria-label="Day">
                    {DAY_NAMES.map((d, i) => (
                      <option key={d} value={i}>{d}</option>
                    ))}
                  </Select>
                ) : null}
                {cad.cadence === "monthly" ? (
                  <Select value={cad.day} onChange={(e) => setCad("monthly", cad.time, Number(e.target.value))} className="w-28" aria-label="Day of month">
                    {Array.from({ length: 28 }, (_, i) => (
                      <option key={i} value={i + 1}>Day {i + 1}</option>
                    ))}
                  </Select>
                ) : null}
                <Input type="time" value={cad.time} disabled={cad.cadence === "hourly"} onChange={(e) => setCad(cad.cadence, e.target.value, cad.day)} className="w-32" aria-label="Time" />
                <Input value={form.cron} onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))} className="w-40 font-mono text-[12.5px]" aria-label="Cron expression" />
              </div>
            </div>
          ) : null}
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Procedure</span>
            <Textarea value={form.instructions} onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))} className="min-h-36 text-[13px]" />
          </label>
          <div className="flex flex-wrap items-end gap-6">
            <div>
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Delivers to</span>
              <ChannelToggles value={form.deliverTo} onChange={(deliverTo) => setForm((f) => ({ ...f, deliverTo }))} />
            </div>
            <label>
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-3">Hours saved per run</span>
              <Input type="number" min={0} max={200} step={0.25} value={form.hoursSavedPerRun} onChange={(e) => setForm((f) => ({ ...f, hoursSavedPerRun: Number(e.target.value) || 0 }))} className="tabular w-28" />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Saving…" : "Save workflow"}
            </Button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
