"use client";

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/utils";

/** Relative time that renders identically on server and client, then ticks. */
export function RelativeTime({ date, className }: { date: Date | string | null | undefined; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!date) return <span className={className}>never</span>;
  const d = typeof date === "string" ? new Date(date) : date;
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString("en-US")} className={className} suppressHydrationWarning>
      {timeAgo(d)}
    </time>
  );
}
