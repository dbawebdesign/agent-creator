import Link from "next/link";
import type { PortalBrand } from "@/server/queries/portal";
import { Logo } from "@/components/shared/logo";

/** Auth page frame: the client's brand when the flow is for a client/customer, Roster otherwise. */
export function AuthShell({ brand, children }: { brand: PortalBrand | null; children: React.ReactNode }) {
  const style = brand?.accent ? ({ "--accent": brand.accent, "--color-accent": brand.accent } as React.CSSProperties) : undefined;
  return (
    <div className="flex min-h-dvh flex-col" style={style}>
      <header className="flex h-16 items-center px-6">
        {brand ? (
          <span className="inline-flex items-center gap-2.5">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logoUrl} alt="" className="size-7 rounded-md object-contain" />
            ) : (
              <span className="flex size-7 items-center justify-center rounded-md bg-accent text-[13px] font-semibold text-accent-ink" aria-hidden>
                {brand.name.trim()[0]?.toUpperCase()}
              </span>
            )}
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{brand.name}</span>
          </span>
        ) : (
          <Link href="/" aria-label="Roster home" className="rounded-md">
            <Logo />
          </Link>
        )}
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="w-full max-w-[360px] animate-rise">{children}</div>
      </main>
      {brand && !brand.whiteLabel ? <p className="pb-6 text-center text-[11.5px] text-ink-3">Powered by Roster</p> : null}
    </div>
  );
}
