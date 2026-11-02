"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Loader2, Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  addCustomerAction,
  createPlanAction,
  offerAgentAction,
} from "@/app/p/[org]/actions";
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

export function AddCustomerDialog({
  slug,
  trigger,
}: {
  slug: string;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{
    name: string;
    slug: string;
    inviteUrl: string | null;
  } | null>(null);
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
        description={
          done
            ? "They get their own portal, branded as you."
            : "A business you’ll offer your AI teammates to. They get their own portal, under your brand."
        }
      >
        {done ? (
          <div className="space-y-4">
            <Field label="Their portal">
              <CopyField
                value={`${window.location.origin}/p/${done.slug}`}
                label="Copy portal link"
              />
            </Field>
            {done.inviteUrl ? (
              <Field
                label="Invite link"
                hint="Send this to them — it signs them in to their portal. Expires in 14 days."
              >
                <CopyField
                  value={done.inviteUrl}
                  label="Copy invite link"
                  mono
                />
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
                const res = await addCustomerAction({
                  slug,
                  name,
                  email: String(fd.get("email") ?? ""),
                });
                if (!res.ok) return setError(res.error);
                setDone({
                  name,
                  slug: res.customerSlug,
                  inviteUrl: res.inviteUrl,
                });
                toast.success(`${name} added`);
                router.refresh();
              });
            }}
          >
            <Field label="Business name" htmlFor="c-name">
              <Input
                id="c-name"
                name="name"
                required
                minLength={2}
                maxLength={120}
                placeholder="Four Corners Coffee"
                autoFocus
              />
            </Field>
            <Field
              label="Their email"
              hint="Optional. We’ll make an invite link for them."
              htmlFor="c-email"
            >
              <Input
                id="c-email"
                name="email"
                type="email"
                placeholder="owner@theirbusiness.com"
              />
            </Field>
            {error ? (
              <p className="text-[13px] text-bad" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="accent"
                disabled={pending}
                aria-busy={pending}
              >
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

export type ShareableSource = {
  id: string;
  title: string;
  kind: string;
  /** null = shared with every teammate in your workspace. */
  agentId: string | null;
  chunkCount: number;
};

const SOURCE_KIND: Record<string, string> = {
  file: "File",
  url: "Web page",
  text: "Note",
};

export function OfferAgentDialog({
  slug,
  agents,
  customers,
  plans,
  sources = [],
  defaultCustomerId,
  trigger,
}: {
  slug: string;
  agents: { id: string; name: string; role: string }[];
  customers: { id: string; name: string }[];
  plans: { id: string; name: string; priceCents: number }[];
  /** Your knowledge the customer's copy could be given. Nothing is shared unless ticked. */
  sources?: ShareableSource[];
  defaultCustomerId?: string;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [customerId, setCustomerId] = useState(
    defaultCustomerId ?? customers[0]?.id ?? "",
  );
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { pending, error, setError, start } = useAction();
  const router = useRouter();
  const agent = agents.find((a) => a.id === agentId);
  const customer = customers.find((c) => c.id === customerId);
  // This teammate's own sources, plus the ones every teammate shares.
  const offerable = sources.filter(
    (src) => src.agentId === agentId || src.agentId === null,
  );

  const reset = () => {
    setStep(1);
    setPicked(new Set());
    setError(null);
  };
  const toggle = (id: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = () =>
    start(async () => {
      const res = await offerAgentAction({
        slug,
        agentId,
        customerId,
        planId: planId || undefined,
        shareKnowledgeSourceIds: offerable
          .filter((src) => picked.has(src.id))
          .map((src) => src.id),
      });
      if (!res.ok) return setError(res.error);
      toast.success(
        `${agent?.name ?? "Your teammate"} is live in ${customer?.name ?? "your customer"}’s portal`,
      );
      setOpen(false);
      reset();
      router.refresh();
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? <Button variant="secondary">Offer a teammate</Button>}
      </DialogTrigger>
      <DialogContent
        title={step === 1 ? "Offer a teammate" : "What they get"}
        description={
          step === 1
            ? "Your customer gets their own copy, with its own memory and inbox."
            : `${customer?.name ?? "Your customer"}’s copy of ${agent?.name ?? "this teammate"}.`
        }
      >
        {step === 1 ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setStep(2);
            }}
          >
            <Field label="Teammate" htmlFor="o-agent">
              <Select
                id="o-agent"
                name="agentId"
                required
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value);
                  setPicked(new Set());
                }}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.role}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Customer" htmlFor="o-customer">
              <Select
                id="o-customer"
                name="customerId"
                required
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Your price"
              hint={
                plans.length
                  ? "What you’ll charge them each month."
                  : "Create a price plan first to bill for it."
              }
              htmlFor="o-plan"
            >
              <Select
                id="o-plan"
                name="planId"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatMoney(p.priceCents)}/mo
                  </option>
                ))}
                <option value="">No charge (trial)</option>
              </Select>
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="accent"
                disabled={!agentId || !customerId}
              >
                Next
              </Button>
            </div>
          </form>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
              <div className="rounded-lg border border-line p-3">
                <dt className="flex items-center gap-1.5 font-medium text-ink">
                  <Check className="size-3.5 text-good" aria-hidden /> Gets
                </dt>
                <dd className="mt-1 text-ink-3">
                  The role, its workflows and its voice.
                </dd>
              </div>
              <div className="rounded-lg border border-line p-3">
                <dt className="flex items-center gap-1.5 font-medium text-ink">
                  <Lock className="size-3.5 text-ink-3" aria-hidden /> Doesn’t
                  get
                </dt>
                <dd className="mt-1 text-ink-3">
                  Your files, your memories, your clients.
                </dd>
              </div>
            </dl>

            <fieldset>
              <legend className="text-[13px] font-medium text-ink">
                Share files (optional)
              </legend>
              <p className="mt-0.5 text-[12.5px] text-ink-3">
                Nothing is shared unless you tick it.
              </p>
              {offerable.length ? (
                <ul className="mt-2.5 max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {offerable.map((src) => (
                    <li key={src.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2/60">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-[var(--ink)]"
                          checked={picked.has(src.id)}
                          onChange={(e) => toggle(src.id, e.target.checked)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">
                            {src.title}
                          </span>
                          <span className="block text-[12px] text-ink-3">
                            {SOURCE_KIND[src.kind] ?? "Source"}
                            {src.chunkCount
                              ? ` · ${src.chunkCount} ${src.chunkCount === 1 ? "section" : "sections"}`
                              : ""}
                            {src.agentId === null
                              ? " · shared with your whole team"
                              : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2.5 rounded-lg bg-surface-2/70 px-3 py-2.5 text-[12.5px] text-ink-3">
                  {agent?.name ?? "This teammate"} has no files to share.
                </p>
              )}
            </fieldset>

            {error ? (
              <p className="text-[13px] text-bad" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep(1)}
                disabled={pending}
              >
                Back
              </Button>
              <Button
                type="submit"
                variant="accent"
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? <Loader2 className="animate-spin" /> : null}
                {picked.size
                  ? `Offer and share ${picked.size} ${picked.size === 1 ? "file" : "files"}`
                  : "Offer teammate"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function NewPlanDialog({
  slug,
  trigger,
}: {
  slug: string;
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
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="secondary" size="sm">
            <Plus aria-hidden /> New plan
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title="Set your price"
        description="One flat monthly price. No setup fees, no usage surprises for your customers."
      >
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
            <Input
              id="p-name"
              name="name"
              required
              minLength={2}
              maxLength={80}
              placeholder="Brand Studio Assistant"
              autoFocus
            />
          </Field>
          <Field label="Monthly price (USD)" htmlFor="p-price">
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[13.5px] text-ink-3">
                $
              </span>
              <Input
                id="p-price"
                name="price"
                required
                inputMode="decimal"
                type="number"
                min={1}
                step="1"
                placeholder="750"
                className="pl-6 tabular"
              />
            </div>
          </Field>
          <Field
            label="What’s included"
            hint="Optional. Shown to you when offering."
            htmlFor="p-desc"
          >
            <Textarea
              id="p-desc"
              name="description"
              maxLength={400}
              placeholder="Weekly social pack, monthly report, unlimited requests by email."
              className="min-h-20"
            />
          </Field>
          {error ? (
            <p className="text-[13px] text-bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="accent"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              Save plan
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
