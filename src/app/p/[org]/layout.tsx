import type { Metadata } from "next";
import { Toaster } from "@/components/shared/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PortalShell } from "@/components/portal/shell";
import { getPortal } from "@/server/queries/portal";
import "@/components/portal/portal.css";
import { brandVars } from "@/components/portal/brand-color";

export async function generateMetadata({ params }: { params: Promise<{ org: string }> }): Promise<Metadata> {
  const { org } = await params;
  const p = await getPortal(org);
  return { title: { default: p.brand.name, template: `%s · ${p.brand.name}` } };
}

/** Readable text color on top of a hex accent. */

export default async function PortalLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  // accent is validated as #rrggbb in resolveBrand, so this CSS can't carry anything else.
  const brandCss = p.brand.accent ? brandVars(p.brand.accent) : null;
  return (
    <div className="portal-root" data-brand={brandCss ? "" : undefined}>
      {brandCss ? <style>{brandCss}</style> : null}
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
