"use client";

import { DropdownMenu as M } from "radix-ui";
import { cn } from "@/lib/utils";

/** Dropdown menu (Radix). */
export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ className, align = "start", side, sideOffset = 6, ...props }: M.DropdownMenuContentProps) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-52 rounded-lg border border-line bg-raised p-1 text-[13px] shadow-md animate-fade-in",
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({ className, ...props }: M.DropdownMenuItemProps) {
  return (
    <M.Item
      className={cn(
        "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-ink-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-ink-3",
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: M.DropdownMenuLabelProps) {
  return <M.Label className={cn("px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-ink-4", className)} {...props} />;
}

export function MenuSeparator({ className }: { className?: string }) {
  return <M.Separator className={cn("my-1 h-px bg-line", className)} />;
}
