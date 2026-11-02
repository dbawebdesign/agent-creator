"use client";

import { toast } from "sonner";

export const UNDO_MS = 5000;

/**
 * Hold an outward action (sending an email, acting on someone's behalf) for a few seconds behind a toast
 * with Undo. Nothing reaches the server until the hold expires. Closing the tab during the hold asks first,
 * and if the person leaves anyway nothing is sent — the safe failure.
 */
export function holdWithUndo(opts: {
  title: string;
  description?: string;
  commit: () => void | Promise<void>;
  onUndo?: () => void;
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
    toast.dismiss(id);
    opts.onUndo?.();
    toast("Cancelled. Nothing was sent.");
  };

  const id = toast(opts.title, {
    description: opts.description,
    duration: UNDO_MS,
    action: { label: "Undo", onClick: undo },
  });

  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    release();
    void opts.commit();
  }, UNDO_MS);

  return undo;
}
