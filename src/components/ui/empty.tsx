import { cn } from "@/lib/utils";

export function EmptyState({ icon, title, body, action, className }: { icon?: React.ReactNode; title: string; body?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon ? <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-surface-2 text-ink-3 [&_svg]:size-5">{icon}</div> : null}
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {body ? <p className="mt-1 max-w-sm text-[13px] text-ink-3">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
