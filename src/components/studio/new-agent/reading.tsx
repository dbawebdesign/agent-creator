"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "read", label: "Reading the call" },
  { key: "itch", label: "Finding the itches" },
  { key: "workflows", label: "Designing workflows" },
  { key: "job", label: "Writing the job description" },
  { key: "first", label: "Planning the first overnight deliverable" },
] as const;

const PAIN = /(every (week|day|morning|friday|monday|night)|hours?|forty|thirty|minutes|drown|behind|lose|never remember|manual|by hand|spreadsheet|takes|eats|chase|follow[- ]?ups?|sunday|weekend|i have to|we have to)/i;

/** Strip markdown emphasis and leading timestamps ("**10:32** · ", "[00:10:32]", "(10:32) -") from a transcript line. */
export function cleanLine(line: string): string {
  return line
    .replace(/\*\*|__/g, "")
    .replace(/^\s*[>#*-]*\s*/, "")
    .replace(/^[\[(]?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?[\])]?\s*(?:[·•|–—-]\s*)?/, "")
    .trim();
}

/** Close a quotation the Architect opened but didn't close: “… → “…” */
export function balanceQuotes(text: string): string {
  const opens = (text.match(/“/g) ?? []).length;
  const closes = (text.match(/”/g) ?? []).length;
  return opens > closes ? `${text.replace(/[\s.]+$/, (m) => m.trim())}”` : text;
}

/** Pull a few quotable pain-point lines from the transcript, client-side, for the live reading state. */
export function extractItches(transcript: string, max = 3): string[] {
  const lines = transcript
    .split(/\n+/)
    .map(cleanLine)
    .filter((l) => l.length > 30);
  const speakers = new Map<string, number>();
  for (const l of lines) {
    const m = /^([A-Z][\w .'-]{0,24}):/.exec(l);
    if (m) speakers.set(m[1]!, (speakers.get(m[1]!) ?? 0) + 1);
  }
  const host = [...speakers.entries()][0]?.[0];
  const out: string[] = [];
  for (const l of lines) {
    const m = /^([A-Z][\w .'-]{0,24}):\s*(.*)$/.exec(l);
    const who = m?.[1];
    const text = (m?.[2] ?? l).trim();
    if (who && who === host && speakers.size > 1) continue;
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (PAIN.test(sentence) && sentence.length > 24 && sentence.length < 170 && !sentence.endsWith("?")) {
        out.push(sentence);
        break;
      }
    }
    if (out.length >= max) break;
  }
  return out;
}

export function transcriptStats(t: string) {
  const words = t.split(/\s+/).filter(Boolean).length;
  const speakers = new Set([...t.matchAll(/^\s*([A-Z][\w .'-]{0,24}):/gm)].map((m) => m[1]!)).size;
  return { words, speakers, minutes: Math.max(1, Math.round(words / 150)) };
}

export function ArchitectReading({
  transcript,
  clientName,
  done,
  failed,
  slow,
  found,
}: {
  transcript: string;
  clientName: string;
  done: boolean;
  failed?: string | null;
  slow?: boolean;
  /** Once the proposal is ready: the workflows it designed and the itch each one answers. */
  found?: { workflow: string; problem: string }[] | null;
}) {
  const [step, setStep] = useState(0);
  const guessed = useMemo(() => extractItches(transcript), [transcript]);
  const fromProposal = useMemo(() => {
    const seen = new Set<string>();
    return (found ?? [])
      .map((f) => ({ ...f, problem: balanceQuotes(cleanLine(f.problem)) }))
      .filter((f) => f.problem && !seen.has(f.problem) && seen.add(f.problem))
      .slice(0, 4);
  }, [found]);
  const finished = done && step >= STEPS.length;
  const stats = useMemo(() => transcriptStats(transcript), [transcript]);

  useEffect(() => {
    if (failed) return;
    if (done) {
      const t = setInterval(() => setStep((s) => Math.min(STEPS.length, s + 1)), 220);
      return () => clearInterval(t);
    }
    // Advance on a calm cadence, but never mark the last step done until the proposal is ready.
    const t = setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 2100);
    return () => clearInterval(t);
  }, [done, failed]);

  return (
    <div className="mx-auto max-w-[560px] pt-6 animate-fade-in" aria-live="polite">
      <div className="mb-10 flex items-center gap-4">
        <ArchitectOrb active={!finished && !failed} />
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">{failed ? "The Architect hit a snag" : finished ? "Proposal ready" : "The Architect is reading the call"}</h1>
          <p className="mt-0.5 text-[14px] text-ink-3">
            {failed ? failed : `${clientName} · ${stats.words.toLocaleString()} words · about ${stats.minutes} min of conversation`}
          </p>
        </div>
      </div>

      <ol className="relative space-y-0">
        {STEPS.map((s, i) => {
          const state = i < step ? "done" : i === step && !failed ? "active" : "todo";
          return (
            <li key={s.key} className="relative flex gap-4 pb-6 last:pb-0">
              {i < STEPS.length - 1 ? (
                <span aria-hidden className={cn("absolute top-6 left-[11px] h-[calc(100%-20px)] w-px transition-colors duration-500", i < step ? "bg-accent/40" : "bg-line")} />
              ) : null}
              <span
                className={cn(
                  "relative z-10 mt-0.5 flex size-[23px] shrink-0 items-center justify-center rounded-full border transition-all duration-300",
                  state === "done" && "border-accent bg-accent text-accent-ink",
                  state === "active" && "border-accent/50 bg-surface text-accent",
                  state === "todo" && "border-line bg-surface text-ink-4",
                )}
              >
                {state === "done" ? <Check className="size-3.5" strokeWidth={2.5} /> : state === "active" ? <Loader2 className="size-3.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[14px] transition-colors", state === "todo" ? "text-ink-4" : "font-medium text-ink")}>{s.label}</p>
                {s.key === "read" && state !== "todo" ? (
                  <p className="mt-0.5 text-[13px] text-ink-3 animate-fade-in">
                    {stats.speakers > 1 ? `${stats.speakers} speakers` : "One speaker"} · {stats.words.toLocaleString()} words
                  </p>
                ) : null}
                {s.key === "itch" && state !== "todo" && (fromProposal.length || guessed.length) ? (
                  fromProposal.length ? (
                    <ul className="mt-2 space-y-2" key="proposal">
                      {fromProposal.map((f, qi) => (
                        <li key={qi} className="border-l-2 border-accent/40 pl-3 animate-rise" style={{ animationDelay: `${qi * 160}ms` }}>
                          <p className="text-[13px] leading-relaxed text-ink-2">{f.problem}</p>
                          <p className="mt-0.5 text-[12px] font-medium text-accent-text">→ {f.workflow}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <ul className="mt-2 space-y-1.5" key="guessed">
                      {guessed.map((q, qi) => (
                        <li key={qi} className="border-l-2 border-line-strong pl-3 text-[13px] leading-relaxed text-ink-3 italic animate-rise" style={{ animationDelay: `${qi * 380}ms` }}>
                          “{q}”
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {slow && !done && !failed ? (
        <p className="mt-8 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] text-ink-3">
          Taking longer than usual. Long calls can take a minute — you can leave this page; the proposal will be waiting under this client.
        </p>
      ) : null}
    </div>
  );
}

export function ArchitectOrb({ active, size = 44 }: { active?: boolean; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden>
      <span
        className={cn("absolute inset-0 rounded-full", active && "animate-[spin_6s_linear_infinite]")}
        style={{
          background: "conic-gradient(from 0deg, var(--accent), color-mix(in oklab, var(--accent) 30%, #22d3ee), color-mix(in oklab, var(--accent) 40%, #f0abfc), var(--accent))",
        }}
      />
      <span className="absolute inset-[3px] rounded-full bg-surface" />
      <span
        className={cn("absolute inset-[9px] rounded-full", active && "animate-pulse-soft")}
        style={{ background: "radial-gradient(circle at 35% 30%, color-mix(in oklab, var(--accent) 35%, white), var(--accent))" }}
      />
    </span>
  );
}
