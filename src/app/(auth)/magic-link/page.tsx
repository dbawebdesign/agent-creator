import { AuthShell } from "@/app/(auth)/auth-shell";
import { authBrand } from "@/app/(auth)/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { MagicLinkForm } from "../auth-forms";

export const metadata: Metadata = { title: "Sign in with email" };

async function MagicLinkPageInner({ searchParams }: { searchParams: Promise<{ next?: string; org?: string }>; brand: unknown }) {
  const { next } = await searchParams;
  return (
    <div>
      <MagicLinkForm next={next} />
      <p className="mt-8 text-center text-[13px] text-ink-3">
        <Link href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="font-medium text-ink underline-offset-2 hover:underline">
          Sign in with a password
        </Link>
      </p>
    </div>
  );
}

export default async function MagicLinkPage(props: { searchParams: Promise<{ next?: string; org?: string }> }) {
  const sp = await props.searchParams;
  const brand = await authBrand({ next: sp.next, org: sp.org });
  return (
    <AuthShell brand={brand}>
      <MagicLinkPageInner {...props} brand={brand} />
    </AuthShell>
  );
}
