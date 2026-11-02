"use client";

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Accessible modal dialog (Radix). Calm: hairline border, soft shadow, rises in. */
export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  wide,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] animate-fade-in dark:bg-black/50" />
      <D.Content
        className={cn(
          "fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-line bg-raised shadow-lg animate-rise focus:outline-none",
          wide ? "max-w-xl" : "max-w-md",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-1">
          <div className="min-w-0">
            <D.Title className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-[13px] text-ink-3">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
            )}
          </div>
          <D.Close
            className="-mt-1 -mr-1 flex size-7 items-center justify-center rounded-md text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="px-5 pt-3 pb-5">{children}</div>
      </D.Content>
    </D.Portal>
  );
}
