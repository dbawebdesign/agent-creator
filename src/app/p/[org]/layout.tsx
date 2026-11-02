import type { Metadata } from "next";
import { Toaster } from "@/components/shared/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PortalShell } from "@/components/portal/shell";
import { getPortal } from "@/server/queries/portal";
import "@/components/portal/portal.css";

export async function generateMetadata({ params }: { params: Promise<{ org: string }> }): Promise<Metadata> {
  const { org } = await params;
  const p = await getPortal(org);
  return { title: { default: p.brand.name, template: `%s · ${p.brand.name}` } };
}

/** Readable text color on top of a hex accent. */
function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return l > 0.45 ? "#111113" : "#ffffff";
}

export default async function PortalLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  const style = p.brand.accent ? ({ "--brand": p.brand.accent, "--brand-ink": inkFor(p.brand.accent) } as React.CSSProperties) : undefined;
  return (
    <div className="portal-root" data-brand={p.brand.accent ? "" : undefined} style={style}>
      <TooltipProvider>
        <PortalShell
          slug={p.org.slug}
          brand={{ name: p.brand.name, logoUrl: p.brand.logoUrl, whiteLabel: p.brand.whiteLabel }}
          orgName={p.org.name}
          isCustomer={p.org.kind === "customer"}
          canResell={p.canResell}
          needsYouCount={p.needsYouCount}
          user={{ name: p.user.name, email: p.user.email }}
          viewingAs={p.viewingAs}
        >
          {children}
        </PortalShell>
      </TooltipProvider>
      <Toaster />
    </div>
  );
}
