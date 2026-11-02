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

export function PlanSelect({ agency, clientId, current, plans }: { agency: string; clientId: string; current: string | null; plans: { id: string; name: string; price: string }[] }) {
  const [value, setValue] = useState(current ?? "");
  const [pending, start] = useTransition();
  return (
    <Select
      value={value}
      disabled={pending}
      aria-label="Plan"
      onChange={(e) => {
        const v = e.target.value;
        const prev = value;
        setValue(v);
        start(async () => {
          const r = await setClientPlan(agency, clientId, v || null);
          if (r.ok) toast.success(v ? "Plan updated" : "Subscription canceled");
          else {
            setValue(prev);
            toast.error(r.error);
          }
        });
      }}
    >
      <option value="">No plan</option>
      {plans.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} — {p.price}/mo
        </option>
      ))}
    </Select>
  );
}
