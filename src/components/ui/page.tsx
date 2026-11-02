import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions, eyebrow, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode; className?: string }) {
  return (
    <header className={cn("mb-8 flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 text-[12.5px] font-medium text-ink-3">{eyebrow}</div> : null}
        <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-ink">{title}</h1>
        {description ? <p className="mt-1 text-[14px] text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PageBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mx-auto w-full max-w-[1080px] px-6 py-8 md:px-10 md:py-10", className)} {...props} />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[11px] text-ink-3">{children}</kbd>;
}
