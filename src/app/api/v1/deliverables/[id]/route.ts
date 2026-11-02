import { apiRoute, uuidParam } from "@/server/api/http";
import { getDeliverable } from "@/server/api/v1";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/deliverables/:id */
export const GET = apiRoute<Ctx>("deliverables:read", async ({ principal, ctx }) => {
  const { id } = await ctx.params;
  return { body: { data: await getDeliverable(principal, uuidParam(id)) } };
});
