import { handleKnowledgeUpload } from "@/server/files/upload-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  return handleKnowledgeUpload(req, orgId);
}
