import { apiRoute, readJson, uuidParam } from "@/server/api/http";
import { sendMessage } from "@/server/api/v1";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/agents/:id/messages — { text, conversationId?, wait? }.
 * wait=true runs the agent inline (bounded) and returns 200 with `reply`; otherwise 202 (queued).
 */
export const POST = apiRoute<Ctx>("agents:invoke", async ({ req, principal, ctx }) => {
  const { id } = await ctx.params;
  const agentId = uuidParam(id);
  const res = await sendMessage(principal, agentId, await readJson(req));
  return { status: res.status, body: { data: res.body } };
});
