"use client";

import { useCallback, useMemo } from "react";
import {
  Cable,
  CircleDot,
  FileText,
  MessageCircle,
  MessagesSquare,
  Search,
  Settings,
  Store,
  Sun,
  Users,
} from "lucide-react";
import {
  CommandPalette,
  useCommandPalette,
  type PaletteItem,
} from "@/components/shared/command-palette";
import { AgentOrb } from "@/components/ui/agent-orb";
import { searchDeliverablesAction } from "@/app/p/[org]/actions";

type Lite = { id: string; title: string; agentName: string };

export type PortalPaletteData = {
  agents: { id: string; name: string; role: string; seed: string }[];
  needs: Lite[];
  recent: Lite[];
};

/**
 * The portal's ⌘K: what's waiting on you, pages, teammates (and "Talk to …"), recent work, and a title search
 * over this org's deliverables (server action, org-scoped, capped at 8, debounced by the palette).
 */
export function PortalPalette({
  slug,
  canResell,
  data,
  children,
}: {
  slug: string;
  canResell: boolean;
  data: PortalPaletteData;
  children: React.ReactNode;
}) {
  const base = `/p/${slug}`;
  const items = useMemo<PaletteItem[]>(() => {
    const waiting = new Set(data.needs.map((d) => d.id));
    return [
      ...data.needs.map((d) => ({
        id: `need:${d.id}`,
        label: `Review: ${d.title}`,
        group: "Needs your OK",
        href: `${base}/d/${d.id}`,
        icon: <CircleDot />,
        hint: d.agentName,
        keywords: ["approve", "review", d.agentName],
      })),
      {
        id: "p:today",
        label: "Today",
        group: "Pages",
        href: base,
        icon: <Sun />,
      },
      {
        id: "p:requests",
        label: "Requests",
        group: "Pages",
        href: `${base}/requests`,
        icon: <MessagesSquare />,
      },
      {
        id: "p:team",
        label: "Team",
        group: "Pages",
        href: `${base}/team`,
        icon: <Users />,
      },
      {
        id: "p:connect",
        label: "Connect",
        group: "Pages",
        href: `${base}/connect`,
        icon: <Cable />,
        keywords: ["email", "text", "slack", "claude"],
      },
      ...(canResell
        ? [
            {
              id: "p:resell",
              label: "Resell",
              group: "Pages",
              href: `${base}/resell`,
              icon: <Store />,
              keywords: ["customers", "prices"],
            },
          ]
        : []),
      {
        id: "p:settings",
        label: "Settings",
        group: "Pages",
        href: `${base}/settings`,
        icon: <Settings />,
        keywords: ["people", "invite", "billing", "notifications"],
      },
      ...data.agents.flatMap((a) => [
        {
          id: `a:${a.id}`,
          label: a.name,
          group: "Teammates",
          href: `${base}/team/${a.id}`,
          icon: <AgentOrb seed={a.seed} size={16} />,
          hint: a.role,
          keywords: [a.role],
        },
        {
          id: `ask:${a.id}`,
          label: `Talk to ${a.name}…`,
          group: "Teammates",
          href: `${base}/team/${a.id}#talk`,
          icon: <MessageCircle />,
          keywords: ["ask", "message", a.name],
        },
      ]),
      ...data.recent
        .filter((d) => !waiting.has(d.id))
        .map((d) => ({
          id: `d:${d.id}`,
          label: d.title,
          group: "Recent work",
          href: `${base}/d/${d.id}`,
          icon: <FileText />,
          hint: d.agentName,
        })),
    ];
  }, [base, canResell, data]);

  const search = useCallback(
    async (q: string): Promise<PaletteItem[]> => {
      const rows = await searchDeliverablesAction({ slug, q });
      return rows.map((d) => ({
        id: `d:${d.id}`,
        label: d.title,
        group: "Work",
        href: `${base}/d/${d.id}`,
        icon: <FileText />,
        hint: d.agentName,
      }));
    },
    [slug, base],
  );

  return (
    <CommandPalette
      items={items}
      search={search}
      placeholder="Search work or jump to…"
    >
      {children}
    </CommandPalette>
  );
}

/** Quiet header button: opens ⌘K (and is the way in on touch). */
export function PaletteButton() {
  const { open } = useCommandPalette();
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Search"
      aria-keyshortcuts="Control+K Meta+K"
      className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink md:border md:border-line md:pr-1.5 md:pl-2.5"
    >
      <Search className="size-4" aria-hidden />
      <span className="hidden md:inline">Search</span>
      <kbd className="hidden rounded border border-line bg-surface-2 px-1.5 font-sans text-[11px] text-ink-3 md:inline">
        ⌘K
      </kbd>
    </button>
  );
}
