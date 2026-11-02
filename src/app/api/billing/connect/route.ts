import { connectRedirect } from "@/server/billing/routes";

export const dynamic = "force-dynamic";

/** Start (or resume) Stripe Connect onboarding for a seller org: 303 → Stripe-hosted onboarding. */
export async function GET(req: Request) {
  return connectRedirect(req);
}
