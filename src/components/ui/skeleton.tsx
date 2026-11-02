import { cn } from "@/lib/utils";

/** Loading placeholder block. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse-soft rounded-md bg-surface-2", className)} />;
}
