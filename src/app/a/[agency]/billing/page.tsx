import Link from "next/link";
import { Suspense } from "react";
import { hasRole, requireOrg } from "@/server/auth/access";
import { getBilling } from "@/server/queries/studio";
import { Badge } from "@/components/ui/badge";
import { PlanActiveToggle, PlanDialog } from "@/components/studio/plan-editor";
import { money, SectionHeading, Stat } from "@/components/studio/bits";
import { cn } from "@/lib/utils";

export const metadata = { title: "Billing" };

export default async function BillingPage({ params }: { params: Promise<{ agency: string }> }) {
  const { agency: slug } = await params;
  const access = await requireOrg(slug, "viewer");
  const { plans, subs, margin, mrrCents } = await getBilling(access.org.id);
  const admin = hasRole(access, "admin");
  const cost = margin.reduce((s, m) => s + m.costCents, 0);
  const revenue = margin.reduce((s, m) => s + m.priceCents, 0);
  const pctRaw = revenue ? ((revenue - cost) / revenue) * 100 : 0;
  const activeSubs = subs.filter((s) => s.sub.status !== "canceled");
  const subByOrg = new Map(activeSubs.map((s) => [s.orgSlug, s] as const));

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

      <section aria-label="Totals" className="grid grid-cols-2 gap-y-6 rounded-xl border border-line bg-surface px-5 py-5 shadow-xs sm:grid-cols-4 sm:divide-x sm:divide-line sm:px-0">
        <Stat className="sm:px-6" label="Monthly recurring" value={money(mrrCents)} sub={`${activeSubs.length} subscription${activeSubs.length === 1 ? "" : "s"}`} />
        <Stat className="sm:px-6" label="AI & infra cost" value={money(cost)} sub="last 30 days" />
        <Stat className="sm:px-6" label="Gross margin" value={revenue ? pct(pctRaw) : "—"} sub={`${money(Math.round(revenue - cost))} / mo`} />
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
                    <Suspense>
                      <PlanDialog agency={slug} plan={plan} trigger={<button type="button" className="font-medium text-ink-3 hover:text-ink">Edit</button>} />
                    </Suspense>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <SectionHeading title="Clients and margin" count={margin.length} action={<Badge tone="accent">Agency only</Badge>} />
          <div className="relative overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
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
                {margin.map((m) => {
                  const mg = m.priceCents ? ((m.priceCents - m.costCents) / m.priceCents) * 100 : null;
                  const sub = subByOrg.get(m.slug);
                  return (
                    <tr key={m.id} className="tabular">
                      <td className="px-5 py-3">
                        <Link href={`/a/${slug}/clients/${m.slug}`} className="font-medium text-ink hover:underline underline-offset-2">{m.name}</Link>
                      </td>
                      <td className="px-3 py-3">
                        {sub ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="text-ink-2">{sub.planName}</span>
                            {sub.sub.status !== "active" ? (
                              <Badge tone={sub.sub.status === "past_due" ? "warn" : sub.sub.status === "trialing" ? "accent" : "neutral"}>
                                {sub.sub.status === "past_due" ? "Past due" : sub.sub.status[0]!.toUpperCase() + sub.sub.status.slice(1)}
                              </Badge>
                            ) : null}
                          </span>
                        ) : (
                          <Badge tone="neutral">No plan</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-ink-2">{m.priceCents ? money(m.priceCents) : <span className="text-ink-3">—</span>}</td>
                      <td className="px-3 py-3 text-right text-ink-2" title={Object.entries(m.byKind).map(([k, v]) => `${k}: $${(v / 1e6).toFixed(2)}`).join(" · ")}>{money(Math.round(m.costCents))}</td>
                      <td className={cn("px-5 py-3 text-right font-medium", mg === null ? "text-ink-3" : mg >= 80 ? "text-good" : mg >= 50 ? "text-ink-2" : "text-warn")}>{mg === null ? "—" : pct(mg)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[12px] text-ink-3">Cost is metered model, email, SMS and computer usage over the last 30 days, including resale customers. Clients never see it.</p>
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
