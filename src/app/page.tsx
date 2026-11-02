import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Brain, CalendarClock, Check, Inbox, Library, Mail, Monitor, Radio, Sparkles } from "lucide-react";
import { homePathFor } from "@/server/auth/access";
import { getCurrentUser } from "@/server/auth/session";
import { AgentOrb } from "@/components/ui/agent-orb";
import { buttonClass } from "@/components/ui/button";
import { Logo } from "@/components/shared/logo";

export const metadata: Metadata = {
  title: { absolute: "Roster — the studio for AI-employee agencies" },
  description: "Turn a discovery call into a live, proactive AI employee by morning. Sell it at a flat monthly rate.",
};

export default async function Root() {
  const user = await getCurrentUser();
  if (user) redirect(await homePathFor(user.id));

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-5 sm:px-8">
        <Logo />
        <nav className="flex items-center gap-1.5" aria-label="Account">
          <Link href="/login" className={buttonClass("ghost", "md")}>
            Sign in
          </Link>
          <Link href="/signup" className={buttonClass("primary", "md")}>
            Get started
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-[1120px] px-5 pt-16 pb-12 sm:px-8 md:pt-24">
          <div className="max-w-[760px] animate-rise">
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] text-ink-3 shadow-xs">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              For agencies that build and sell AI employees
            </p>
            <h1 className="mt-6 text-[40px] leading-[1.05] font-semibold tracking-[-0.035em] text-ink sm:text-[56px]">
              Turn a discovery call into an AI employee by morning.
            </h1>
            <p className="mt-5 max-w-[58ch] text-[16.5px] leading-relaxed text-ink-3">
              Paste the call. The Architect proposes the job, the workflows and a first overnight deliverable. Hire it, and it’s live with memory, knowledge, its own inbox, a computer and channels. Sell it flat-rate.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className={buttonClass("primary", "lg")}>
                Start your agency <ArrowRight />
              </Link>
              <Link href="/login" className={buttonClass("secondary", "lg")}>
                Sign in
              </Link>
            </div>
          </div>
        </section>

        <section aria-label="Product preview" className="mx-auto max-w-[1120px] px-5 pb-20 sm:px-8">
          <div className="animate-rise rounded-2xl border border-line bg-surface-2/50 p-2 shadow-lg [animation-delay:120ms] sm:p-3">
            <div className="grid gap-0 overflow-hidden rounded-xl border border-line bg-surface md:grid-cols-[minmax(0,1fr)_280px]">
              <div className="p-6 sm:p-8">
                <div className="flex items-start gap-4">
                  <AgentOrb seed="Quinn-Brandlord" size={44} />
                  <div>
                    <p className="text-[12px] font-medium text-accent">Proposed for Brandlord</p>
                    <p className="mt-0.5 text-[22px] font-semibold tracking-[-0.02em] text-ink">
                      Quinn <span className="font-light text-ink-4">·</span> <span className="text-[18px] font-medium text-ink-2">Quoting Specialist</span>
                    </p>
                    <p className="mt-1 text-[13.5px] text-ink-3">Turns weekend quote requests into good-better-best decks before Monday.</p>
                  </div>
                </div>
                <ul className="mt-7 space-y-2.5">
                  {[
                    { name: "Overnight quote queue", when: "Weekdays at 6:00 AM", icon: CalendarClock, out: "Document → Email, Portal" },
                    { name: "Quote deck from request", when: "When an email arrives", icon: Inbox, out: "Email draft → Email" },
                    { name: "Friday order status", when: "Fridays at 3:00 PM", icon: CalendarClock, out: "Report → Slack" },
                  ].map((w) => (
                    <li key={w.name} className="flex items-center gap-3 rounded-lg border border-line px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium text-ink">{w.name}</p>
                        <p className="truncate text-[12px] text-ink-3">{w.out}</p>
                      </div>
                      <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 text-[12px] font-medium text-accent">
                        <w.icon className="size-3" aria-hidden />
                        {w.when}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5 flex items-start gap-3 rounded-lg border border-accent/20 bg-accent-soft/60 px-4 py-3">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  <p className="text-[13px] text-ink-2">
                    <span className="font-medium text-ink">First overnight deliverable:</span> draft quotes for all 9 weekend requests, ready to review at 7 AM.
                  </p>
                </div>
              </div>
              <div className="flex flex-col border-t border-line p-6 sm:p-8 md:border-t-0 md:border-l">
                <p className="text-[12px] text-ink-3">Saves about</p>
                <p className="tabular text-[34px] leading-tight font-semibold tracking-[-0.03em] text-ink">
                  14 <span className="text-[14px] font-medium tracking-normal text-ink-3">hours / week</span>
                </p>
                <ul className="mt-5 space-y-2 border-t border-line pt-4 text-[12.5px]">
                  {[
                    { icon: Brain, label: "Memory" },
                    { icon: Library, label: "Knowledge base" },
                    { icon: Mail, label: "quinn@brandlord.agents" },
                    { icon: Monitor, label: "A computer" },
                    { icon: Radio, label: "Email · Slack · SMS · API · MCP" },
                  ].map((s) => (
                    <li key={s.label} className="flex items-center gap-2.5 text-ink-2">
                      <s.icon className="size-3.5 text-ink-4" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{s.label}</span>
                      <Check className="size-3.5 text-good" aria-hidden />
                    </li>
                  ))}
                </ul>
                <span className="mt-6 inline-flex h-9 items-center justify-center rounded-lg bg-ink text-[13px] font-medium text-canvas md:mt-auto">Hire Quinn</span>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto grid max-w-[1120px] gap-10 px-5 py-16 sm:px-8 md:grid-cols-3">
            {[
              { t: "Same-day, from one call", b: "The Architect reads the transcript, finds the itches, and proposes workflows with real schedules. You edit, then hire." },
              { t: "Proactive, not a chat box", b: "Your clients wake up to finished work — reports, decks, drafts — delivered to the portal, email and Slack. Risky actions wait for approval." },
              { t: "Flat-rate, resellable", b: "Sell each employee at a flat monthly price. No token billing. Clients can resell them to their own customers under their brand." },
            ].map((f) => (
              <div key={f.t}>
                <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{f.t}</h2>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-3">{f.b}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1120px] items-center justify-between px-5 py-6 text-[12.5px] text-ink-4 sm:px-8">
          <span>© {new Date().getFullYear()} Roster</span>
          <Link href="/login" className="hover:text-ink-2">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
