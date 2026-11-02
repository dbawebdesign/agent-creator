import Link from "next/link";
import { LogoMark } from "@/components/shared/logo";
import { buttonClass } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center">
      <LogoMark size={28} />
      <p className="tabular mt-6 text-[13px] font-medium text-ink-4">404</p>
      <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink">This page doesn’t exist</h1>
      <p className="mt-2 text-[14px] text-ink-3">Or you don’t have access to it.</p>
      <Link href="/" className={buttonClass("secondary", "md", "mt-6")}>
        Go home
      </Link>
    </div>
  );
}
