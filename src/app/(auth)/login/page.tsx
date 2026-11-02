import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { homePathFor } from "@/server/auth/access";
import { getCurrentUser } from "@/server/auth/session";
import { SignInForm } from "../auth-forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const user = await getCurrentUser();
  if (user) redirect(await homePathFor(user.id));
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Sign in to Roster</h1>
      <p className="mt-1.5 mb-7 text-[14px] text-ink-3">Welcome back. Your team has been busy.</p>
      <SignInForm next={next} />
      <div className="my-6 flex items-center gap-3 text-[12px] text-ink-3">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <Link
        href={next ? `/magic-link?next=${encodeURIComponent(next)}` : "/magic-link"}
        className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-line bg-surface text-sm font-medium text-ink shadow-xs transition-colors hover:border-line-strong hover:bg-surface-2"
      >
        Email me a sign-in link
      </Link>
      <p className="mt-8 text-center text-[13px] text-ink-3">
        New to Roster?{" "}
        <Link href="/signup" className="font-medium text-ink underline-offset-2 hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
