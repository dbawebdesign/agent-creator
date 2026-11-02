import Link from "next/link";
import { Suspense } from "react";
import { BillingStatusBadge, CheckoutLinkButton } from "@/components/billing";
import { ConnectStripeCard } from "@/components/billing/connect-stripe-card";
import { PortalBillingFlags } from "@/components/portal/billing-flags";
import { getBillingStatus } from "@/server/billing/service";
import { notFound } from "next/navigation";
import { ArrowUpRight, Plus } from "lucide-react";
import { AgentOrb } from "@/components/ui/agent-orb";
import { Button } from "@/components/ui/button";
import {
  AddCustomerDialog,
  NewPlanDialog,
  OfferAgentDialog,
} from "@/components/portal/resell-forms";
import { getPortal, getResell } from "@/server/queries/portal";
import { formatMoney } from "@/lib/utils";
import { capitalize } from "@/components/portal/lib";
import { StatusPill } from "@/components/portal/status-pill";

export const metadata = { title: "Resell" };

export default async function ResellPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  if (!p.canResell) notFound();
  const r = await getResell(p.org.id);
  // Real billing state where Stripe has it; everything else is a list-price record.
  const [seller, buyers] = await Promise.all([
    getBillingStatus(p.org.id),
    Promise.all(r.customers.map((c) => getBillingStatus(c.id))),
  ]);
  const billing = new Map(r.customers.map((c, i) => [c.id, buyers[i]!]));
  const billed = buyers.filter(
    (b) =>
      b.buyer?.subscription?.stripeManaged &&
      ["active", "trialing", "past_due"].includes(b.buyer.subscription.status),
  );
  const billedCents = billed.reduce(
    (sum, b) => sum + (b.buyer?.subscription?.priceCents ?? 0),
    0,
  );
  const sellerReady =
    Boolean(seller.seller?.chargesEnabled) && seller.mode !== "disabled";
  const canManage = p.isAdmin;
  const yearly = r.monthlyCents * 12;
  const paying = r.customers.filter((c) => c.monthlyCents > 0).length;
  const steps = [
    {
      done: r.plans.length > 0,
      title: "Set your price",
      body: "One flat monthly price for your customers.",
    },
    {
      done: r.customers.length > 0,
      title: "Add a customer",
      body: "They get their own portal, under your brand.",
    },
    {
      done: r.customers.some((c) => c.agents.length > 0),
      title: "Offer a teammate",
      body: "They get their own copy, with its own memory.",
    },
  ];
  const setupDone = steps.every((s) => s.done);
  const plansLite = r.plans.map((x) => ({
    id: x.id,
    name: x.name,
    priceCents: x.priceCents,
  }));
  const customersLite = r.customers.map((c) => ({ id: c.id, name: c.name }));
  const agentsLite = r.agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
  }));

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pt-8 md:px-6 md:pt-14">
      <Suspense fallback={null}>
        <PortalBillingFlags />
      </Suspense>
      <header className="mb-8 flex flex-col gap-5 animate-rise md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-ink md:text-[28px]">
            Resell your team
          </h1>
          <p className="mt-1.5 max-w-[56ch] text-[15px] text-ink-3 text-pretty">
            Offer your AI teammates to your own customers at your own price.
            Each customer gets a portal branded as {p.brand.name}.
          </p>
        </div>
        {canManage ? <AddCustomerDialog slug={slug} /> : null}
      </header>

      <section
        aria-label="Revenue"
        className="flex flex-col gap-6 rounded-2xl border border-line bg-surface p-5 shadow-sm md:flex-row md:items-end md:justify-between md:p-7"
      >
        <div>
          <p className="text-[13px] font-medium text-ink-3">
            {billedCents > 0
              ? "Monthly from your customers"
              : "Monthly from your customers, at list price"}
          </p>
          <p className="mt-1 text-[40px] leading-none font-semibold tracking-[-0.03em] text-ink tabular md:text-[48px]">
            {formatMoney(r.monthlyCents)}
            <span className="ml-1 text-[18px] font-medium tracking-normal text-ink-3">
              /mo
            </span>
          </p>
          <p className="mt-3 text-[13.5px] text-ink-3">
            {r.monthlyCents === 0
              ? "Your first customer turns your team into a revenue line."
              : billedCents > 0
                ? `${formatMoney(billedCents)}/mo is billed by card through Stripe${billedCents < r.monthlyCents ? `; the rest is at list price, not billed yet` : ""}.`
                : sellerReady
                  ? `${formatMoney(yearly)} a year at your prices. Copy a checkout link below so customers pay by card.`
                  : seller.mode === "disabled"
                    ? `${formatMoney(yearly)} a year at your prices. Card payments aren’t switched on yet, so collect payment the way you do today.`
                    : `${formatMoney(yearly)} a year at your prices. Connect Stripe below so customers pay you by card.`}
          </p>
        </div>
        {/* The pair only adds anything once there are more customers than the list below shows at a glance. */}
        {r.customers.length >= 3 ? (
          <dl className="grid grid-cols-2 gap-6 border-t border-line pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-8">
            <div>
              <dt className="text-[12px] text-ink-3">
                {billed.length ? "Paying by card" : "Subscribed customers"}
              </dt>
              <dd className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-ink tabular">
                {billed.length || paying}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-3">Teammates resold</dt>
              <dd className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-ink tabular">
                {r.customers.reduce((n, c) => n + c.agents.length, 0)}
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

      {/* With payments off platform-wide the hero subline says so once; the card only shows when there's a step to take. */}
      {canManage && seller.mode !== "disabled" ? (
        <ConnectStripeCard
          sellerOrgId={p.org.id}
          returnPath={`/p/${slug}/resell`}
          className="mt-4"
          showMode={false}
        />
      ) : null}

      {!setupDone && canManage ? (
        <ol className="mt-4 grid gap-3 md:grid-cols-3">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="flex gap-3 rounded-xl border border-line bg-surface p-4"
            >
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular ${s.done ? "bg-good-soft text-good" : "bg-surface-2 text-ink-3"}`}
                aria-hidden
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div>
                <p
                  className={`text-[13.5px] font-medium ${s.done ? "text-ink-3 line-through decoration-line-strong" : "text-ink"}`}
                >
                  {s.title}
                </p>
                <p className="mt-0.5 text-[12.5px] text-ink-3">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      <section aria-labelledby="customers" className="mt-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="customers" className="text-[13px] font-semibold text-ink">
            Your customers{" "}
            <span className="ml-1 font-normal text-ink-3 tabular">
              {r.customers.length}
            </span>
          </h2>
          {canManage && r.customers.length && r.agents.length ? (
            <OfferAgentDialog
              slug={slug}
              agents={agentsLite}
              customers={customersLite}
              plans={plansLite}
              sources={r.knowledge}
              trigger={
                <Button variant="ghost" size="sm" className="text-ink-2">
                  <Plus aria-hidden /> Offer a teammate
                </Button>
              }
            />
          ) : null}
        </div>
        {r.customers.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            {r.customers.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center md:px-5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[14.5px] font-medium text-ink">
                      {c.name}
                    </p>
                    {c.status !== "active" ? (
                      <StatusPill
                        status={{
                          tone: "neutral",
                          label: capitalize(c.status.replace(/_/g, " ")),
                        }}
                      />
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-3">
                    {c.agents.length ? (
                      c.agents.map((a) => (
                        <span
                          key={a.id}
                          className="inline-flex items-center gap-1.5"
                        >
                          <AgentOrb seed={a.seed} size={16} /> {a.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-ink-3">No teammates yet</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 sm:justify-end">
                  <p className="text-[14px] font-medium text-ink tabular sm:w-24 sm:text-right">
                    {c.monthlyCents > 0 ? (
                      <>
                        {formatMoney(c.monthlyCents)}
                        <span className="text-[12px] font-normal text-ink-3">
                          /mo
                        </span>
                      </>
                    ) : (
                      <span className="text-[13px] font-normal text-ink-3">
                        Trial
                      </span>
                    )}
                  </p>
                  {(() => {
                    const sub = billing.get(c.id)?.buyer?.subscription;
                    if (sub?.stripeManaged)
                      return (
                        <BillingStatusBadge
                          status={sub.status}
                          cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
                        />
                      );
                    if (
                      canManage &&
                      sellerReady &&
                      sub &&
                      sub.status !== "canceled"
                    )
                      return (
                        <CheckoutLinkButton
                          buyerOrgId={c.id}
                          planId={sub.planId}
                          returnPath={`/p/${slug}/resell`}
                          size="sm"
                        />
                      );
                    return null;
                  })()}
                  {canManage && !c.agents.length && r.agents.length ? (
                    <OfferAgentDialog
                      slug={slug}
                      agents={agentsLite}
                      customers={customersLite}
                      plans={plansLite}
                      sources={r.knowledge}
                      defaultCustomerId={c.id}
                      trigger={
                        <Button variant="secondary" size="sm">
                          Offer a teammate
                        </Button>
                      }
                    />
                  ) : null}
                  <Link
                    href={`/p/${c.slug}`}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                    aria-label={`Open ${c.name}'s portal`}
                  >
                    Portal <ArrowUpRight className="size-3.5" aria-hidden />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
            <p className="text-[14.5px] font-medium text-ink">
              No customers yet
            </p>
            <p className="mx-auto mt-1 max-w-sm text-[13.5px] text-ink-3">
              Know a business that would love what{" "}
              {r.agents[0]?.name ?? "your team"} does for you? Add them and
              offer a teammate in two clicks.
            </p>
            {canManage ? (
              <div className="mt-5">
                <AddCustomerDialog slug={slug} />
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section aria-labelledby="plans" className="mt-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="plans" className="text-[13px] font-semibold text-ink">
            Your prices
          </h2>
          {canManage ? <NewPlanDialog slug={slug} /> : null}
        </div>
        {r.plans.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            {r.plans.map((plan) => (
              <li key={plan.id} className="px-4 py-3.5 md:px-5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-[14px] font-medium text-ink">
                    {plan.name}
                  </p>
                  <p className="shrink-0 text-[14px] font-semibold text-ink tabular">
                    {formatMoney(plan.priceCents)}
                    <span className="text-[12px] font-normal text-ink-3">
                      /mo
                    </span>
                  </p>
                </div>
                {plan.description ? (
                  <p className="mt-1 line-clamp-2 text-[13px] text-ink-3">
                    {plan.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13.5px] text-ink-3">
            Set one flat monthly price — no setup fees, no usage bills for your
            customers.
          </p>
        )}
      </section>
    </div>
  );
}
