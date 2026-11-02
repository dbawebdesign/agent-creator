import type { NextRequest } from "next/server";
import { handleSlackCallback } from "@/server/channels/slack-routes";

export const dynamic = "force-dynamic";

/** GET /api/slack/oauth/callback — Slack redirects here after the admin approves the install. */
export async function GET(req: NextRequest) {
  return handleSlackCallback(req);
}
