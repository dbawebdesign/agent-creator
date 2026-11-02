import { BillingStatusBadge, SyncPlanButton } from "@/components/billing";
import { ConnectStripeCard } from "@/components/billing/connect-stripe-card";
import { BillingFlags } from "@/components/studio/billing-flags";
import Link from "next/link";
import { Suspense } from "react";
import { hasRole, requireOrg } from "@/server/auth/access";
import { getBilling } from "@/server/queries/studio";
import { billingMode } from "@/server/billing/stripe";
import { Pager, parsePage } from "@/components/studio/list-controls";
import { Badge } from "@/components/ui/badge";
import { PlanActiveToggle, PlanDialog } from "@/components/studio/plan-editor";
import { money, SectionHeading, Stat } from "@/components/studio/bits";
import { cn } from "@/lib/utils";

export const metadata = { title: "Billing" };

export default async function BillingPage({ params, searchParams }: { params: Promise<{ agency: string }>; searchParams: Promise<{ page?: string }> }) {
  const [{ agency: slug }, sp] = await Promise.all([params, searchParams]);
  const access = await requireOrg(slug, "viewer");
  const mode = billingMode();
  const { plans, rows, page, more, totals } = await getBilling(access.org.id, { live: mode === "live", page: parsePage(sp.page) });
  const admin = hasRole(access, "admin");
  // Margin is real only on billed revenue: test-mode and manual (not billed) plans are shown, never counted.
  const revenue = totals.billedCents;
  const pctRaw = revenue ? ((revenue - totals.billedCostCents) / revenue) * 100 : 0;
  const notBilledNote = mode === "live" ? "not billed" : "not billed · test mode";

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">Billing</h1>
          <p className="mt-1 text-[14px] text-ink-3">Flat-rate plans, client subscriptions and your margin.</p>
        </div>
        {admin ? (
          <Suspense>
            <PlanDialog agency={slug} />
          </Suspense>
        ) : null}
      </header>

      <Suspense>
        <BillingFlags />
      </Suspense>
      <ConnectStripeCard sellerOrgId={access.org.id} returnPath={`/a/${slug}/billing`} className="mb-8" />

      <section aria-label="Totals" className="grid grid-cols-2 gap-y-6 rounded-xl border border-line bg-surface px-5 py-5 shadow-xs sm:grid-cols-4 sm:divide-x sm:divide-line sm:px-0">
        <Stat
          className="sm:px-6"
          label="Monthly recurring"
          value={money(totals.billedCents)}
          sub={
            totals.unbilledCents ? (
              <>
                <span className="tabular">{money(totals.unbilledCents)}</span> {notBilledNote}
              </>
            ) : (
              `${totals.billedSubs} billed subscription${totals.billedSubs === 1 ? "" : "s"}`
            )
          }
        />
        <Stat className="sm:px-6" label="AI & infra cost" value={money(totals.costCents)} sub="last 30 days" />
        <Stat className="sm:px-6" label="Gross margin" value={revenue ? pct(pctRaw) : "—"} sub={revenue ? `${money(Math.round(revenue - totals.billedCostCents))} / mo on billed plans` : "Nothing billed yet"} />
        <Stat className="sm:px-6" label="Plans on sale" value={plans.filter((p) => p.plan.active).length} sub={`${plans.length} total`} />
      </section>

      <div className="mt-12 space-y-12">
        <section>
          <SectionHeading title="Plans" count={plans.length} />
          <ul className="grid gap-3 md:grid-cols-3">
            {plans.map(({ plan, subs: n }) => (
              <li key={plan.id} className={cn("flex flex-col rounded-xl border border-line bg-surface p-5 shadow-xs", !plan.active && "opacity-60")}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[14px] font-semibold text-ink">{plan.name}</p>
                  {admin ? <PlanActiveToggle agency={slug} planId={plan.id} active={plan.active} name={plan.name} /> : null}
                </div>
                <p className="tabular mt-3 text-[26px] font-semibold tracking-[-0.025em] text-ink">
                  {money(plan.priceCents)}
                  <span className="text-[13px] font-normal tracking-normal text-ink-3"> / month</span>
                </p>
                <p className="text-[12px] text-ink-3">{plan.setupFeeCents ? `${money(plan.setupFeeCents)} setup` : "No setup fee"} · no token billing</p>
                {plan.description ? <p className="mt-3 text-[13px] leading-relaxed text-ink-3">{plan.description}</p> : null}
                {plan.features.length ? (
                  <ul className="mt-3 space-y-1 text-[12.5px] text-ink-2">
                    {plan.features.slice(0, 5).map((f) => (
                      <li key={f} className="flex gap-2">
                        <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />
                        {f}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-auto flex items-center justify-between pt-5 text-[12.5px]">
                  <span className="text-ink-4">
                    {n} client{n === 1 ? "" : "s"}
                  </span>
                  {admin ? (
                    <span className="flex items-center gap-1">
                      <SyncPlanButton planId={plan.id} />
                      <Suspense>
                        <PlanDialog agency={slug} plan={plan} trigger={<button type="button" className="rounded-md px-2 py-1 font-medium text-ink-3 hover:bg-surface-2 hover:text-ink">Edit</button>} />
                      </Suspense>
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <SectionHeading title="Clients and margin" count={totals.clients} action={<Badge tone="accent">Agency only</Badge>} />
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs sm:hidden">
            {rows.map((m) => {
              const mg = m.priceCents ? ((m.priceCents - m.costCents) / m.priceCents) * 100 : null;
              return (
                <li key={m.id}>
                  <Link href={`/a/${slug}/clients/${m.slug}`} className="tabular flex items-start gap-3 px-4 py-3 text-[13px]">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{m.name}</p>
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        {m.planName ? `${m.planName} · ${money(m.priceCents)}/mo` : "No plan"} · {money(Math.round(m.costCents))} cost
                      </p>
                      {m.planName && (m.subStatus !== "active" || !m.billed) ? (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {m.subStatus !== "active" ? <BillingStatusBadge status={m.subStatus} cancelAtPeriodEnd={m.cancelAtPeriodEnd} /> : null}
                          {!m.billed ? <NotBilled /> : null}
                        </div>
                      ) : null}
                    </div>
                    <span className={cn("shrink-0 text-right text-[14px] font-semibold", mg === null || !m.billed ? "text-ink-3" : mg >= 80 ? "text-good" : mg >= 50 ? "text-ink-2" : "text-warn")}>
                      {mg === null ? "—" : pct(mg)}
                      <span className="block text-[11px] font-normal text-ink-3">margin</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="relative overflow-x-auto rounded-xl border border-line bg-surface shadow-xs max-sm:hidden">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="px-5 py-2.5 font-medium">Client</th>
                  <th className="px-3 py-2.5 font-medium">Plan</th>
                  <th className="px-3 py-2.5 text-right font-medium">Price</th>
                  <th className="px-3 py-2.5 text-right font-medium">AI & infra (30d)</th>
                  <th className="px-5 py-2.5 text-right font-medium">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((m) => {
                  const mg = m.priceCents ? ((m.priceCents - m.costCents) / m.priceCents) * 100 : null;
                  return (
                    <tr key={m.id} className="tabular">
                      <td className="px-5 py-3">
                        <Link href={`/a/${slug}/clients/${m.slug}`} className="font-medium text-ink hover:underline underline-offset-2">{m.name}</Link>
                      </td>
                      <td className="px-3 py-3">
                        {m.planName ? (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <span className="text-ink-2">{m.planName}</span>
                            <BillingStatusBadge status={m.subStatus} cancelAtPeriodEnd={m.cancelAtPeriodEnd} />
                            {!m.billed ? <NotBilled /> : null}
                          </span>
                        ) : (
                          <Badge tone="neutral">No plan</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-ink-2">{m.priceCents ? money(m.priceCents) : <span className="text-ink-3">—</span>}</td>
                      <td className="px-3 py-3 text-right text-ink-2">{money(Math.round(m.costCents))}</td>
                      <td className={cn("px-5 py-3 text-right font-medium", mg === null || !m.billed ? "text-ink-3" : mg >= 80 ? "text-good" : mg >= 50 ? "text-ink-2" : "text-warn")}>{mg === null ? "—" : pct(mg)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length ? null : <p className="rounded-xl border border-dashed border-line px-5 py-6 text-[13.5px] text-ink-3">No clients yet.</p>}
          <Pager base={`/a/${slug}/billing`} page={page} more={more} shown={rows.length} />
          <p className="mt-2 text-[12px] text-ink-3">
            Sorted by revenue. Cost is metered model, email, SMS and computer usage over the last 30 days, including resale customers. Plans marked not billed are left out of
            recurring revenue and margin. Clients never see any of this.
          </p>
        </section>
      </div>
    </div>
  );
}

/** One decimal, and never round a real margin up to 100%. */
function pct(v: number) {
  const r = Math.round(v * 10) / 10;
  return `${r >= 100 && v < 100 ? "99.9" : r.toFixed(1)}%`;
}

/** Quiet marker for a plan that isn't charged (Stripe test mode or a manual record). */
function NotBilled() {
  return (
    <Badge tone="neutral" className="whitespace-nowrap">
      Not billed
    </Badge>
  );
}
