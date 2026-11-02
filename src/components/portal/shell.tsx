"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Cable,
  LogOut,
  MessagesSquare,
  Settings,
  Store,
  Sun,
  Users,
} from "lucide-react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Avatar } from "@/components/ui/agent-orb";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (p: string) => boolean;
  badge?: number;
};

export type ShellProps = {
  slug: string;
  brand: { name: string; logoUrl: string | null; whiteLabel: boolean };
  orgName: string;
  isCustomer: boolean;
  canResell: boolean;
  needsYouCount: number;
  user: { name: string | null; email: string };
  viewingAs: { name: string; href: string | null } | null;
  children: React.ReactNode;
};

export function BrandMark({
  name,
  logoUrl,
  size = 26,
}: {
  name: string;
  logoUrl: string | null;
  size?: number;
}) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-md object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[7px] bg-accent font-semibold text-accent-ink"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      {name.trim()[0]?.toUpperCase() ?? "R"}
    </span>
  );
}

export function PortalShell({
  slug,
  brand,
  orgName,
  isCustomer,
  canResell,
  needsYouCount,
  user,
  viewingAs,
  children,
}: ShellProps) {
  const pathname = usePathname() ?? "";
  const base = `/p/${slug}`;
  const rel = pathname.startsWith(base)
    ? pathname.slice(base.length) || "/"
    : pathname;

  const items: NavItem[] = [
    {
      href: base,
      label: "Today",
      icon: Sun,
      match: (p) => p === "/" || p.startsWith("/d/"),
      badge: needsYouCount,
    },
    {
      href: `${base}/team`,
      label: "Team",
      icon: Users,
      match: (p) => p.startsWith("/team"),
    },
    {
      href: `${base}/requests`,
      label: "Requests",
      icon: MessagesSquare,
      match: (p) => p.startsWith("/requests"),
    },
    {
      href: `${base}/connect`,
      label: "Connect",
      icon: Cable,
      match: (p) => p.startsWith("/connect"),
    },
    ...(canResell
      ? [
          {
            href: `${base}/resell`,
            label: "Resell",
            icon: Store,
            match: (p: string) => p.startsWith("/resell"),
          },
        ]
      : []),
    {
      href: `${base}/settings`,
      label: "Settings",
      icon: Settings,
      match: (p) => p.startsWith("/settings"),
    },
  ];
  // Phone tab bar: five slots. Clients reach Settings from the avatar menu.
  const tabs =
    items.length > 5 ? items.filter((i) => i.label !== "Settings") : items;

  return (
    <>
      {viewingAs ? (
        <div className="border-b border-line bg-surface-2 text-[12.5px] text-ink-3">
          <div className="mx-auto flex h-8 max-w-[1040px] items-center justify-between gap-3 px-4 md:px-6">
            <span className="truncate">
              Viewing {orgName}&rsquo;s portal as {viewingAs.name}
            </span>
            {viewingAs.href ? (
              <Link
                href={viewingAs.href}
                className="shrink-0 font-medium text-ink-2 hover:text-ink"
              >
                {viewingAs.href.startsWith("/a/")
                  ? "Back to Studio"
                  : `Back to ${viewingAs.name}`}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md supports-[backdrop-filter]:bg-canvas/70">
        <div className="mx-auto flex h-14 max-w-[1040px] items-center gap-6 px-4 md:px-6">
          <Link
            href={base}
            className="flex min-w-0 items-center gap-2.5 rounded-md"
            aria-label={`${brand.name} home`}
          >
            <BrandMark name={brand.name} logoUrl={brand.logoUrl} />
            <span className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-ink">
              {brand.name}
            </span>
            {isCustomer ? (
              <span className="hidden truncate text-[13px] text-ink-3 sm:inline">
                for {orgName}
              </span>
            ) : null}
          </Link>

          <nav
            aria-label="Portal"
            className="hidden items-center gap-0.5 md:flex"
          >
            {items.map((it) => {
              const active = it.match(rel);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13.5px] transition-colors duration-150",
                    active
                      ? "bg-surface-2 font-medium text-ink"
                      : "text-ink-3 hover:bg-surface-2/60 hover:text-ink",
                  )}
                >
                  {it.label}
                  {it.badge ? (
                    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-ink px-1 text-[11px] font-semibold text-canvas tabular">
                      {it.badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center">
            <Menu>
              <MenuTrigger
                className="flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-surface-2 focus-visible:rounded-full"
                aria-label="Account menu"
              >
                <Avatar name={user.name ?? user.email} size={30} />
              </MenuTrigger>
              <MenuContent align="end" className="w-60">
                <MenuLabel className="pb-2">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {user.name ?? user.email}
                  </span>
                  {user.name ? (
                    <span className="block truncate font-normal text-ink-3">
                      {user.email}
                    </span>
                  ) : null}
                </MenuLabel>
                <MenuSeparator />
                <MenuItem asChild>
                  <Link href={`${base}/settings`}>
                    <Settings /> Settings
                  </Link>
                </MenuItem>
                <MenuSeparator />
                <form action="/logout" method="post">
                  <MenuItem asChild>
                    <button type="submit" className="w-full">
                      <LogOut /> Sign out
                    </button>
                  </MenuItem>
                </form>
              </MenuContent>
            </Menu>
          </div>
        </div>
      </header>

      <main id="main" className="pb-28 md:pb-16">
        {children}
        {!brand.whiteLabel ? (
          <p className="mt-16 text-center text-[12px] text-ink-3">
            Powered by <span className="font-medium text-ink-3">Roster</span>
          </p>
        ) : null}
      </main>

      <nav
        aria-label="Portal tabs"
        className="portal-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 backdrop-blur-xl backdrop-saturate-150 md:hidden"
      >
        <ul className="mx-auto flex max-w-md items-stretch justify-around px-2">
          {tabs.map((it) => {
            const active = it.match(rel);
            const Icon = it.icon;
            return (
              <li key={it.href} className="flex-1">
                <Link
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-16 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium transition-colors",
                    active ? "text-ink" : "text-ink-3 hover:text-ink-2",
                  )}
                >
                  <span className="relative">
                    <Icon
                      className={cn(
                        "size-[21px]",
                        active ? "text-accent-text" : "",
                      )}
                    />
                    {it.badge ? (
                      <span className="absolute -top-1 -right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10px] font-semibold text-canvas tabular">
                        {it.badge}
                      </span>
                    ) : null}
                  </span>
                  {it.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
