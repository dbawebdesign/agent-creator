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

const Ctx = createContext<{ open: () => void }>({ open: () => {} });
export const useCommandPalette = () => useContext(Ctx);

/**
 * Generic ⌘K palette. Pass items; groups render in the order first seen.
 * Wrap a layout with it; call useCommandPalette().open() from a button.
 */
export function CommandPalette({ items, placeholder = "Type a command or search…", children }: { items: PaletteItem[]; placeholder?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
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
    for (const it of items) {
      const list = map.get(it.group) ?? [];
      list.push(it);
      map.set(it.group, list);
    }
    return [...map.entries()];
  }, [items]);

  const run = useCallback(
    (it: PaletteItem) => {
      setOpen(false);
      if (it.onSelect) it.onSelect();
      else if (it.href) router.push(it.href);
    },
    [router],
  );

  const ctx = useMemo(() => ({ open: () => setOpen(true) }), []);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in dark:bg-black/50" />
          <D.Content
            aria-label="Command palette"
            className="fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-raised shadow-lg animate-rise focus:outline-none"
          >
            <D.Title className="sr-only">Command palette</D.Title>
            <D.Description className="sr-only">Search pages, clients, agents and actions</D.Description>
            <Command loop className="flex flex-col" label="Command palette">
              <div className="flex items-center gap-2.5 border-b border-line px-4">
                <Search className="size-4 text-ink-4" aria-hidden />
                <Command.Input
                  autoFocus
                  placeholder={placeholder}
                  className="h-12 w-full bg-transparent text-[14.5px] text-ink placeholder:text-ink-4 focus:outline-none"
                />
              </div>
              <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-4">
                <Command.Empty className="px-3 py-8 text-center text-[13px] text-ink-3">No results.</Command.Empty>
                {groups.map(([group, list]) => (
                  <Command.Group key={group} heading={group}>
                    {list.map((it) => (
                      <Command.Item
                        key={it.id}
                        value={`${it.label} ${it.group} ${it.id}`}
                        keywords={it.keywords}
                        onSelect={() => run(it)}
                        className="flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-ink-2 data-[selected=true]:bg-surface-2 data-[selected=true]:text-ink [&_svg]:size-4 [&_svg]:text-ink-3"
                      >
                        {it.icon}
                        <span className="truncate">{it.label}</span>
                        {it.hint ? <span className="ml-auto truncate pl-3 text-[12px] text-ink-4">{it.hint}</span> : null}
                        {it.shortcut ? (
                          <kbd className="ml-auto rounded border border-line bg-surface-2 px-1.5 font-mono text-[11px] text-ink-3">{it.shortcut}</kbd>
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
              <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-ink-4">
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
