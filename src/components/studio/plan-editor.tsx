"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { savePlan, setPlanActive } from "@/app/a/_actions/org";

type Plan = { id: string; name: string; description: string | null; priceCents: number; setupFeeCents: number; features: string[]; active: boolean };

export function PlanDialog({ agency, plan, trigger }: { agency: string; plan?: Plan; trigger?: React.ReactNode }) {
  const sp = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [form, setForm] = useState({
    name: plan?.name ?? "",
    description: plan?.description ?? "",
    price: plan ? plan.priceCents / 100 : 5000,
    setupFee: plan ? plan.setupFeeCents / 100 : 0,
    features: (plan?.features ?? []).join("\n"),
  });
  useEffect(() => {
    if (!plan && sp.get("new") === "1") setOpen(true);
  }, [sp, plan]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o && sp.get("new")) router.replace(`/a/${agency}/billing`, { scroll: false });
      }}
    >
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus /> New plan
        </Button>
      )}
      <DialogContent title={plan ? "Edit plan" : "New plan"} description="Flat monthly pricing your clients understand. No token billing.">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await savePlan(agency, plan?.id ?? null, {
                name: form.name,
                description: form.description,
                price: Number(form.price),
                setupFee: Number(form.setupFee),
                features: form.features.split("\n").map((f) => f.trim()).filter(Boolean),
              });
              if (!r.ok) return void toast.error(r.error);
              toast.success(plan ? "Plan updated" : "Plan created");
              setOpen(false);
            });
          }}
        >
          <Field label="Name" htmlFor="p-name">
            <Input id="p-name" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="AI employee" autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Monthly price (USD)" htmlFor="p-price">
              <Input id="p-price" type="number" min={0} step={100} value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: Number(e.target.value) }))} className="tabular" />
            </Field>
            <Field label="Setup fee (USD)" htmlFor="p-setup">
              <Input id="p-setup" type="number" min={0} step={100} value={form.setupFee} onChange={(e) => setForm((f) => ({ ...f, setupFee: Number(e.target.value) }))} className="tabular" />
            </Field>
          </div>
          <Field label="Description" htmlFor="p-desc">
            <Input id="p-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="One full-time AI employee" />
          </Field>
          <Field label="Included" htmlFor="p-feat" hint="One per line.">
            <Textarea id="p-feat" value={form.features} onChange={(e) => setForm((f) => ({ ...f, features: e.target.value }))} className="min-h-24" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Saving…" : plan ? "Save plan" : "Create plan"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PlanActiveToggle({ agency, planId, active, name }: { agency: string; planId: string; active: boolean; name: string }) {
  const [on, setOn] = useState(active);
  const [pending, start] = useTransition();
  return (
    <Switch
      checked={on}
      disabled={pending}
      aria-label={on ? `Retire ${name}` : `Offer ${name}`}
      onCheckedChange={(v) => {
        setOn(v);
        start(async () => {
          const r = await setPlanActive(agency, planId, v);
          if (!r.ok) {
            setOn(!v);
            toast.error(r.error);
          } else toast.success(v ? `${name} is on sale` : `${name} retired — existing subscriptions continue`);
        });
      }}
    />
  );
}
