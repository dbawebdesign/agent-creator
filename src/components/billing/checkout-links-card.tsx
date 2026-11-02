import { and, eq } from "drizzle-orm";
import { hasRole, requireOrgById } from "@/server/auth/access";
import { db, schema } from "@/server/db/client";
import { getBillingStatus } from "@/server/billing/service";
import { Card, CardHeader } from "@/components/ui/card";
import { cn, formatMoney } from "@/lib/utils";
import { BillingStatusBadge } from "./billing-status-badge";
import { CheckoutLinkButton } from "./billing-buttons";

/**
 * Seller view of one buyer: current subscription status + "Copy checkout link" for each plan the seller has on
 * sale. Server component. Mount on Studio → Client detail (buyerOrgId = client) and Portal → Resell for each
 * customer (buyerOrgId = customer). Renders nothing unless the viewer is an admin of the seller (inherited access).
 */
export async function CheckoutLinksCard({
  buyerOrgId,
  returnPath,
  className,
}: {
  buyerOrgId: string;
  returnPath: string;
  className?: string;
}) {
  const access = await requireOrgById(buyerOrgId, "viewer");
  // Seller-side only: the buyer's own admins use SubscriptionCard instead.
  if (
    !hasRole(access, "admin") ||
    !access.org.parentId ||
    (!access.inherited && !access.user.isPlatformAdmin)
  )
    return null;
  const [status, plans] = await Promise.all([
    getBillingStatus(buyerOrgId),
    db()
      .select()
      .from(schema.plans)
      .where(
        and(
          eq(schema.plans.orgId, access.org.parentId),
          eq(schema.plans.active, true),
        ),
      ),
  ]);
  const sub = status.buyer?.subscription ?? null;
  const ready = !!status.buyer?.sellerReady;
  const stripeLive = sub && sub.stripeManaged && sub.status !== "canceled";

  return (
    <Card className={cn(className)}>
      <CardHeader
        title="Billing"
        description={
          status.mode === "disabled"
            ? "Payments aren't set up yet. Checkout links appear once they are."
            : !ready
              ? "Connect Stripe on your Billing page to send checkout links."
              : stripeLive
                ? `Paying by card through Stripe.`
                : `Send ${access.org.name} a checkout link. They pay you directly, monthly.`
        }
        action={
          <BillingStatusBadge
            status={sub?.status}
            cancelAtPeriodEnd={sub?.cancelAtPeriodEnd}
            className="shrink-0 whitespace-nowrap"
          />
        }
      />
      {plans.length === 0 ? (
        <p className="border-t border-line px-5 py-4 text-[13px] text-ink-3">
          No plans on sale yet. Create one to start billing.
        </p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {plans.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
            >
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-ink">{p.name}</p>
                <p className="tabular text-[12.5px] text-ink-3">
                  {formatMoney(p.priceCents, p.currency)} / month
                  {p.setupFeeCents
                    ? ` · ${formatMoney(p.setupFeeCents, p.currency)} setup`
                    : " · no setup fee"}
                </p>
              </div>
              {ready && !(stripeLive && sub?.planId === p.id) ? (
                <CheckoutLinkButton
                  buyerOrgId={buyerOrgId}
                  planId={p.id}
                  returnPath={returnPath}
                  size="sm"
                />
              ) : stripeLive && sub?.planId === p.id ? (
                <span className="text-[12.5px] text-ink-4">Current plan</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
