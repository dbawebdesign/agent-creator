import Link from "next/link";
import { Logo } from "@/components/shared/logo";
import { Toaster } from "@/components/shared/toaster";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-16 items-center px-6">
        <Link href="/" aria-label="Roster home" className="rounded-md">
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="w-full max-w-[360px] animate-rise">{children}</div>
      </main>
      <Toaster />
    </div>
  );
}
