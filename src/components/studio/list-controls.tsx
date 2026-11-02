import Link from "next/link";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** GET search box: works without JS, keeps the URL shareable. */
export function ListSearch({ action, q, placeholder }: { action: string; q?: string; placeholder: string }) {
  return (
    <form action={action} method="get" role="search" className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-[13.5px] text-ink shadow-xs placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent/15 focus:outline-none"
      />
    </form>
  );
}

/** Previous / next page links for 50-row pages. */
export function Pager({ base, page, more, q, shown }: { base: string; page: number; more: boolean; q?: string; shown: number }) {
  if (page === 0 && !more) return null;
  const href = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (p > 0) sp.set("page", String(p + 1));
    const s = sp.toString();
    return s ? `${base}?${s}` : base;
  };
  const link = "inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 shadow-xs hover:bg-surface-2";
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3 text-[12.5px] text-ink-3">
      <span className="tabular">
        {page * 50 + 1}–{page * 50 + shown}
      </span>
      <span className="flex gap-2">
        {page > 0 ? (
          <Link href={href(page - 1)} className={link} rel="prev">
            <ChevronLeft className="size-3.5" aria-hidden /> Previous
          </Link>
        ) : null}
        {more ? (
          <Link href={href(page + 1)} className={cn(link)} rel="next">
            Next <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </span>
    </nav>
  );
}

export function parsePage(raw: string | undefined) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 10_000 ? Math.floor(n) - 1 : 0;
}
