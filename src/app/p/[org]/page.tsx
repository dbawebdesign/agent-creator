import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { AskComposer } from "@/components/portal/composer";
import { DeliverableCardView, whenLabel } from "@/components/portal/deliverable-card";
import { greeting, longDate, feedBucket, hoursPhrase, numberWord, dayWord, clockTime } from "@/components/portal/lib";
import { NeedsYou, type NeedsYouItem } from "@/components/portal/needs-you";
import { getPortal, getToday } from "@/server/queries/portal";

export const metadata = { title: "Today" };

export default async function TodayPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  const tz = p.org.timezone;
  const t = await getToday(p.org.id);

  const needs: NeedsYouItem[] = [
    ...t.needsReview.map(
      (d): NeedsYouItem => ({
        type: "deliverable",
        id: d.id,
        title: d.title,
        preview: d.preview,
        kind: d.kind,
        when: whenLabel(d.createdAt, tz),
        agent: { name: d.agent.name, seed: d.agent.seed },
        sendsOnApprove: d.sendsOnApprove,
      }),
    ),
    ...t.approvals.map(
      (a): NeedsYouItem => ({
        type: "approval",
        id: a.id,
        description: a.description,
        when: whenLabel(a.createdAt, tz),
        agent: { name: a.agent.name, seed: a.agent.seed },
      }),
    ),
  ];

  const groups = new Map<string, typeof t.feed>();
  for (const d of t.feed) {
    const k = feedBucket(d.createdAt, tz);
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }

  const n = t.overnight.count;
  const hours = hoursPhrase(t.overnight.hours);
  const nextRun = t.nextRun?.nextRunAt
    ? `${dayWord(t.nextRun.nextRunAt, tz) === "today" ? "today" : dayWord(t.nextRun.nextRunAt, tz)} at ${clockTime(t.nextRun.nextRunAt, tz)}`
    : null;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 pt-8 md:px-6 md:pt-14">
      <header className="animate-rise">
        <p className="text-[13px] font-medium text-ink-4">{longDate(tz)}</p>
        <h1 className="mt-1.5 text-[28px] font-semibold tracking-[-0.025em] text-ink md:text-[32px]">
          {greeting(tz)}, {p.user.firstName}
        </h1>
        <p className="mt-2 max-w-[56ch] text-[15px] leading-relaxed text-ink-3 text-pretty">
          {n > 0 ? (
            <>
              While you were away, your team finished{" "}
              <span className="font-medium text-ink">
                {numberWord(n)} {n === 1 ? "thing" : "things"}
              </span>
              {hours ? (
                <>
                  {" "}
                  and saved you <span className="font-medium text-ink">{hours}</span>
                </>
              ) : null}
              .
            </>
          ) : t.feed.length || needs.length ? (
            <>Quiet night. Your team is caught up{nextRun ? <> — next delivery {nextRun}.</> : "."}</>
          ) : nextRun ? (
            <>Your team is getting set up. Your first delivery arrives {nextRun}.</>
          ) : (
            <>Your team is getting set up. Their first work will show up here.</>
          )}
        </p>
      </header>

      {p.canAct && t.agents.length ? (
        <AskComposer
          slug={slug}
          agents={t.agents.filter((a) => a.status !== "paused")}
          className="mt-6 animate-rise [animation-delay:60ms]"
          placeholder="Ask your team for anything…"
        />
      ) : null}

      {needs.length ? <NeedsYou slug={slug} items={needs} canAct={p.canAct} /> : null}

      {t.feed.length ? (
        [...groups.entries()].map(([label, items]) => (
          <section key={label} aria-label={label} className="mt-10">
            <h2 className="mb-3 text-[13px] font-semibold text-ink">{label}</h2>
            <ul className="grid gap-3">
              {items.map((d) => (
                <li key={d.id}>
                  <DeliverableCardView d={d} slug={slug} tz={tz} />
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : !needs.length ? (
        <div className="mt-10 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
          <span className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
            <CalendarClock className="size-5" aria-hidden />
          </span>
          <p className="text-[14.5px] font-medium text-ink">
            {nextRun ? `Your first delivery arrives ${nextRun}` : "Nothing delivered yet"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[13.5px] text-ink-3">
            {t.nextRun
              ? `${t.nextRun.agentName} is scheduled to start on “${t.nextRun.name}”. You’ll find the finished work right here.`
              : "Finished reports, documents and drafts from your team land here — no need to ask."}
          </p>
          <Link href={`/p/${slug}/team`} className="mt-5 inline-block text-[13px] font-medium text-accent hover:underline">
            Meet your team
          </Link>
        </div>
      ) : null}
    </div>
  );
}
