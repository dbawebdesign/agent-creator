"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { addCustomerAction, createPlanAction, offerAgentAction } from "@/app/p/[org]/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { CopyField } from "./copy";
import { formatMoney } from "@/lib/utils";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return { pending, error, setError, start };
}

export function AddCustomerDialog({ slug, trigger }: { slug: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ name: string; slug: string; inviteUrl: string | null } | null>(null);
  const { pending, error, setError, start } = useAction();
  const router = useRouter();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setDone(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="accent">
            <Plus aria-hidden /> Add a customer
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={done ? `${done.name} is set up` : "Add a customer"}
        description={done ? "They get their own portal, branded as you." : "A business you’ll offer your AI teammates to. They get their own portal, under your brand."}
      >
        {done ? (
          <div className="space-y-4">
            <Field label="Their portal">
              <CopyField value={`${window.location.origin}/p/${done.slug}`} label="Copy portal link" />
            </Field>
            {done.inviteUrl ? (
              <Field label="Invite link" hint="Send this to them — it signs them in to their portal. Expires in 14 days.">
                <CopyField value={done.inviteUrl} label="Copy invite link" mono />
              </Field>
            ) : null}
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const name = String(fd.get("name") ?? "");
              start(async () => {
                const res = await addCustomerAction({ slug, name, email: String(fd.get("email") ?? "") });
                if (!res.ok) return setError(res.error);
                setDone({ name, slug: res.customerSlug, inviteUrl: res.inviteUrl });
                toast.success(`${name} added`);
                router.refresh();
              });
            }}
          >
            <Field label="Business name" htmlFor="c-name">
              <Input id="c-name" name="name" required minLength={2} maxLength={120} placeholder="Four Corners Coffee" autoFocus />
            </Field>
            <Field label="Their email" hint="Optional. We’ll make an invite link for them." htmlFor="c-email">
              <Input id="c-email" name="email" type="email" placeholder="owner@theirbusiness.com" />
            </Field>
            {error ? <p className="text-[13px] text-bad" role="alert">{error}</p> : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" disabled={pending} aria-busy={pending}>
                {pending ? <Loader2 className="animate-spin" /> : null}
                Add customer
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function OfferAgentDialog({
  slug,
  agents,
  customers,
  plans,
  defaultCustomerId,
  trigger,
}: {
  slug: string;
  agents: { id: string; name: string; role: string }[];
  customers: { id: string; name: string }[];
  plans: { id: string; name: string; priceCents: number }[];
  defaultCustomerId?: string;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { pending, error, setError, start } = useAction();
  const router = useRouter();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger ?? <Button variant="secondary">Offer a teammate</Button>}</DialogTrigger>
      <DialogContent title="Offer a teammate" description="They get their own copy — same skills, their own memory and inbox. Your data stays yours.">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const planId = String(fd.get("planId") ?? "");
            start(async () => {
              const res = await offerAgentAction({
                slug,
                agentId: String(fd.get("agentId") ?? ""),
                customerId: String(fd.get("customerId") ?? ""),
                planId: planId || undefined,
              });
              if (!res.ok) return setError(res.error);
              toast.success("Done — they’re live in your customer’s portal");
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <Field label="Teammate" htmlFor="o-agent">
            <Select id="o-agent" name="agentId" required defaultValue={agents[0]?.id}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.role}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Customer" htmlFor="o-customer">
            <Select id="o-customer" name="customerId" required defaultValue={defaultCustomerId ?? customers[0]?.id}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Your price" hint={plans.length ? "What you’ll charge them each month." : "Create a price plan first to bill for it."} htmlFor="o-plan">
            <Select id="o-plan" name="planId" defaultValue={plans[0]?.id ?? ""}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatMoney(p.priceCents)}/mo
                </option>
              ))}
              <option value="">No charge (trial)</option>
            </Select>
          </Field>
          {error ? <p className="text-[13px] text-bad" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending || !agents.length || !customers.length} aria-busy={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              Offer teammate
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NewPlanDialog({ slug, trigger }: { slug: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pending, error, setError, start } = useAction();
  const router = useRouter();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="secondary" size="sm">
            <Plus aria-hidden /> New plan
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title="Set your price" description="One flat monthly price. No setup fees, no usage surprises for your customers.">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            start(async () => {
              const res = await createPlanAction({
                slug,
                name: String(fd.get("name") ?? ""),
                price: String(fd.get("price") ?? ""),
                description: String(fd.get("description") ?? ""),
              });
              if (!res.ok) return setError(res.error);
              toast.success("Plan saved");
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <Field label="Plan name" htmlFor="p-name">
            <Input id="p-name" name="name" required minLength={2} maxLength={80} placeholder="Brand Studio Assistant" autoFocus />
          </Field>
          <Field label="Monthly price (USD)" htmlFor="p-price">
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[13.5px] text-ink-4">$</span>
              <Input id="p-price" name="price" required inputMode="decimal" type="number" min={1} step="1" placeholder="750" className="pl-6 tabular" />
            </div>
          </Field>
          <Field label="What’s included" hint="Optional. Shown to you when offering." htmlFor="p-desc">
            <Textarea id="p-desc" name="description" maxLength={400} placeholder="Weekly social pack, monthly report, unlimited requests by email." className="min-h-20" />
          </Field>
          {error ? <p className="text-[13px] text-bad" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending} aria-busy={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              Save plan
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
