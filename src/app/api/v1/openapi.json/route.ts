import { openApiDocument } from "@/server/api/openapi";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

/** GET /api/v1/openapi.json — public, unauthenticated description of the API. */
export async function GET() {
  return Response.json(openApiDocument(env().APP_URL), {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
