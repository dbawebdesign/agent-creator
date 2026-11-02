import { Badge } from "@/components/ui/badge";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

const LABEL: Record<SubscriptionStatus, string> = { active: "Active", trialing: "Trial", past_due: "Past due", canceled: "Canceled" };
const TONE = { active: "good", trialing: "accent", past_due: "warn", canceled: "neutral" } as const;

/** Subscription status pill. `cancelAtPeriodEnd` shows "Cancels at period end" for an active subscription. */
export function BillingStatusBadge({ status, cancelAtPeriodEnd, className }: { status: SubscriptionStatus | null | undefined; cancelAtPeriodEnd?: boolean; className?: string }) {
  if (!status) return <Badge className={className}>No plan</Badge>;
  if (cancelAtPeriodEnd && status !== "canceled") {
    return (
      <Badge tone="warn" dot className={className}>
        Cancels at period end
      </Badge>
    );
  }
  return (
    <Badge tone={TONE[status]} dot className={className}>
      {LABEL[status]}
    </Badge>
  );
}

/** Mode marker: "Test mode" (Stripe not connected to the platform) or "Stripe test mode" (sk_test key). */
export function BillingModeBadge({ mode }: { mode: "disabled" | "test" | "live" }) {
  if (mode === "live") return null;
  return (
    <Badge tone={mode === "test" ? "accent" : "neutral"} className="shrink-0 whitespace-nowrap">
      {mode === "test" ? "Stripe test mode" : "Test mode"}
    </Badge>
  );
}
