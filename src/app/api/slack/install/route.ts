import type { NextRequest } from "next/server";
import { handleSlackInstall } from "@/server/channels/slack-routes";

export const dynamic = "force-dynamic";

/** GET /api/slack/install?org=<orgId>[&returnTo=/p/<slug>/…] — requires a signed-in org admin. */
export async function GET(req: NextRequest) {
  return handleSlackInstall(req);
}
