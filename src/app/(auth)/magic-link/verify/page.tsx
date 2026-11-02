import { AuthShell } from "@/app/(auth)/auth-shell";
import { authBrand } from "@/app/(auth)/brand";
import type { Metadata } from "next";
import { VerifyMagicLinkForm } from "../../auth-forms";

export const metadata: Metadata = { title: "Confirm sign-in" };

async function VerifyPageInner({ searchParams }: { searchParams: Promise<{ token?: string; next?: string; org?: string }>; brand: unknown }) {
  const { token, next } = await searchParams;
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Confirm it’s you</h1>
      <p className="mt-1.5 mb-7 text-[14px] text-ink-3">One click and you’re in. This link works once.</p>
      {token ? <VerifyMagicLinkForm token={token} next={next} /> : <p className="text-[13px] text-bad">This link is missing its token.</p>}
    </div>
  );
}

export default async function VerifyPage(props: { searchParams: Promise<{ token?: string; next?: string; org?: string }> }) {
  const sp = await props.searchParams;
  const brand = await authBrand({ next: sp.next, org: sp.org });
  return (
    <AuthShell brand={brand}>
      <VerifyPageInner {...props} brand={brand} />
    </AuthShell>
  );
}
