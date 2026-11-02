import { apiRoute, uuidParam } from "@/server/api/http";
import { getAgent } from "@/server/api/v1";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/agents/:id — one agent with its workflows. */
export const GET = apiRoute<Ctx>("agents:read", async ({ principal, ctx }) => {
  const { id } = await ctx.params;
  return { body: { data: await getAgent(principal, uuidParam(id)) } };
});
