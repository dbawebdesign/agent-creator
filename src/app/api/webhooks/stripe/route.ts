import { handleStripeWebhook } from "@/server/billing/webhook";

export const dynamic = "force-dynamic";

/**
 * Stripe webhooks (platform + Connect endpoints). Signature verified on the raw body with
 * stripe.webhooks.constructEvent (STRIPE_WEBHOOK_SECRET / STRIPE_CONNECT_WEBHOOK_SECRET); idempotent via webhook_events.
 */
export async function POST(req: Request) {
  return handleStripeWebhook(req);
}
