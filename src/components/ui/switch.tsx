"use client";

import { Switch as S } from "radix-ui";
import { cn } from "@/lib/utils";

/** Small toggle switch. */
export function Switch({ className, ...props }: S.SwitchProps) {
  return (
    <S.Root
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-line-strong transition-colors duration-150 data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <S.Thumb className="pointer-events-none block size-3.5 translate-x-[2px] rounded-full bg-white shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-[16px]" />
    </S.Root>
  );
}
