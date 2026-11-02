import Link from "next/link";
import { Suspense } from "react";
import { and, asc, eq } from "drizzle-orm";
import { Building2 } from "lucide-react";
import { requireOrg } from "@/server/auth/access";
import { db, schema } from "@/server/db/client";
import { clientTotals, listClients } from "@/server/queries/studio";
import { billingMode } from "@/server/billing/stripe";
import { ListSearch, Pager, parsePage } from "@/components/studio/list-controls";
import { EmptyState } from "@/components/ui/empty";
import { RelativeTime } from "@/components/shared/relative-time";
import { NewClientButton } from "@/components/studio/client-dialogs";
import { ClientStatus, money, OrgMark } from "@/components/studio/bits";

export const metadata = { title: "Clients" };

export default async function ClientsPage({ params, searchParams }: { params: Promise<{ agency: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const [{ agency: slug }, sp] = await Promise.all([params, searchParams]);
  const { org } = await requireOrg(slug, "viewer");
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : undefined;
  const page = parsePage(sp.page);
  const [list, totals, plans] = await Promise.all([
    listClients(org.id, { page, q }),
    clientTotals(org.id, { live: billingMode() === "live" }),
    db().select().from(schema.plans).where(and(eq(schema.plans.orgId, org.id), eq(schema.plans.active, true))).orderBy(asc(schema.plans.priceCents)),
  ]);
  const planOpts = plans.map((p) => ({ id: p.id, name: p.name, price: money(p.priceCents) }));
  const clients = list.items;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">Clients</h1>
          <p className="mt-1 text-[14px] text-ink-3">
            {totals.count.toLocaleString()} client{totals.count === 1 ? "" : "s"} · {money(totals.mrrCents)} / month billed
            {totals.unbilledCents ? <> · {money(totals.unbilledCents)} not billed</> : null}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {totals.count > 10 || q ? <ListSearch action={`/a/${slug}/clients`} q={q} placeholder="Search clients" /> : null}
          <Suspense>
            <NewClientButton agency={slug} plans={planOpts} defaultTimezone={org.timezone} />
          </Suspense>
        </div>
      </header>

      {clients.length ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
          <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_80px_120px_100px] gap-4 border-b border-line px-5 py-2.5 text-[12px] font-medium text-ink-3 md:grid">
            <span>Client</span>
            <span>Plan</span>
            <span className="text-right">Agents</span>
            <span>Last delivery</span>
            <span>Status</span>
          </div>
          <ul className="divide-y divide-line">
            {clients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/a/${slug}/clients/${c.slug}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors hover:bg-surface-2/50 sm:px-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_80px_120px_100px]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <OrgMark name={c.name} size={30} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{c.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">{c.industry ?? c.website?.replace(/^https?:\/\//, "") ?? c.slug}</span>
                    </span>
                  </span>
                  <span className="hidden min-w-0 md:block">
                    {c.planName ? (
                      <>
                        <span className="tabular block text-[13px] font-medium text-ink-2">{money(c.mrrCents)}<span className="font-normal text-ink-3"> / mo</span></span>
                        <span className="block truncate text-[12px] text-ink-3">{c.planName}</span>
                      </>
                    ) : (
                      <span className="text-[12.5px] text-ink-3">No plan</span>
                    )}
                  </span>
                  <span className="tabular hidden text-right text-[13px] text-ink-2 md:block">{c.agents}</span>
                  <span className="hidden text-[12.5px] text-ink-3 md:block">{c.lastDeliveryAt ? <RelativeTime date={c.lastDeliveryAt} /> : <span className="text-ink-3">—</span>}</span>
                  <span className="justify-self-end md:justify-self-start">
                    <ClientStatus status={c.status === "active" && !c.planName ? "no plan" : c.status} />
                  </span>
                  <span className="col-span-2 text-[12px] text-ink-3 md:hidden">
                    {c.planName ? `${money(c.mrrCents)}/mo` : "No plan"} · {c.agents} agent{c.agents === 1 ? "" : "s"}
                    {c.lastDeliveryAt ? <> · delivered <RelativeTime date={c.lastDeliveryAt} /></> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : q ? (
        <p className="rounded-xl border border-dashed border-line px-5 py-8 text-center text-[13.5px] text-ink-3">No clients match “{q}”.</p>
      ) : (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState icon={<Building2 />} title="No clients yet" body="Add the businesses you staff. Each gets a white-labeled portal for their AI employees’ work." />
        </div>
      )}
      <Pager base={`/a/${slug}/clients`} page={list.page} more={list.more} q={q} shown={clients.length} />
    </div>
  );
}
