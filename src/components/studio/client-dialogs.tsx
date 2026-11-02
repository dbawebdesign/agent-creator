"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { createClient, inviteClientOwner, setClientPlan } from "@/app/a/_actions/org";

export function NewClientButton({ agency, plans }: { agency: string; plans: { id: string; name: string; price: string }[] }) {
  const sp = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [form, setForm] = useState({ name: "", industry: "", website: "", planId: plans[0]?.id ?? "" });
  useEffect(() => {
    if (sp.get("new") === "1") setOpen(true);
  }, [sp]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o && sp.get("new")) router.replace(`/a/${agency}/clients`, { scroll: false });
      }}
    >
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus /> New client
      </Button>
      <DialogContent title="Add a client" description="A business you’ll staff with AI employees. They get their own white-labeled portal.">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await createClient(agency, form);
              if (!r.ok) return void toast.error(r.error);
              toast.success(`${form.name} added`);
              setOpen(false);
              router.push(`/a/${agency}/clients/${r.slug}`);
            });
          }}
        >
          <Field label="Business name" htmlFor="c-name">
            <Input id="c-name" required autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Brandlord" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Industry" htmlFor="c-ind">
              <Input id="c-ind" value={form.industry} onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))} placeholder="Promotional products" />
            </Field>
            <Field label="Website" htmlFor="c-web">
              <Input id="c-web" value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} placeholder="brandlord.co" />
            </Field>
          </div>
          <Field label="Plan" htmlFor="c-plan">
            <Select id="c-plan" value={form.planId} onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value }))}>
              <option value="">No plan yet</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.price}/mo
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || form.name.trim().length < 2}>
              {pending ? "Adding…" : "Add client"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function InviteOwner({ agency, clientId, clientName }: { agency: string; clientId: string; clientName: string }) {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await inviteClientOwner(agency, clientId, email);
            if (!r.ok) return void toast.error(r.error);
            toast.success(`Invitation created for ${email}`);
            setLink(r.link);
            setEmail("");
          });
        }}
      >
        <Input type="email" required placeholder={`owner@${clientName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`} value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Owner email" />
        <Button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </form>
      {link ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-line-strong bg-canvas px-3 py-2 animate-fade-in">
          <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3">{link}</p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:text-ink"
            aria-label="Copy invite link"
          >
            {copied ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Plan control for a client. Changing plan is an explicit choice plus Save; cancelling is a separate, confirmed,
 * destructive action — never a side effect of a select.
 */
export function PlanSelect({
  agency,
  clientId,
  current,
  plans,
  clientName = "this client",
}: {
  agency: string;
  clientId: string;
  current: string | null;
  plans: { id: string; name: string; price: string }[];
  clientName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [choice, setChoice] = useState(current ?? plans[0]?.id ?? "");
  const [pending, start] = useTransition();
  const router = useRouter();
  const save = (planId: string | null, done: () => void) =>
    start(async () => {
      const r = await setClientPlan(agency, clientId, planId);
      if (r.ok) {
        toast.success(planId ? "Plan updated" : "Subscription canceled");
        done();
        router.refresh();
      } else toast.error(r.error);
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog open={open} onOpenChange={(o) => (setOpen(o), o && setChoice(current ?? plans[0]?.id ?? ""))}>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={!plans.length}>
          {current ? "Change plan" : "Choose a plan"}
        </Button>
        <DialogContent title={current ? "Change plan" : "Choose a plan"} description={`Billing for ${clientName} switches at the next invoice.`}>
          <fieldset className="space-y-2">
            <legend className="sr-only">Plan</legend>
            {plans.map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3.5 py-3 transition-colors hover:bg-surface-2/50 has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-accent/20"
              >
                <input type="radio" name="plan" value={p.id} checked={choice === p.id} onChange={() => setChoice(p.id)} className="accent-[var(--accent)]" />
                <span className="flex-1 text-[13.5px] font-medium text-ink">{p.name}</span>
                <span className="tabular text-[13px] text-ink-3">{p.price}/mo</span>
                {p.id === current ? <span className="text-[11.5px] font-medium text-ink-3">Current</span> : null}
              </label>
            ))}
          </fieldset>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending || !choice || choice === current} onClick={() => save(choice, () => setOpen(false))}>
              {pending ? "Saving…" : "Save plan"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {current ? (
        <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <Button variant="ghost" size="sm" className="text-bad hover:bg-bad-soft hover:text-bad" onClick={() => setCancelOpen(true)}>
            Cancel subscription
          </Button>
          <DialogContent title="Cancel this subscription?" description={`${clientName} stops being billed. Their agents keep running until you pause them.`}>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelOpen(false)}>
                Keep it
              </Button>
              <Button variant="danger" disabled={pending} onClick={() => save(null, () => setCancelOpen(false))}>
                {pending ? "Canceling…" : "Cancel subscription"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
