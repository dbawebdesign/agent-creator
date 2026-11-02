"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CalendarClock, ChevronDown, Inbox, Play, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { RelativeTime } from "@/components/shared/relative-time";
import { cn } from "@/lib/utils";
import { runNow, toggleWorkflow, updateWorkflow } from "@/app/a/_actions/agents";
import { CHANNEL_LABEL, OUTPUT_LABEL } from "./bits";
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

export function WorkflowManager({ agency, agentId, workflows, canEdit }: { agency: string; agentId: string; workflows: W[]; canEdit: boolean }) {
  return (
    <div className="space-y-3">
      {workflows.map((w) => (
        <WorkflowRow key={w.id} agency={agency} agentId={agentId} w={w} canEdit={canEdit} />
      ))}
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
      <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{w.name}</p>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-3">
            {describeTrigger(w.trigger)} · {OUTPUT_LABEL[w.outputKind] ?? w.outputKind} → {w.deliverTo.map((c) => CHANNEL_LABEL[c] ?? c).join(", ")}
            {enabled && w.nextRunAt ? (
              <>
                {" · next "}
                <RelativeTime date={w.nextRunAt} />
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canEdit ? (
            <>
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
                <Play className="!size-3.5" /> <span className="max-sm:hidden">{running ? "Starting…" : "Run now"}</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
                <span className="max-sm:hidden">Edit</span>
                <ChevronDown className={cn("!size-3.5 transition-transform", editing && "rotate-180")} />
              </Button>
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
                className="ml-1.5"
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
              <div className="flex flex-wrap gap-1.5">
                {CHANNELS.map((c) => {
                  const on = form.deliverTo.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setForm((f) => ({ ...f, deliverTo: on ? (f.deliverTo.length > 1 ? f.deliverTo.filter((x) => x !== c) : f.deliverTo) : [...f.deliverTo, c] }))}
                      className={cn("h-7 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors", on ? "border-ink bg-ink text-canvas" : "border-line text-ink-3 hover:text-ink")}
                    >
                      {CHANNEL_LABEL[c]}
                    </button>
                  );
                })}
              </div>
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
