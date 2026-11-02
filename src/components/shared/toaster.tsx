"use client";

import { Toaster as Sonner } from "sonner";

/** App-wide toasts. Mount once per surface layout. Use `toast()` from "sonner". */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      gap={8}
      toastOptions={{
        unstyled: false,
        classNames: {
          toast:
            "!rounded-lg !border !border-line !bg-raised !text-ink !shadow-md !text-[13px] !font-sans !gap-2.5",
          description: "!text-ink-3",
          actionButton: "!bg-ink !text-canvas",
          success: "[&_[data-icon]]:!text-good",
          error: "[&_[data-icon]]:!text-bad",
        },
      }}
    />
  );
}
