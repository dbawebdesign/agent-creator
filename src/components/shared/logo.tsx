import { cn } from "@/lib/utils";

/** Roster mark: three stacked rows, like names on a roster. */
export function LogoMark({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className={cn("shrink-0", className)}>
      <rect x="1" y="1" width="22" height="22" rx="6.5" className="fill-ink" />
      <rect x="6" y="6.5" width="12" height="2.6" rx="1.3" className="fill-canvas" />
      <rect x="6" y="10.7" width="9" height="2.6" rx="1.3" className="fill-canvas" opacity="0.75" />
      <rect x="6" y="14.9" width="6" height="2.6" rx="1.3" className="fill-canvas" opacity="0.5" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-ink", className)}>
      <LogoMark />
      Roster
    </span>
  );
}
