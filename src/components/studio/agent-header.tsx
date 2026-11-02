"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, LayoutTemplate, MoreHorizontal, Pause, Play } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { changeAgentStatus } from "@/app/a/_actions/agents";
import { SaveBlueprintDialog } from "./agent-dialogs";

export function CopyInline({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="group inline-flex min-w-0 items-center gap-1.5 rounded-md font-mono text-[12.5px] text-ink-3 transition-colors hover:text-ink"
      aria-label={`Copy ${label ?? value}`}
    >
      <span className="truncate">{value}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-good" /> : <Copy className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
    </button>
  );
}

export function AgentTabs({ base }: { base: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/workflows`, label: "Workflows" },
    { href: `${base}/knowledge`, label: "Knowledge" },
    { href: `${base}/memory`, label: "Memory" },
    { href: `${base}/activity`, label: "Activity" },
    { href: `${base}/settings`, label: "Settings" },
  ];
  return (
    <nav className="-mb-px flex gap-5 overflow-x-auto [scrollbar-width:none]" aria-label="Agent sections">
      {tabs.map((t) => {
        const active = t.href === base ? pathname === base : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 pt-1 pb-2.5 text-[13.5px] transition-colors",
              active ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AgentMenu({ agency, agentId, status, name, portalHref }: { agency: string; agentId: string; status: string; name: string; portalHref: string }) {
  const [pending, start] = useTransition();
  const [bpOpen, setBpOpen] = useState(false);
  const paused = status === "paused";
  return (
    <>
      <Menu>
        <MenuTrigger className="flex size-8 items-center justify-center rounded-md border border-line bg-surface text-ink-3 shadow-xs hover:text-ink data-[state=open]:bg-surface-2" aria-label="Agent actions" disabled={pending}>
          <MoreHorizontal className="size-4" />
        </MenuTrigger>
        <MenuContent align="end">
          {status === "active" || paused ? (
            <MenuItem
              onSelect={() =>
                start(async () => {
                  const r = await changeAgentStatus(agency, agentId, paused ? "active" : "paused");
                  if (r.ok) toast.success(paused ? `${name} is back at work` : `${name} is paused`);
                  else toast.error(r.error);
                })
              }
            >
              {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => setBpOpen(true)}>
            <LayoutTemplate /> Save as blueprint
          </MenuItem>
          <MenuSeparator />
          <MenuItem asChild>
            <a href={portalHref} target="_blank" rel="noreferrer">
              <ExternalLink /> Open client portal
            </a>
          </MenuItem>
        </MenuContent>
      </Menu>
      <SaveBlueprintDialog open={bpOpen} onOpenChange={setBpOpen} agency={agency} agentId={agentId} defaultName={name} />
    </>
  );
}
