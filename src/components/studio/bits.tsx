import Link from "next/link";
import { Badge, StatusDot } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const OUTPUT_LABEL: Record<string, string> = {
  report: "Report",
  document: "Document",
  table: "Table",
  email_draft: "Email draft",
  message: "Message",
  action: "Action",
};

export const CHANNEL_LABEL: Record<string, string> = {
  portal: "Portal",
  email: "Email",
  sms: "SMS",
  slack: "Slack",
  api: "API",
  mcp: "MCP",
};

export function AgentStatus({ status }: { status: string }) {
  const map: Record<string, { tone: "good" | "warn" | "neutral" | "accent" | "bad"; label: string; pulse?: boolean }> = {
    active: { tone: "good", label: "Active" },
    provisioning: { tone: "accent", label: "Provisioning", pulse: true },
    paused: { tone: "warn", label: "Paused" },
    draft: { tone: "neutral", label: "Draft" },
    archived: { tone: "neutral", label: "Archived" },
  };
  const m = map[status] ?? { tone: "neutral" as const, label: status };
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
      <StatusDot tone={m.tone} pulse={m.pulse} />
      {m.label}
    </span>
  );
}

export function ClientStatus({ status }: { status: string }) {
  const tone = status === "active" ? "good" : status === "trial" ? "accent" : status === "paused" ? "warn" : "neutral";
  return (
    <Badge tone={tone} dot>
      {status[0]?.toUpperCase()}
      {status.slice(1)}
    </Badge>
  );
}

export function OrgMark({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  const letters = name
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-surface font-semibold text-ink-2", className)}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
    >
      {letters || "?"}
    </span>
  );
}

/** Quiet number: small label over a large tabular figure. */
export function Stat({ label, value, sub, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className="tabular mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink">{value}</div>
      {sub ? <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

export function SectionHeading({ title, count, action, className }: { title: string; count?: number; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
        {title}
        {typeof count === "number" ? <span className="tabular text-[12.5px] font-normal text-ink-3">{count}</span> : null}
      </h2>
      {action}
    </div>
  );
}

export function TextLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn("text-[12.5px] font-medium text-ink-3 transition-colors hover:text-ink", className)}>
      {children}
    </Link>
  );
}

export function hours(n: number) {
  if (n >= 100) return `${Math.round(n)} h`;
  return `${Math.round(n * 10) / 10} h`;
}

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "usd", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

export function microsToDollars(micros: number) {
  const d = micros / 1_000_000;
  if (d > 0 && d < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "usd", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(d);
}
