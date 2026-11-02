"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, LayoutTemplate, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { changeAgentStatus, updateAgent } from "@/app/a/_actions/agents";
import { SaveBlueprintDialog } from "./agent-dialogs";

const APPROVALS = [
  { id: "send_external_email", label: "Sending email outside the company" },
  { id: "send_sms", label: "Sending text messages" },
  { id: "spend_money", label: "Spending money or placing orders" },
  { id: "post_publicly", label: "Posting publicly" },
  { id: "delete_data", label: "Deleting records" },
];

type Agent = { id: string; name: string; role: string; summary: string | null; instructions: string; status: string; config: { voice?: string; requireApprovalFor?: string[] } };

export function AgentSettings({ agency, agent, canAdmin }: { agency: string; agent: Agent; canAdmin: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: agent.name,
    role: agent.role,
    summary: agent.summary ?? "",
    instructions: agent.instructions,
    voice: agent.config.voice ?? "",
    requireApprovalFor: agent.config.requireApprovalFor ?? [],
  });
  const [pending, start] = useTransition();
  const [statusPending, startStatus] = useTransition();
  const [bpOpen, setBpOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const custom = form.requireApprovalFor.filter((a) => !APPROVALS.some((x) => x.id === a));
  const paused = agent.status === "paused";

  const status = (s: "active" | "paused" | "archived") =>
    startStatus(async () => {
      const r = await changeAgentStatus(agency, agent.id, s);
      if (!r.ok) return void toast.error(r.error);
      toast.success(s === "archived" ? `${agent.name} archived` : s === "paused" ? `${agent.name} is paused` : `${agent.name} is back at work`);
      if (s === "archived") router.push(`/a/${agency}/agents`);
    });

  return (
    <div className="max-w-[720px] space-y-12">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await updateAgent(agency, agent.id, form);
            if (r.ok) toast.success("Saved");
            else toast.error(r.error);
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name">
            <Input id="name" value={form.name} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </Field>
          <Field label="Role" htmlFor="role">
            <Input id="role" value={form.role} maxLength={80} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} />
          </Field>
        </div>
        <Field label="Summary" htmlFor="summary" hint="One line the client sees in their portal.">
          <Input id="summary" value={form.summary} maxLength={280} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} />
        </Field>
        <Field label="Instructions" htmlFor="instructions" hint="The job description the agent follows on every run.">
          <Textarea id="instructions" value={form.instructions} onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))} className="min-h-64 font-mono text-[12.5px]" />
        </Field>
        <Field label="Voice" htmlFor="voice">
          <Input id="voice" value={form.voice} maxLength={400} onChange={(e) => setForm((f) => ({ ...f, voice: e.target.value }))} placeholder="Warm, concise, and specific. Leads with the result." />
        </Field>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-ink-2">Ask for approval before</legend>
          <p className="mb-3 text-[12.5px] text-ink-3">These actions wait in the client’s portal until someone approves.</p>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {[...APPROVALS, ...custom.map((c) => ({ id: c, label: c.replace(/_/g, " ") }))].map((a) => {
              const on = form.requireApprovalFor.includes(a.id);
              return (
                <li key={a.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <label htmlFor={`ap-${a.id}`} className="text-[13.5px] text-ink-2">
                    {a.label}
                  </label>
                  <Switch
                    id={`ap-${a.id}`}
                    checked={on}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, requireApprovalFor: v ? [...f.requireApprovalFor, a.id] : f.requireApprovalFor.filter((x) => x !== a.id) }))}
                  />
                </li>
              );
            })}
          </ul>
        </fieldset>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>

      <section className="space-y-3">
        <h2 className="text-[13.5px] font-semibold text-ink">Lifecycle</h2>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          <Row title="Save as blueprint" body="Reuse this job, workflows and voice for another client." action={<Button size="sm" onClick={() => setBpOpen(true)}><LayoutTemplate /> Save</Button>} />
          {agent.status === "active" || paused ? (
            <Row
              title={paused ? "Resume" : "Pause"}
              body={paused ? "Workflows start running on schedule again." : "Stops scheduled workflows and replies. Nothing is deleted."}
              action={
                <Button size="sm" disabled={statusPending} onClick={() => status(paused ? "active" : "paused")}>
                  {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
                </Button>
              }
            />
          ) : null}
          {canAdmin ? (
            <Row
              title="Archive"
              body="Retires the agent and frees its inbox. Deliverables stay in the client’s history."
              action={
                <Button size="sm" variant="ghost" className="text-bad hover:text-bad" onClick={() => setArchiveOpen(true)}>
                  <Archive /> Archive
                </Button>
              }
            />
          ) : null}
        </div>
      </section>

      <SaveBlueprintDialog open={bpOpen} onOpenChange={setBpOpen} agency={agency} agentId={agent.id} defaultName={`${agent.role}`} />
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent title={`Archive ${agent.name}?`} description="Scheduled work stops immediately. You can save it as a blueprint first to reuse it.">
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={statusPending} onClick={() => status("archived")}>
              Archive {agent.name}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium text-ink">{title}</p>
        <p className="text-[12.5px] text-ink-3">{body}</p>
      </div>
      {action}
    </div>
  );
}
