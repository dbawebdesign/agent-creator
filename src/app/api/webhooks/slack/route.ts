import { handleSlackWebhook } from "@/server/channels/webhook-routes";

export const dynamic = "force-dynamic";

/** Slack Events API (v0 signature): url_verification, app_mention, message.im. */
export async function POST(req: Request) {
  return handleSlackWebhook(req);
}
