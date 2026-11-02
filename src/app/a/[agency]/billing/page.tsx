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
  const pct = revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0;
  const activeSubs = subs.filter((s) => s.sub.status !== "canceled");

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
        <Stat className="sm:px-6" label="Gross margin" value={`${pct}%`} sub={`${money(revenue - cost)} / mo`} />
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
                <p className="text-[12px] text-ink-4">{plan.setupFeeCents ? `${money(plan.setupFeeCents)} setup` : "No setup fee"} · no token billing</p>
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
          <SectionHeading title="Margin by client" action={<Badge tone="accent">Agency only</Badge>} />
          <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-4">
                  <th className="px-5 py-2.5 font-medium">Client</th>
                  <th className="px-3 py-2.5 text-right font-medium">Plan price</th>
                  <th className="px-3 py-2.5 text-right font-medium">AI & infra (30d)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Margin</th>
                  <th className="w-40 px-5 py-2.5 font-medium"><span className="sr-only">Cost share</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {margin.map((m) => {
                  const mg = m.priceCents ? ((m.priceCents - m.costCents) / m.priceCents) * 100 : null;
                  const share = m.priceCents ? Math.min(100, (m.costCents / m.priceCents) * 100) : m.costCents ? 100 : 0;
                  return (
                    <tr key={m.id} className="tabular">
                      <td className="px-5 py-3">
                        <Link href={`/a/${slug}/clients/${m.slug}`} className="font-medium text-ink hover:underline underline-offset-2">{m.name}</Link>
                      </td>
                      <td className="px-3 py-3 text-right text-ink-2">{m.priceCents ? money(m.priceCents) : <span className="text-ink-4">—</span>}</td>
                      <td className="px-3 py-3 text-right text-ink-2" title={Object.entries(m.byKind).map(([k, v]) => `${k}: $${(v / 1e6).toFixed(2)}`).join(" · ")}>{money(m.costCents)}</td>
                      <td className={cn("px-3 py-3 text-right font-medium", mg === null ? "text-ink-4" : mg >= 80 ? "text-good" : mg >= 50 ? "text-ink-2" : "text-warn")}>{mg === null ? "—" : `${mg.toFixed(1)}%`}</td>
                      <td className="px-5 py-3">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
                          <div className="h-full rounded-full bg-ink-4" style={{ width: `${Math.max(share, m.costCents ? 2 : 0)}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[12px] text-ink-4">Cost is metered model, email, SMS and computer usage, including resale customers. Clients never see it.</p>
        </section>

        <section>
          <SectionHeading title="Subscriptions" count={subs.length} />
          {subs.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
              {subs.map((s) => (
                <li key={s.sub.id} className="flex items-center gap-4 px-5 py-3 text-[13px]">
                  <Link href={`/a/${slug}/clients/${s.orgSlug}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline underline-offset-2">{s.orgName}</Link>
                  <span className="hidden truncate text-ink-3 sm:block">{s.planName}</span>
                  <span className="tabular w-24 text-right text-ink-2">{money(s.priceCents)}</span>
                  <Badge tone={s.sub.status === "active" ? "good" : s.sub.status === "past_due" ? "warn" : s.sub.status === "trialing" ? "accent" : "neutral"}>
                    {s.sub.status === "past_due" ? "Past due" : s.sub.status[0]!.toUpperCase() + s.sub.status.slice(1)}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-line px-5 py-6 text-[13.5px] text-ink-3">No subscriptions yet. Assign a plan from a client’s page.</p>
          )}
        </section>
      </div>
    </div>
  );
}
