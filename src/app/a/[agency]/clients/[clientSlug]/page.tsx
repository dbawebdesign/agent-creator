import { Suspense } from "react";
import { CheckoutLinksCard } from "@/components/billing/checkout-links-card";
import { BillingFlags } from "@/components/studio/billing-flags";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { ArrowUpRight, Bot, ChevronRight, Plus } from "lucide-react";
import { requireOrg } from "@/server/auth/access";
import { db, schema } from "@/server/db/client";
import { agencyOrgs, getClient } from "@/server/queries/studio";
import { AgentOrb } from "@/components/ui/agent-orb";
import { buttonClass } from "@/components/ui/button";
import { RelativeTime } from "@/components/shared/relative-time";
import { InviteOwner, PlanSelect } from "@/components/studio/client-dialogs";
import { AgentStatus, ClientStatus, hours, money, OrgMark, OUTPUT_LABEL, SectionHeading } from "@/components/studio/bits";

export async function generateMetadata({ params }: { params: Promise<{ agency: string; clientSlug: string }> }) {
  const { agency, clientSlug } = await params;
  const { org } = await requireOrg(agency, "viewer");
  const client = (await agencyOrgs(org.id)).find((o) => o.slug === clientSlug);
  return { title: client?.name ?? "Client" };
}

export default async function ClientPage({ params }: { params: Promise<{ agency: string; clientSlug: string }> }) {
  const { agency: slug, clientSlug } = await params;
  const { org: agency } = await requireOrg(slug, "viewer");
  const data = await getClient(agency.id, clientSlug);
  if (!data) notFound();
  const { org, agents, deliverables, subs, members, invites, customers, hours: hrs } = data;
  const plans = await db().select().from(schema.plans).where(and(eq(schema.plans.orgId, agency.id), eq(schema.plans.active, true))).orderBy(asc(schema.plans.priceCents));
  const active = subs.find((s) => s.status !== "canceled");
  const base = `/a/${slug}`;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-10">
      <nav aria-label="Breadcrumb" className="mb-5 flex items-center gap-1 text-[12.5px] text-ink-3">
        <Link href={`${base}/clients`} className="hover:text-ink-2">Clients</Link>
        <ChevronRight className="size-3" aria-hidden />
        <span className="text-ink-3">{org.name}</span>
      </nav>
      <header className="flex flex-wrap items-start gap-4">
        <OrgMark name={org.name} size={48} className="rounded-lg text-[16px]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">{org.name}</h1>
            <ClientStatus status={org.status === "active" && !active ? "no plan" : org.status} />
          </div>
          <p className="mt-0.5 text-[14px] text-ink-3">
            {[org.industry, org.website?.replace(/^https?:\/\//, "").replace(/\/$/, ""), tzLabel(org.timezone), customers.length ? `${customers.length} resale customer${customers.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") || "Client"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={`/p/${org.slug}`} target="_blank" rel="noreferrer" className={buttonClass("secondary", "md")}>
            Open portal <ArrowUpRight />
          </a>
          <Link href={`${base}/agents/new?client=${org.slug}`} className={buttonClass("primary", "md")}>
            <Plus /> New agent
          </Link>
        </div>
      </header>

      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-12">
          <section>
            <SectionHeading title="AI employees" count={agents.length} />
            {agents.length ? (
              <ul className="grid gap-3 sm:grid-cols-2">
                {agents.map((a) => (
                  <li key={a.id}>
                    <Link href={`${base}/agents/${a.id}`} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:border-line-strong">
                      <AgentOrb seed={a.avatarSeed ?? a.id} name={a.name} size={34} live={a.status === "active"} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-medium text-ink">{a.name}</p>
                        <p className="truncate text-[12.5px] text-ink-3">{a.role}</p>
                        <div className="mt-2">
                          <AgentStatus status={a.status} />
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Link href={`${base}/agents/new?client=${org.slug}`} className="flex items-center gap-3 rounded-xl border border-dashed border-line px-5 py-6 text-[13.5px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink">
                <Bot className="size-4" aria-hidden /> No agents yet — paste a discovery call to hire the first one.
              </Link>
            )}
          </section>

          <section>
            <SectionHeading title="Recent deliverables" action={<span className="tabular text-[12.5px] text-ink-3">{hours(hrs)} saved recently</span>} />
            {deliverables.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
                {deliverables.map((d) => (
                  <li key={d.id}>
                    <Link href={`${base}/agents/${d.agentId}?d=${d.id}`} className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2/50 sm:px-5">
                      <AgentOrb seed={d.agentSeed ?? d.agentId} name={d.agentName} size={22} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium text-ink">{d.title}</p>
                        <p className="text-[12px] text-ink-3">
                          {d.agentName} · {OUTPUT_LABEL[d.kind] ?? d.kind}
                        </p>
                      </div>
                      <RelativeTime date={d.createdAt} className="shrink-0 text-[12px] text-ink-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-line px-5 py-6 text-[13.5px] text-ink-3">Nothing delivered yet.</p>
            )}
          </section>
        </div>

        <aside className="space-y-10">
          <section>
            <SectionHeading title="Plan & subscription" />
            <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
              {active ? (
                <div className="mb-4">
                  <p className="tabular text-[22px] font-semibold tracking-[-0.02em] text-ink">
                    {money(active.priceCents)}
                    <span className="text-[13px] font-normal text-ink-3"> / month</span>
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-ink-3">
                    {active.planName} · {active.status === "active" ? "Active" : active.status.replace("_", " ")} since{" "}
                    {active.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                </div>
              ) : (
                <p className="mb-4 text-[13px] text-ink-3">No active subscription.</p>
              )}
              <PlanSelect agency={slug} clientId={org.id} clientName={org.name} current={active?.planId ?? null} plans={plans.map((p) => ({ id: p.id, name: p.name, price: money(p.priceCents) }))} />
              <p className="mt-2 text-[12px] text-ink-3">Flat rate. No setup fee, no token billing.</p>
            </div>
            <CheckoutLinksCard buyerOrgId={org.id} returnPath={`/a/${slug}/clients/${org.slug}`} className="mt-3" />
            <Suspense>
              <BillingFlags />
            </Suspense>
          </section>

          <section>
            <SectionHeading title="Client team" count={members.length} />
            {members.length ? (
              <ul className="mb-4 space-y-2.5">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{m.name ?? m.email}</span>
                      <span className="block truncate text-[12px] text-ink-3">{m.email}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-ink-3 capitalize">{m.role}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {invites.length ? (
              <ul className="mb-4 space-y-1.5">
                {invites.map((i) => (
                  <li key={i.id} className="flex items-center justify-between text-[12.5px] text-ink-3">
                    <span className="truncate">{i.email}</span>
                    <span className="shrink-0 text-ink-4">
                      Invited <RelativeTime date={i.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mb-2 text-[12.5px] text-ink-3">{members.some((m) => m.role === "owner") ? "Invite a teammate to their portal" : "Invite the owner to their portal"}</p>
            <InviteOwner agency={slug} clientId={org.id} clientName={org.name} />
          </section>
        </aside>
      </div>
    </div>
  );
}

/** "Central time · 2:14 PM" — the client's timezone, as a person would say it. */
function tzLabel(tz: string) {
  try {
    const now = new Date();
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;
    const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
    return `${(name ?? tz).replace(/ (Standard|Daylight) Time$/, " time")} · ${time} there`;
  } catch {
    return tz;
  }
}
