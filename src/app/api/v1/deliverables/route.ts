import { apiRoute, searchParams } from "@/server/api/http";
import { listDeliverables } from "@/server/api/v1";

export const dynamic = "force-dynamic";

/** GET /api/v1/deliverables?agentId=&since=&status=&limit=&cursor= */
export const GET = apiRoute<unknown>("deliverables:read", async ({ req, principal }) => ({
  body: await listDeliverables(principal, searchParams(req)),
}));
