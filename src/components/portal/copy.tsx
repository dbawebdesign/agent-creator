"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts (e.g. LAN dev hosts).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Icon (or labeled) copy button with a brief check-mark confirmation. */
export function CopyButton({
  value,
  label,
  className,
  toastLabel,
  children,
}: {
  value: string;
  label: string;
  className?: string;
  toastLabel?: string;
  children?: React.ReactNode;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        const ok = await writeClipboard(value);
        if (!ok)
          return toast.error("Couldn't copy — select and copy it instead");
        setDone(true);
        if (toastLabel) toast.success(toastLabel);
        setTimeout(() => setDone(false), 1600);
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink",
        children ? "h-8 px-2.5 text-[13px] font-medium" : "size-8",
        className,
      )}
    >
      {done ? (
        <Check className="size-4 text-good" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
      {children ? <span>{done ? "Copied" : children}</span> : null}
      <span className="sr-only" role="status">
        {done ? "Copied" : ""}
      </span>
    </button>
  );
}

/** A value on one line (email, number, key) with a copy button. */
export function CopyField({
  value,
  label,
  mono,
  className,
}: {
  value: string;
  label: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-10 min-w-0 items-center gap-1 rounded-lg border border-line bg-surface-2/60 pr-1 pl-3",
        className,
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13.5px] text-ink-2 select-all",
          mono && "font-mono text-[12.5px]",
        )}
      >
        {value}
      </span>
      <CopyButton value={value} label={label} toastLabel="Copied" />
    </div>
  );
}
