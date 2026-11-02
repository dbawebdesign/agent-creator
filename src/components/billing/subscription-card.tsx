import { hasRole, requireOrgById } from "@/server/auth/access";
import { getBillingStatus } from "@/server/billing/service";
import { Card, CardHeader } from "@/components/ui/card";
import { cn, formatMoney } from "@/lib/utils";
import { BillingModeBadge, BillingStatusBadge } from "./billing-status-badge";
import { ManageBillingButton, SubscribeButton } from "./billing-buttons";

function date(d: Date) {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Buyer view of its own subscription: plan, flat price, status, renewal, "Manage billing". Server component.
 * Mount on Portal → Settings (buyerOrgId = the portal org). On Studio → Client detail it renders read-only
 * (seller staff get no pay/manage buttons); pair it with CheckoutLinksCard there.
 * Clients never see cost/usage here — only their flat rate.
 */
export async function SubscriptionCard({
  buyerOrgId,
  returnPath,
  className,
  title = "Plan & billing",
}: {
  buyerOrgId: string;
  returnPath: string;
  className?: string;
  title?: string;
}) {
  const access = await requireOrgById(buyerOrgId, "viewer");
  const status = await getBillingStatus(buyerOrgId);
  const sub = status.buyer?.subscription ?? null;
  const live = sub && sub.status !== "canceled" ? sub : null;
  // Paying and the customer portal belong to the buyer's own admins; seller staff use CheckoutLinksCard.
  const admin =
    hasRole(access, "admin") &&
    (!access.inherited || access.user.isPlatformAdmin);
  const canManage =
    admin && status.mode !== "disabled" && !!status.buyer?.hasBillingProfile;
  // A manually recorded plan (pre-Stripe) can move to card billing once the seller has connected Stripe.
  const canSetUpPayment =
    admin && !!status.buyer?.sellerReady && !!live && !live.stripeManaged;

  let line: string;
  if (!live)
    line = sub
      ? `Your ${sub.planName} plan ended${sub.currentPeriodEnd ? ` on ${date(sub.currentPeriodEnd)}` : ""}.`
      : "No plan yet. Your provider will send you a checkout link.";
  else if (live.cancelAtPeriodEnd && live.currentPeriodEnd)
    line = `Ends on ${date(live.currentPeriodEnd)}. You won't be charged again.`;
  else if (live.status === "past_due")
    line =
      "The last payment didn't go through. Update your card to keep your AI employees working.";
  else if (live.currentPeriodEnd)
    line = `Renews on ${date(live.currentPeriodEnd)}.`;
  else
    line = live.stripeManaged
      ? "Billed monthly."
      : "Billed monthly by invoice.";

  return (
    <Card className={cn(className)}>
      <CardHeader
        title={title}
        description={
          status.mode === "disabled"
            ? "Stripe isn't connected yet, so no card is needed and nobody is charged."
            : undefined
        }
        action={<BillingModeBadge mode={status.mode} />}
      />
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-ink">
              {sub ? sub.planName : "No plan"}
            </p>
            <BillingStatusBadge
              status={sub?.status}
              cancelAtPeriodEnd={sub?.cancelAtPeriodEnd}
            />
          </div>
          {sub ? (
            <p className="tabular mt-1 text-[13px] text-ink-2">
              {formatMoney(sub.priceCents, sub.currency)}
              <span className="text-ink-3">
                {" "}
                / month · flat rate, no usage fees
              </span>
            </p>
          ) : null}
          <p
            className={cn(
              "mt-1 text-[12.5px]",
              live?.status === "past_due" ? "text-warn" : "text-ink-3",
            )}
          >
            {line}
          </p>
        </div>
        {canSetUpPayment ? (
          <SubscribeButton
            buyerOrgId={buyerOrgId}
            planId={live!.planId}
            returnPath={returnPath}
          >
            Set up payment
          </SubscribeButton>
        ) : canManage ? (
          <ManageBillingButton
            buyerOrgId={buyerOrgId}
            returnPath={returnPath}
            variant={live?.status === "past_due" ? "primary" : "secondary"}
          />
        ) : null}
      </div>
    </Card>
  );
}
