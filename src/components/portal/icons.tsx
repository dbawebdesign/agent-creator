import { Code2, FileText, Globe, Hash, Mail, MessageSquare, PenLine, Sparkles, Table2, Zap, type LucideIcon } from "lucide-react";
import type { ChannelKind } from "@/server/db/schema/agents";
import { CHANNEL_LABEL, KIND_LABEL } from "./lib";
import { cn } from "@/lib/utils";

export const CHANNEL_ICON: Record<ChannelKind, LucideIcon> = {
  email: Mail,
  sms: MessageSquare,
  slack: Hash,
  portal: Globe,
  api: Code2,
  mcp: Sparkles,
};

export const KIND_ICON: Record<string, LucideIcon> = {
  report: FileText,
  document: FileText,
  table: Table2,
  email_draft: PenLine,
  message: MessageSquare,
  action: Zap,
};

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = KIND_ICON[kind] ?? FileText;
  return <Icon aria-hidden className={cn("size-3.5", className)} />;
}

export function ChannelIcon({ channel, className }: { channel: ChannelKind; className?: string }) {
  const Icon = CHANNEL_ICON[channel] ?? Globe;
  return <Icon aria-hidden className={cn("size-3.5", className)} />;
}

/** "Sent to Slack & Email" — where else this delivery went (the portal is implied). */
export function DeliveredVia({ via, className }: { via: ChannelKind[]; className?: string }) {
  const shown = via.filter((v) => v !== "portal");
  if (!shown.length) return null;
  const words = shown.map((v) => CHANNEL_LABEL[v] ?? v);
  const text = words.length > 2 ? `${words.slice(0, -1).join(", ")} & ${words.at(-1)}` : words.join(" & ");
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={`Also sent to your ${text}`}>
      {shown.map((v) => (
        <ChannelIcon key={v} channel={v} />
      ))}
      <span className="truncate">{text}</span>
    </span>
  );
}

export function kindLabel(kind: string) {
  return KIND_LABEL[kind] ?? "Report";
}

/** Slack's four-color mark, used only on the "Add to Slack" button. */
export function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4", className)}>
      <path fill="#E01E5A" d="M5.04 15.17a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52Zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.31a2.52 2.52 0 1 1-5.04 0v-6.31Z" />
      <path fill="#36C5F0" d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83Zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 1 1 0-5.04h6.31Z" />
      <path fill="#2EB67D" d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83Zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0v6.31Z" />
      <path fill="#ECB22E" d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52Zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 1 1 0 5.04h-6.31Z" />
    </svg>
  );
}
