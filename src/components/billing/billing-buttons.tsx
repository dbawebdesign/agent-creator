"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { ArrowUpRight, CreditCard, Link2, RefreshCw } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { openBillingPortal, refreshStripeAccount, startCheckout, startStripeConnect, syncPlan } from "@/server/billing/actions";

type Common = { className?: string; variant?: ButtonProps["variant"]; size?: ButtonProps["size"]; children?: React.ReactNode };

function currentPath() {
  return typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
}

/** Buyer-side: opens Stripe Checkout for `planId` on the seller's account. */
export function SubscribeButton({ buyerOrgId, planId, returnPath, className, variant = "primary", size = "md", children }: Common & { buyerOrgId: string; planId: string; returnPath?: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      aria-busy={pending}
      onClick={() =>
        start(async () => {
          const r = await startCheckout(buyerOrgId, planId, { returnPath: returnPath ?? currentPath() });
          if (!r.ok) return void toast.error(r.error);
          window.location.assign(r.url);
        })
      }
    >
      <CreditCard />
      {pending ? "Opening checkout…" : (children ?? "Subscribe")}
    </Button>
  );
}

/** Seller-side (agency → client, client → customer): creates a checkout link and copies it to send. */
export function CheckoutLinkButton({ buyerOrgId, planId, returnPath, className, variant = "secondary", size = "md", children }: Common & { buyerOrgId: string; planId: string; returnPath?: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      aria-busy={pending}
      onClick={() =>
        start(async () => {
          const r = await startCheckout(buyerOrgId, planId, { returnPath: returnPath ?? currentPath() });
          if (!r.ok) return void toast.error(r.error);
          try {
            await navigator.clipboard.writeText(r.url);
            toast.success("Checkout link copied", { description: "Send it to your client. It stays valid for 24 hours." });
          } catch {
            toast("Checkout link", { description: r.url, duration: 30_000 });
          }
        })
      }
    >
      <Link2 />
      {pending ? "Creating link…" : (children ?? "Copy checkout link")}
    </Button>
  );
}

/** Buyer-side: Stripe customer portal (card, invoices, cancel). */
export function ManageBillingButton({ buyerOrgId, returnPath, className, variant = "secondary", size = "md", children }: Common & { buyerOrgId: string; returnPath?: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      aria-busy={pending}
      onClick={() =>
        start(async () => {
          const r = await openBillingPortal(buyerOrgId, returnPath ?? currentPath());
          if (!r.ok) return void toast.error(r.error);
          window.location.assign(r.url);
        })
      }
    >
      {pending ? "Opening…" : (children ?? "Manage billing")}
    </Button>
  );
}

/** Seller-side: push a plan's price to Stripe (also happens automatically at first checkout). */
export function SyncPlanButton({ planId, className, variant = "ghost", size = "sm", children }: Common & { planId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      aria-busy={pending}
      onClick={() =>
        start(async () => {
          const r = await syncPlan(planId, currentPath());
          if (!r.ok) return void toast.error(r.error);
          toast.success("Plan synced to Stripe");
        })
      }
    >
      <RefreshCw className={pending ? "animate-spin" : undefined} />
      {pending ? "Syncing…" : (children ?? "Sync to Stripe")}
    </Button>
  );
}

/** Seller-side: re-read Connect status from Stripe. */
export function RefreshConnectButton({ sellerOrgId, className }: { sellerOrgId: string; className?: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      disabled={pending}
      aria-busy={pending}
      onClick={() =>
        start(async () => {
          const r = await refreshStripeAccount(sellerOrgId, currentPath());
          if (!r.ok) return void toast.error(r.error);
          toast.success(r.chargesEnabled ? "Stripe is ready for payments" : "Stripe still needs a few details");
        })
      }
    >
      <RefreshCw className={pending ? "animate-spin" : undefined} />
      {pending ? "Checking…" : "Refresh"}
    </Button>
  );
}

/** Seller-side: start or resume Stripe Connect onboarding (navigates to Stripe). */
export function ConnectStripeButton({ sellerOrgId, returnPath, className, variant = "primary", size = "md", children }: Common & { sellerOrgId: string; returnPath?: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      aria-busy={pending}
      onClick={() =>
        start(async () => {
          const r = await startStripeConnect(sellerOrgId, returnPath ?? currentPath());
          if (!r.ok) return void toast.error(r.error);
          window.location.assign(r.url);
        })
      }
    >
      {pending ? "Opening Stripe…" : (children ?? "Connect Stripe")}
      {pending ? null : <ArrowUpRight />}
    </Button>
  );
}
