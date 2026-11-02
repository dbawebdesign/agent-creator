import { connectReturn } from "@/server/billing/routes";

export const dynamic = "force-dynamic";

/** Stripe onboarding return_url: refresh the connected account's state, then 303 back into the app. */
export async function GET(req: Request) {
  return connectReturn(req);
}
