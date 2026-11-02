import { handleMcpPost } from "@/server/api/mcp";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * MCP endpoint (streamable HTTP, stateless, JSON responses). Auth: `Authorization: Bearer rk_live_…`.
 * Add to Claude Code: claude mcp add --transport http roster <APP_URL>/api/mcp --header "Authorization: Bearer rk_live_…"
 */
export async function POST(req: Request) {
  return handleMcpPost(req, env().APP_URL);
}

/** No server-initiated SSE stream: stateless server. */
export async function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

/** No sessions to terminate. */
export async function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
