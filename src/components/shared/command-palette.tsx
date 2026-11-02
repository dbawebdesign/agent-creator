"use client";

import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type PaletteItem = {
  id: string;
  label: string;
  group: string;
  /** Navigate to this href when chosen. */
  href?: string;
  /** Or run this callback. */
  onSelect?: () => void;
  icon?: React.ReactNode;
  hint?: string;
  keywords?: string[];
  shortcut?: string;
};

const SEP = "\u0000";

/**
 * Rank on the label (and keywords) only — never the group name or id. Exact and prefix matches first, then a word
 * that starts with the query, then a substring, then a keyword match. Anything else is hidden.
 */
export function paletteScore(value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const label = (value.split(SEP)[0] ?? "").toLowerCase();
  if (label === q) return 1;
  if (label.startsWith(q)) return 0.9;
  const words = label.split(/[\s·›/,()&-]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 0.8;
  if (q.length >= 3 && label.includes(q)) return 0.6;
  const kws = (keywords ?? []).map((k) => k.toLowerCase());
  if (kws.some((k) => k.startsWith(q) || k.split(/\s+/).some((w) => w.startsWith(q)))) return 0.4;
  return 0;
}

const Ctx = createContext<{ open: () => void }>({ open: () => {} });
export const useCommandPalette = () => useContext(Ctx);

/**
 * Generic ⌘K palette. Pass items; groups render in the order first seen.
 * Wrap a layout with it; call useCommandPalette().open() from a button.
 */
export function CommandPalette({
  items,
  search: remoteSearch,
  onOpenLoad,
  placeholder = "Type a command or search…",
  shortPlaceholder = "Search or jump to…",
  children,
}: {
  items: PaletteItem[];
  /** Optional server search (debounced, capped by the caller). Results merge into the local items. */
  search?: (q: string) => Promise<PaletteItem[]>;
  /** Optional items fetched each time the palette opens (e.g. "Needs attention"); listed before `items`. */
  onOpenLoad?: () => Promise<PaletteItem[]>;
  placeholder?: string;
  /** Placeholder on touch screens (pointer: coarse), where the long one gets cut off. */
  shortPlaceholder?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [remote, setRemote] = useState<PaletteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [pinned, setPinned] = useState<PaletteItem[]>([]);
  const [selected, setSelected] = useState("");
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!open || !onOpenLoad) return;
    let alive = true;
    onOpenLoad()
      .then((r) => {
        if (!alive) return;
        setPinned(r);
        // Items that arrive after opening go first, so the highlight follows them to the top.
        const top = r[0];
        if (top) setSelected((cur) => (cur && search.trim() ? cur : `${top.label}${SEP}${top.id}`));
      })
      .catch(() => alive && setPinned([]));
    return () => {
      alive = false;
    };
  }, [open, onOpenLoad]);

  useEffect(() => {
    const q = search.trim();
    if (!remoteSearch || q.length < 1) {
      setRemote([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      remoteSearch(q)
        .then((r) => alive && setRemote(r))
        .catch(() => alive && setRemote([]))
        .finally(() => alive && setLoading(false));
    }, 160);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search, remoteSearch]);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    const seen = new Set<string>();
    for (const it of [...pinned, ...items, ...remote]) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const list = map.get(it.group) ?? [];
      list.push(it);
      map.set(it.group, list);
    }
    const entries = [...map.entries()];
    if (!search.trim()) return entries;
    // Best match first: order groups by their top score, and items within a group by score.
    const score = (it: PaletteItem) => paletteScore(`${it.label}${SEP}${it.id}`, search, it.keywords);
    return entries
      .map(([g, list]) => [g, [...list].sort((a, b) => score(b) - score(a))] as [string, PaletteItem[]])
      .sort((a, b) => Math.max(...b[1].map(score)) - Math.max(...a[1].map(score)));
  }, [pinned, items, remote, search]);

  const run = useCallback(
    (it: PaletteItem) => {
      setOpen(false);
      setSearch("");
      if (it.onSelect) it.onSelect();
      else if (it.href) router.push(it.href);
    },
    [router],
  );

  const ctx = useMemo(() => ({ open: () => setOpen(true) }), []);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <D.Root open={open} onOpenChange={(o) => (setOpen(o), o || setSearch(""))}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in dark:bg-black/50" />
          <D.Content
            aria-label="Command palette"
            className="fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-raised shadow-lg animate-rise focus:outline-none"
          >
            <D.Title className="sr-only">Command palette</D.Title>
            <D.Description className="sr-only">Search pages, clients, agents and actions</D.Description>
            <Command loop className="flex flex-col" label="Command palette" filter={paletteScore} shouldFilter value={selected} onValueChange={setSelected}>
              <div className="flex items-center gap-2.5 border-b border-line px-4">
                <Search className="size-4 text-ink-4" aria-hidden />
                <Command.Input
                  autoFocus
                  value={search}
                  onValueChange={setSearch}
                  placeholder={coarse ? shortPlaceholder : placeholder}
                  className="h-12 w-full bg-transparent text-[14.5px] text-ink placeholder:text-ink-4 focus:outline-none"
                />
              </div>
              <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-4">
                <Command.Empty className="px-3 py-8 text-center text-[13px] text-ink-3">{loading ? "Searching…" : "No results."}</Command.Empty>
                {groups.map(([group, list]) => (
                  <Command.Group key={group} heading={group}>
                    {list.map((it) => (
                      <Command.Item
                        key={it.id}
                        value={`${it.label}${SEP}${it.id}`}
                        keywords={it.keywords}
                        onSelect={() => run(it)}
                        className="flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-ink-2 data-[selected=true]:bg-surface-2 data-[selected=true]:text-ink [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3"
                      >
                        {it.icon}
                        <span className="truncate">{it.label}</span>
                        {it.hint ? <span className="ml-auto max-w-[45%] shrink-0 truncate pl-3 text-[12px] text-ink-3 max-sm:hidden">{it.hint}</span> : null}
                        {it.shortcut ? (
                          <kbd className="ml-auto rounded border [@media(pointer:coarse)]:hidden border-line bg-surface-2 px-1.5 font-mono text-[11px] text-ink-3">{it.shortcut}</kbd>
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
              <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-ink-3 [@media(pointer:coarse)]:hidden">
                <span>↑↓ to move</span>
                <span>↵ to open</span>
                <span className="ml-auto">esc to close</span>
              </div>
            </Command>
          </D.Content>
        </D.Portal>
      </D.Root>
    </Ctx.Provider>
  );
}
