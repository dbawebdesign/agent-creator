import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock, FileText, Hourglass, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { requireOrg } from "@/server/auth/access";
import { getHome } from "@/server/queries/studio";
import { AgentOrb } from "@/components/ui/agent-orb";
import { buttonClass } from "@/components/ui/button";
import { RelativeTime } from "@/components/shared/relative-time";
import { ApprovalActions } from "@/components/studio/approval-actions";
import { hours, money, OUTPUT_LABEL, SectionHeading, Stat } from "@/components/studio/bits";

export const metadata = { title: "Home" };

function greeting(tz: string) {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()));
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function StudioHome({ params, searchParams }: { params: Promise<{ agency: string }>; searchParams: Promise<{ welcome?: string }> }) {
  const [{ agency: slug }, sp] = await Promise.all([params, searchParams]);
  const { org, user } = await requireOrg(slug, "viewer");
  const home = await getHome(org.id);
  const base = `/a/${slug}`;
  const first = (user.name ?? "").split(/\s+/)[0];
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: org.timezone }).format(new Date());
  const attention = home.approvals.length + home.failed.length + home.provisioning.length + home.waiting.length;

  if (home.counts.agents === 0) {
    return (
      <div className="mx-auto w-full max-w-[1080px] px-4 py-10 sm:px-6 md:px-10 md:py-14">
        <p className="text-[13px] text-ink-3">{today}</p>
        <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.025em] text-ink">{sp.welcome ? `Welcome to ${org.name}` : `${greeting(org.timezone)}${first ? `, ${first}` : ""}`}</h1>
        <div className="mt-10 overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          <div className="grid gap-8 p-8 md:grid-cols-[1fr_auto] md:items-center md:p-10">
            <div className="max-w-[52ch]">
              <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Sparkles className="size-5" aria-hidden />
              </span>
              <h2 className="mt-5 text-[20px] font-semibold tracking-[-0.02em] text-ink">Hire your first AI employee</h2>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-3">
                Paste a discovery call. The Architect proposes an employee with workflows, a schedule and a first overnight deliverable. Review it, hire it, and it’s live — memory, knowledge, its own inbox, a computer and channels.
              </p>
            </div>
            <Link href={`${base}/agents/new`} className={buttonClass("primary", "lg")}>
              <Plus /> New agent
            </Link>
          </div>
          <ol className="grid border-t border-line text-[13px] sm:grid-cols-3">
            {["Paste the call", "Review the proposal", "Hire — live in a minute"].map((s, i) => (
              <li key={s} className="flex items-center gap-3 border-line px-8 py-4 text-ink-2 max-sm:border-t sm:border-l sm:first:border-l-0">
                <span className="tabular flex size-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-ink-3">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] text-ink-3">
            {greeting(org.timezone)}
            {first ? `, ${first}` : ""} · {today}
          </p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.025em] text-ink">Today across your book</h1>
        </div>
      </header>

      <section aria-label="Key numbers" className="mt-8 grid grid-cols-2 gap-y-6 rounded-xl border border-line bg-surface px-5 py-5 shadow-xs sm:grid-cols-4 sm:divide-x sm:divide-line sm:px-0">
        <Stat className="sm:px-6" label="Monthly recurring" value={money(home.numbers.mrrCents)} sub={`${home.counts.clients} client${home.counts.clients === 1 ? "" : "s"}`} />
        <Stat className="sm:px-6" label="Active agents" value={home.numbers.activeAgents} sub={home.provisioning.length ? `${home.provisioning.length} provisioning` : "on the roster"} />
        <Stat className="sm:px-6" label="Hours saved" value={hours(home.numbers.hoursWeek)} sub="last 7 days" />
        <Stat className="sm:px-6" label="Delivered" value={home.numbers.deliveredWeek} sub="last 7 days" />
      </section>

      <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="delivered-h" className="min-w-0">
          <SectionHeading title="Delivered overnight" count={home.delivered.length} className="[&_h2]:text-[14px]" />
          {home.delivered.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
              {home.delivered.map((d) => (
                <li key={d.id}>
                  <Link href={`${base}/agents/${d.agentId}?d=${d.id}`} className="group flex items-start gap-3.5 px-4 py-3.5 transition-colors hover:bg-surface-2/50 sm:px-5">
                    <AgentOrb seed={d.agentSeed ?? d.agentId} size={28} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className="truncate text-[14px] font-medium text-ink">{d.title}</p>
                        {d.needsReview ? <span className="shrink-0 rounded-full bg-warn-soft px-1.5 text-[11px] font-medium text-warn">Needs review</span> : null}
                      </div>
                      {d.preview ? <p className="mt-0.5 line-clamp-1 text-[13px] text-ink-3">{d.preview}</p> : null}
                      <p className="mt-1 text-[12px] text-ink-4">
                        {d.agentName} for {d.orgName} · {OUTPUT_LABEL[d.kind] ?? d.kind}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <RelativeTime date={d.createdAt} className="text-[12px] text-ink-4" />
                      {d.hoursSaved ? <p className="tabular mt-1 text-[12px] font-medium text-good">+{hours(d.hoursSaved)}</p> : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
              <FileText className="mx-auto size-5 text-ink-4" aria-hidden />
              <p className="mt-3 text-[14px] font-medium text-ink">Nothing delivered in the last 24 hours</p>
              <p className="mt-1 text-[13px] text-ink-3">Scheduled workflows deliver here as they run.</p>
            </div>
          )}
        </section>

        <section aria-labelledby="attention-h">
          <SectionHeading title="Needs attention" count={attention || undefined} className="[&_h2]:text-[14px]" />
          {attention === 0 ? (
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-4 text-[13.5px] text-ink-2 shadow-xs">
              <ShieldCheck className="size-4 text-good" aria-hidden />
              All clear. Nothing is waiting on you.
            </div>
          ) : (
            <ul className="space-y-2">
              {home.approvals.map((a) => (
                <li key={a.id} className="rounded-xl border border-line bg-surface p-4 shadow-xs">
                  <div className="flex items-start gap-3">
                    <AgentOrb seed={a.agentSeed ?? a.agentId} size={22} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] text-ink-4">
                        {a.agentName} · {a.orgName} · <RelativeTime date={a.createdAt} />
                      </p>
                      <p className="mt-0.5 text-[13.5px] leading-snug text-ink">{a.description}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <ApprovalActions agency={slug} approvalId={a.id} />
                  </div>
                </li>
              ))}
              {home.failed.map((r) => (
                <AttentionRow key={r.id} href={`${base}/agents/${r.agentId}/activity`} icon={<AlertTriangle className="size-4 text-bad" />} title={`${r.workflowName ?? "A run"} failed`} meta={`${r.agentName} · ${r.orgName}`} date={r.createdAt} />
              ))}
              {home.provisioning.map((a) => (
                <AttentionRow key={a.id} href={`${base}/agents/${a.id}`} icon={<Hourglass className="size-4 text-accent" />} title={`${a.name} is provisioning`} meta={`${a.role} · ${a.orgName}`} date={a.createdAt} />
              ))}
              {home.waiting.map((a) => (
                <AttentionRow key={a.id} href={`${base}/agents/${a.id}`} icon={<Clock className="size-4 text-warn" />} title={`${a.name} hasn’t delivered yet`} meta={`First deliverable pending · ${a.orgName}`} date={a.createdAt} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function AttentionRow({ href, icon, title, meta, date }: { href: string; icon: React.ReactNode; title: string; meta: string; date: Date }) {
  return (
    <li>
      <Link href={href} className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-xs transition-colors hover:border-line-strong">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-ink">{title}</p>
          <p className="truncate text-[12px] text-ink-4">
            {meta} · <RelativeTime date={date} />
          </p>
        </div>
        <ArrowRight className="size-3.5 text-ink-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}
