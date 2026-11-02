import type { Metadata } from "next";
import Link from "next/link";
import { MagicLinkForm } from "../auth-forms";

export const metadata: Metadata = { title: "Sign in with email" };

export default async function MagicLinkPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div>
      <MagicLinkForm next={next} />
      <p className="mt-8 text-center text-[13px] text-ink-3">
        <Link href="/login" className="font-medium text-ink underline-offset-2 hover:underline">
          Sign in with a password
        </Link>
      </p>
    </div>
  );
}
