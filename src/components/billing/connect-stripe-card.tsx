import { ArrowUpRight, Check } from "lucide-react";
import { hasRole, requireOrgById } from "@/server/auth/access";
import { getBillingStatus } from "@/server/billing/service";
import { buttonClass } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { BillingModeBadge } from "./billing-status-badge";
import { RefreshConnectButton } from "./billing-buttons";

/**
 * Seller payouts: Stripe Connect status + "Connect Stripe". Server component.
 * Mount on Studio → Billing (sellerOrgId = agency id) and Portal → Resell (sellerOrgId = client id).
 */
export async function ConnectStripeCard({ sellerOrgId, returnPath, className }: { sellerOrgId: string; returnPath: string; className?: string }) {
  const access = await requireOrgById(sellerOrgId, "viewer");
  const status = await getBillingStatus(sellerOrgId);
  const s = status.seller;
  const canConnect = hasRole(access, "admin") && (!access.inherited || access.user.isPlatformAdmin);
  const href = `/api/billing/connect?org=${encodeURIComponent(sellerOrgId)}&return=${encodeURIComponent(returnPath)}`;
  const ready = !!s?.chargesEnabled;
  const started = !!s?.connected;
  const description =
    status.mode === "disabled"
      ? "Billing runs in test mode until Stripe is configured for this workspace. Plans and subscriptions still work; nobody is charged."
      : ready
        ? `Payments go straight to your Stripe account${s?.accountHint ? ` (${s.accountHint})` : ""}. Flat monthly rate, billed by Stripe.`
        : started
          ? "Stripe needs a few more details before you can take payments."
          : `Connect a Stripe account so ${status.org.kind === "agency" ? "clients" : "customers"} pay you directly each month.`;

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader
        title="Payouts"
        description={description}
        action={
          <div className="flex items-center gap-2">
            <BillingModeBadge mode={status.mode} />
            {started && status.mode !== "disabled" && hasRole(access, "admin") ? <RefreshConnectButton sellerOrgId={sellerOrgId} /> : null}
          </div>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-5 py-3.5">
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px]">
          <Step done={started} label="Account connected" />
          <Step done={!!s?.detailsSubmitted} label="Details submitted" />
          <Step done={ready} label="Charges enabled" />
          <Step done={!!s?.payoutsEnabled} label="Payouts enabled" />
        </ul>
        {status.mode === "disabled" ? (
          <span className="text-[12.5px] text-ink-4">Set STRIPE_SECRET_KEY to connect</span>
        ) : canConnect && !ready ? (
          <a href={href} className={buttonClass("primary", "md")}>
            {started ? "Finish Stripe setup" : "Connect Stripe"}
            <ArrowUpRight />
          </a>
        ) : canConnect && ready ? (
          <a href={href} className={buttonClass("ghost", "sm", "text-ink-3")}>
            Update details
            <ArrowUpRight />
          </a>
        ) : !ready ? (
          <span className="text-[12.5px] text-ink-4">An admin of {status.org.name} can connect Stripe</span>
        ) : null}
      </div>
    </Card>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={cn("inline-flex items-center gap-1.5", done ? "text-ink-2" : "text-ink-4")}>
      {done ? <Check className="size-3.5 text-good" aria-hidden /> : <span className="size-1.5 rounded-full bg-ink-4/60" aria-hidden />}
      {label}
      <span className="sr-only">{done ? "(done)" : "(not yet)"}</span>
    </li>
  );
}
