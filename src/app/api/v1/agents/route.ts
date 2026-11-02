import { apiRoute, searchParams } from "@/server/api/http";
import { listAgents } from "@/server/api/v1";

export const dynamic = "force-dynamic";

/** GET /api/v1/agents — agents visible to this key (cursor paginated). */
export const GET = apiRoute<unknown>("agents:read", async ({ req, principal }) => ({
  body: await listAgents(principal, searchParams(req)),
}));
