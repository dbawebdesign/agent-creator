import { handleTwilioWebhook } from "@/server/channels/webhook-routes";

export const dynamic = "force-dynamic";

/** Twilio inbound SMS (X-Twilio-Signature). Responds with empty TwiML; replies are sent asynchronously. */
export async function POST(req: Request) {
  return handleTwilioWebhook(req);
}
