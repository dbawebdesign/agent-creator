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
import { APPROVAL_ACTIONS, DEFAULT_APPROVALS, type ApprovalAction } from "@/server/agents/spec";

/** Exactly the actions the runtime enforces (APPROVAL_ACTIONS), in plain words. */
const APPROVALS: { id: ApprovalAction; label: string; hint: string }[] = [
  { id: "send_external_email", label: "Emailing anyone outside the business", hint: "Drafts wait for a yes before they’re sent." },
  { id: "send_external_sms", label: "Sending text messages", hint: "Texts to customers or vendors." },
  { id: "send_external_slack", label: "Posting in Slack", hint: "Messages to shared or external channels." },
  { id: "write_client_system", label: "Changing records in the client’s systems", hint: "Clicking, typing or saving in their tools." },
  { id: "computer_bash", label: "Running commands on its computer", hint: "Shell commands on the cloud computer." },
];
const LEGACY: Record<string, ApprovalAction> = { send_email: "send_external_email", send_sms: "send_external_sms", send_text: "send_external_sms", send_slack: "send_external_slack" };
function initialApprovals(list: string[] | undefined): ApprovalAction[] {
  if (!list) return [...DEFAULT_APPROVALS];
  const set = new Set<ApprovalAction>();
  for (const raw of list) {
    const k = raw.trim().toLowerCase();
    if ((APPROVAL_ACTIONS as readonly string[]).includes(k)) set.add(k as ApprovalAction);
    else if (LEGACY[k]) set.add(LEGACY[k]);
  }
  return APPROVAL_ACTIONS.filter((a) => set.has(a));
}

type Agent = { id: string; name: string; role: string; summary: string | null; instructions: string; status: string; config: { voice?: string; requireApprovalFor?: string[] } };

export function AgentSettings({ agency, agent, canAdmin, children }: { agency: string; agent: Agent; canAdmin: boolean; children?: React.ReactNode }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: agent.name,
    role: agent.role,
    summary: agent.summary ?? "",
    instructions: agent.instructions,
    voice: agent.config.voice ?? "",
    requireApprovalFor: initialApprovals(agent.config.requireApprovalFor),
  });
  const [pending, start] = useTransition();
  const [statusPending, startStatus] = useTransition();
  const [bpOpen, setBpOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
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
            {APPROVALS.map((a) => {
              const on = form.requireApprovalFor.includes(a.id);
              return (
                <li key={a.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <label htmlFor={`ap-${a.id}`} className="min-w-0">
                    <span className="block text-[13.5px] text-ink-2">{a.label}</span>
                    <span className="block text-[12px] text-ink-3">{a.hint}</span>
                  </label>
                  <Switch
                    id={`ap-${a.id}`}
                    checked={on}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, requireApprovalFor: v ? APPROVAL_ACTIONS.filter((x) => x === a.id || f.requireApprovalFor.includes(x)) : f.requireApprovalFor.filter((x) => x !== a.id) }))}
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

      {/* Sections the page adds (channels) sit between the job and the lifecycle actions, so Archive stays last. */}
      {children}

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
