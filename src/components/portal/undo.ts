"use client";

import { toast } from "sonner";

export const UNDO_MS = 5000;

/**
 * Hold an outward action (sending an email, acting on someone's behalf) for a few seconds behind Undo.
 * Nothing reaches the server until the hold expires. Closing the tab during the hold asks first, and if the
 * person leaves anyway nothing is sent — the safe failure. The caller shows the one inline "Sending… Undo"
 * state; pass `toast: true` only where there's no inline state to show.
 */
export function holdWithUndo(opts: {
  title: string;
  description?: string;
  commit: () => void | Promise<void>;
  onUndo?: () => void;
  toast?: boolean;
}): () => void {
  let settled = false;
  const guard = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };
  window.addEventListener("beforeunload", guard);
  const release = () => window.removeEventListener("beforeunload", guard);

  const undo = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    release();
    if (id !== undefined) toast.dismiss(id);
    opts.onUndo?.();
  };

  const id = opts.toast
    ? toast(opts.title, {
        description: opts.description,
        duration: UNDO_MS,
        action: { label: "Undo", onClick: undo },
      })
    : undefined;

  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    release();
    void opts.commit();
  }, UNDO_MS);

  return undo;
}
