import { handleResendWebhook } from "@/server/channels/webhook-routes";

export const dynamic = "force-dynamic";

/** Resend webhooks (Svix-signed): inbound email (email.received) and delivery status events. */
export async function POST(req: Request) {
  return handleResendWebhook(req);
}
