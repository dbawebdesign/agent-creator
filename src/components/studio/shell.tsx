"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Building2,
  Check,
  CheckCheck,
  ChevronsUpDown,
  CreditCard,
  FileText,
  MessageSquareWarning,
  RotateCcw,
  House,
  LayoutTemplate,
  LogOut,
  Menu as MenuIcon,
  Plus,
  Search,
  Settings,
  UserPlus,
  X,
} from "lucide-react";
import { AgentOrb, Avatar } from "@/components/ui/agent-orb";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { CommandPalette, useCommandPalette, type PaletteItem } from "@/components/shared/command-palette";
import { LogoMark } from "@/components/shared/logo";
import { paletteAttentionItems, paletteSearch } from "@/app/a/_actions/search";
import { cn } from "@/lib/utils";

export type ShellProps = {
  agency: { name: string; slug: string };
  agencies: { name: string; slug: string }[];
  user: { name: string | null; email: string };
  clients: { id: string; name: string; slug: string }[];
  agents: { id: string; name: string; role: string; seed: string; orgName: string; status: string; stalled?: boolean }[];
  /** Totals: the shell only carries a few recent items. */
  counts: { agents: number; clients: number };
  signOut: () => Promise<void>;
  children: React.ReactNode;
};

const NAV = [
  { href: "", label: "Home", icon: House },
  { href: "/clients", label: "Clients", icon: Building2 },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/blueprints", label: "Blueprints", icon: LayoutTemplate },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function StudioShell(props: ShellProps) {
  const base = `/a/${props.agency.slug}`;
  const items = useMemo<PaletteItem[]>(
    () => [
      { id: "new-agent", group: "Actions", label: "New agent from a discovery call", href: `${base}/agents/new`, icon: <Plus />, keywords: ["hire", "create", "transcript", "architect"], shortcut: "C" },
      { id: "new-client", group: "Actions", label: "Add a client", href: `${base}/clients?new=1`, icon: <Building2 />, keywords: ["create", "customer"] },
      { id: "invite", group: "Actions", label: "Invite a teammate", href: `${base}/settings#team`, icon: <UserPlus /> },
      { id: "new-plan", group: "Actions", label: "Create a plan", href: `${base}/billing?new=1`, icon: <CreditCard />, keywords: ["price", "pricing"] },
      { id: "approvals", group: "Actions", label: "Review approvals and change requests", href: `${base}#needs-attention`, icon: <CheckCheck />, keywords: ["approve", "approval", "decline", "reject", "pending", "sign off", "changes", "attention"] },
      ...NAV.map((n) => ({ id: `nav-${n.label}`, group: "Go to", label: n.label, href: `${base}${n.href}`, icon: <n.icon /> })),
      ...props.agents.map((a) => ({
        id: `agent-${a.id}`,
        group: "Agents",
        label: a.name,
        hint: `${a.role} · ${a.orgName}`,
        href: `${base}/agents/${a.id}`,
        icon: <AgentOrb seed={a.seed} size={16} />,
        keywords: [a.role, a.orgName],
      })),
      ...props.clients.map((c) => ({ id: `client-${c.id}`, group: "Clients", label: c.name, href: `${base}/clients/${c.slug}`, icon: <Building2 /> })),
    ],
    [base, props.agents, props.clients],
  );

  const slug = props.agency.slug;
  const search = useCallback(
    async (q: string): Promise<PaletteItem[]> => {
      const r = await paletteSearch(slug, q);
      return [
        ...r.agents.map((a) => ({
          id: `agent-${a.id}`,
          group: "Agents",
          label: a.name,
          hint: `${a.role} · ${a.orgName}`,
          href: `${base}/agents/${a.id}`,
          icon: <AgentOrb seed={a.seed} name={a.name} size={16} />,
          keywords: [a.role, a.orgName],
        })),
        ...r.clients.map((c) => ({ id: `client-${c.id}`, group: "Clients", label: c.name, href: `${base}/clients/${c.slug}`, icon: <Building2 /> })),
        ...r.deliverables.map((d) => ({
          id: `deliverable-${d.id}`,
          group: "Deliverables",
          label: d.title,
          hint: `${d.agentName} · ${d.orgName}`,
          href: `${base}/agents/${d.agentId}?d=${d.id}`,
          icon: <FileText />,
          keywords: [d.agentName, d.orgName],
        })),
      ];
    },
    [slug, base],
  );

  // Leads an empty ⌘K with the same work Home leads with; approvals are indexed by their text.
  const attention = useCallback(async (): Promise<PaletteItem[]> => {
    const r = await paletteAttentionItems(slug);
    const group = "Needs attention";
    return [
      ...r.approvals.map((a) => ({
        id: `approval-${a.id}`,
        group,
        label: `Review: ${a.description}`,
        hint: `${a.agentName} · ${a.orgName}`,
        href: `${base}/agents/${a.agentId}`,
        icon: <CheckCheck />,
        keywords: ["approve", "approval", "decline", "pending", a.agentName, a.orgName],
      })),
      ...r.changes.map((d) => ({
        id: `changes-${d.id}`,
        group,
        label: `Changes requested: ${d.title}`,
        hint: `${d.agentName} · ${d.orgName}`,
        href: `${base}/agents/${d.agentId}?d=${d.id}`,
        icon: <MessageSquareWarning />,
        keywords: ["changes", "revise", "feedback", d.agentName, d.orgName],
      })),
      ...r.stalled.map((a) => ({
        id: `stalled-${a.id}`,
        group,
        label: `Retry ${a.name}’s setup`,
        hint: `Setup stalled · ${a.orgName}`,
        href: `${base}/agents/${a.id}`,
        icon: <RotateCcw />,
        keywords: ["stalled", "retry", "setup", a.orgName],
      })),
    ];
  }, [slug, base]);

  return (
    <CommandPalette items={items} search={search} onOpenLoad={attention} placeholder="Search agents, clients, deliverables, or type a command…">
      <ShellFrame {...props} base={base} />
    </CommandPalette>
  );
}

function ShellFrame({ base, children, ...props }: ShellProps & { base: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  // "C" anywhere (outside a field) starts a new agent — the hero action is one key away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest("[role=dialog],[role=menu],[role=listbox]"))) return;
      e.preventDefault();
      router.push(`${base}/agents/new`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [base, router]);
  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    if (!mobileOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [mobileOpen]);

  return (
    <div className="min-h-dvh bg-canvas lg:pl-[240px]">
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-canvas/85 px-3 backdrop-blur-md lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2"
          aria-label="Open navigation"
        >
          <MenuIcon className="size-[18px]" />
        </button>
        <Link href={base} className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink">
          <LogoMark size={20} />
          <span className="truncate">{props.agency.name}</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <SearchButton compact />
          <Link
            href={`${base}/agents/new`}
            className="flex size-8 items-center justify-center rounded-md bg-ink text-canvas"
            aria-label="New agent"
          >
            <Plus className="size-4" />
          </Link>
        </div>
      </div>

      {/* Mobile drawer backdrop */}
      <div
        className={cn("fixed inset-0 z-40 bg-black/30 transition-opacity lg:hidden", mobileOpen ? "opacity-100" : "pointer-events-none opacity-0")}
        onClick={() => setMobileOpen(false)}
        aria-hidden
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-line bg-canvas transition-transform duration-200 ease-out lg:w-[240px] lg:translate-x-0",
          mobileOpen ? "translate-x-0 shadow-lg" : "-translate-x-full",
        )}
        aria-label="Studio navigation"
      >
        <div className="flex h-14 items-center gap-1 px-3">
          <AgencySwitcher agency={props.agency} agencies={props.agencies} />
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="ml-auto flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-1.5 px-3 pb-2">
          <Link
            href={`${base}/agents/new`}
            className="flex h-8 w-full items-center gap-2 rounded-md bg-ink px-2.5 text-[13px] font-medium text-canvas shadow-xs transition-colors hover:bg-ink-2"
          >
            <Plus className="size-4" aria-hidden />
            New agent
            <kbd className="ml-auto rounded border max-lg:hidden [@media(pointer:coarse)]:hidden border-canvas/20 px-1 font-sans text-[10.5px] text-canvas/60" aria-label="Shortcut C">C</kbd>
          </Link>
          <SearchButton />
        </div>

        <nav className="mt-2 space-y-px px-3" aria-label="Primary">
          {NAV.map((n) => {
            const href = `${base}${n.href}`;
            const active = n.href === "" ? pathname === base : pathname.startsWith(href) && !(n.href === "/agents" && pathname === `${base}/agents/new`);
            return (
              <Link
                key={n.label}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors",
                  active ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-2/70 hover:text-ink",
                )}
              >
                <n.icon className={cn("size-4", active ? "text-ink" : "text-ink-3")} aria-hidden />
                {n.label}
              </Link>
            );
          })}
        </nav>

        {props.agents.length ? (
          <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-3">
            <div className="px-2.5 pb-1.5 text-[11.5px] font-medium text-ink-3">Your roster</div>
            {/* Grouped by client (alphabetical), so same-named agents never need a truncated suffix to tell apart. */}
            {rosterGroups(props.agents.slice(0, 8)).map(([org, list]) => (
              <div key={org} className="mb-1">
                <div className="truncate px-2.5 pt-1.5 pb-0.5 text-[11px] text-ink-4" title={org}>
                  {org}
                </div>
                <ul className="space-y-px">
                  {list.map((a) => {
                    const href = `${base}/agents/${a.id}`;
                    const active = pathname.startsWith(href);
                    const flag = a.stalled ? "Setup stalled" : a.status === "paused" ? "Paused" : null;
                    return (
                      <li key={a.id}>
                        <Link
                          href={href}
                          title={`${a.name} · ${a.role} · ${org}${flag ? ` · ${flag}` : ""}`}
                          className={cn(
                            "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
                            active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2/70 hover:text-ink",
                          )}
                        >
                          <AgentOrb seed={a.seed} name={a.name} size={16} />
                          <span className="min-w-0 truncate">{a.name}</span>
                          {flag ? (
                            <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warn" role="img" aria-label={flag} />
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {props.counts.agents > props.agents.length ? (
              <Link href={`${base}/agents`} className="mt-1 flex h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium text-ink-3 hover:bg-surface-2/70 hover:text-ink">
                View all {props.counts.agents.toLocaleString()}
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <div className="border-t border-line p-3">
          <UserMenu user={props.user} signOut={props.signOut} />
        </div>
      </aside>

      <main id="main" className="min-w-0">{children}</main>
    </div>
  );
}

function SearchButton({ compact }: { compact?: boolean }) {
  const { open } = useCommandPalette();
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  if (compact) {
    return (
      <button type="button" onClick={open} className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2" aria-label="Search">
        <Search className="size-4" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink-3 shadow-xs transition-colors hover:border-line-strong hover:text-ink-2"
    >
      <Search className="size-3.5" aria-hidden />
      Search
      <kbd className="ml-auto font-sans max-lg:hidden [@media(pointer:coarse)]:hidden text-[11px] text-ink-3">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

function AgencySwitcher({ agency, agencies }: { agency: ShellProps["agency"]; agencies: ShellProps["agencies"] }) {
  return (
    <Menu>
      <MenuTrigger className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2">
        <LogoMark size={22} />
        <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">{agency.name}</span>
        <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-ink-4" aria-hidden />
      </MenuTrigger>
      <MenuContent className="w-60">
        <MenuLabel>Agencies</MenuLabel>
        {agencies.map((a) => (
          <MenuItem key={a.slug} asChild>
            <Link href={`/a/${a.slug}`}>
              <span className="flex size-5 items-center justify-center rounded bg-surface-2 text-[10px] font-semibold text-ink-2">{a.name[0]}</span>
              <span className="truncate">{a.name}</span>
              {a.slug === agency.slug ? <Check className="ml-auto" /> : null}
            </Link>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem asChild>
          <Link href={`/a/${agency.slug}/settings`}>
            <Settings /> Agency settings
          </Link>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function UserMenu({ user, signOut }: { user: ShellProps["user"]; signOut: () => Promise<void> }) {
  return (
    <Menu>
      <MenuTrigger className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2" aria-label="Account menu">
        <Avatar name={user.name ?? user.email} size={24} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{user.name ?? user.email.split("@")[0]}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-4" aria-hidden />
      </MenuTrigger>
      <MenuContent side="top" className="w-56">
        <MenuLabel className="truncate">{user.email}</MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Sidebar roster: agents grouped under their client, clients A→Z, agents A→Z within each. */
function rosterGroups(agents: ShellProps["agents"]): [string, ShellProps["agents"]][] {
  const map = new Map<string, ShellProps["agents"]>();
  for (const a of agents) map.set(a.orgName, [...(map.get(a.orgName) ?? []), a]);
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([org, list]) => [org, [...list].sort((x, y) => x.name.localeCompare(y.name))]);
}
