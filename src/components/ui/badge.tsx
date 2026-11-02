import { cn } from "@/lib/utils";

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";
const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-3",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
};

export function Badge({ tone = "neutral", dot, className, children }: { tone?: Tone; dot?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium", tones[tone], className)}>
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function StatusDot({ tone = "neutral", pulse }: { tone?: Tone; pulse?: boolean }) {
  const color = { neutral: "bg-ink-4", good: "bg-good", warn: "bg-warn", bad: "bg-bad", accent: "bg-accent" }[tone];
  return <span className={cn("inline-block size-2 rounded-full", color, pulse && "animate-pulse-soft")} />;
}
