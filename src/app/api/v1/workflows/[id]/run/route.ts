import { apiRoute, uuidParam } from "@/server/api/http";
import { runWorkflow } from "@/server/api/v1";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/workflows/:id/run — queue a run now (202). */
export const POST = apiRoute<Ctx>("workflows:run", async ({ principal, ctx }) => {
  const { id } = await ctx.params;
  return { status: 202, body: { data: await runWorkflow(principal, uuidParam(id)) } };
});
