import { Slot } from "./slot";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-canvas hover:bg-ink-2 shadow-xs",
  accent: "bg-accent text-accent-ink hover:brightness-110 shadow-xs",
  secondary: "bg-surface text-ink border border-line hover:border-line-strong hover:bg-surface-2 shadow-xs",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-bad text-white hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-2 rounded-md",
  lg: "h-10 px-4 text-sm gap-2 rounded-lg",
  icon: "h-8 w-8 rounded-md",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string) {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background,border,color,filter,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({ variant = "secondary", size = "md", asChild, className, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={buttonClass(variant, size, className)} {...props} />;
}
