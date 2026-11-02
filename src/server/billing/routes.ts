/**
 * Connect onboarding route logic (kept out of src/app so it can be tested with plain Request objects).
 *   GET /api/billing/connect?org=<id>&return=<path>        → 303 to a fresh Stripe Account Link (also Stripe's refresh_url)
 *   GET /api/billing/connect/return?org=<id>&next=<path>   → re-read the account from Stripe, 303 back into the app
 */
import "server-only";
import { z } from "zod";
import { requireOrgById } from "@/server/auth/access";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { connectOnboardingLink, refreshAccount } from "./service";
import { BillingError } from "./stripe";

const uuid = z.uuid();

function safePath(p: string | null): string {
  return p && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") && p.length <= 500 ? p : "/";
}

function back(path: string, flag?: string): Response {
  const u = new URL(path, env().APP_URL);
  if (flag) u.searchParams.set("billing", flag);
  return Response.redirect(u.toString(), 303);
}

function digest(err: unknown): string | undefined {
  const d = err && typeof err === "object" && "digest" in err ? (err as { digest?: unknown }).digest : undefined;
  return typeof d === "string" ? d : undefined;
}

function notFound() {
  return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
}

export async function connectRedirect(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const org = uuid.safeParse(url.searchParams.get("org"));
  const ret = safePath(url.searchParams.get("return"));
  if (!org.success) return notFound();
  try {
    const access = await requireOrgById(org.data, "admin");
    if (access.inherited && !access.user.isPlatformAdmin) return back(ret, "connect_forbidden");
    const link = await connectOnboardingLink(org.data, ret, { userId: access.user.id });
    return Response.redirect(link.url, 303);
  } catch (err) {
    const d = digest(err);
    if (d?.startsWith("NEXT_REDIRECT")) throw err;
    if (d?.startsWith("NEXT_HTTP_ERROR_FALLBACK") || d === "NEXT_NOT_FOUND") return notFound();
    if (err instanceof BillingError) return back(ret, err.code);
    logger.error({ err }, "connect redirect failed");
    return back(ret, "error");
  }
}

export async function connectReturn(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const org = uuid.safeParse(url.searchParams.get("org"));
  const next = safePath(url.searchParams.get("next"));
  if (!org.success) return notFound();
  try {
    await requireOrgById(org.data, "admin");
    const acct = await refreshAccount(org.data);
    return back(next, acct?.chargesEnabled ? "connected" : "pending");
  } catch (err) {
    const d = digest(err);
    if (d?.startsWith("NEXT_REDIRECT")) throw err;
    if (d?.startsWith("NEXT_HTTP_ERROR_FALLBACK") || d === "NEXT_NOT_FOUND") return notFound();
    return back(next, "error");
  }
}
