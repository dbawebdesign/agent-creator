import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils";

/** Minimal Slot: merges className/props onto its single child (for asChild). */
export function Slot({ children, className, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
  if (!isValidElement<{ className?: string }>(children)) return null;
  return cloneElement(children, { ...props, ...children.props, className: cn(className, children.props.className) });
}
