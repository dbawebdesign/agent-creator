/**
 * Slack OAuth v2 install + callback route logic.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveAccess, type Role } from "@/server/auth/access";
import { clientIp, getCurrentUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { eq } from "drizzle-orm";
import { logger } from "@/server/lib/logger";
import {
  SLACK_NONCE_COOKIE,
  SlackInstallError,
  appUrl,
  exchangeSlackCode,
  safeReturnPath,
  saveSlackInstall,
  signSlackState,
  slackAuthorizeUrl,
  verifySlackState,
} from "./slack";

const ADMIN: Role[] = ["owner", "admin"];

function notFound() {
  return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}

/** Where to land after install when no return path was given. UI owners: change here if routes differ. */
export function defaultChannelsPath(org: { kind: string; slug: string }): string {
  return org.kind === "agency" ? `/a/${org.slug}/settings` : `/p/${org.slug}/connect`;
}

function back(path: string, result: string): NextResponse {
  const u = new URL(path, appUrl());
  u.searchParams.set("slack", result);
  const res = NextResponse.redirect(u, 303);
  res.cookies.set(SLACK_NONCE_COOKIE, "", { path: "/api/slack", maxAge: 0 });
  return res;
}

export async function handleSlackInstall(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const orgId = z.uuid().safeParse(url.searchParams.get("org"));
  if (!orgId.success) return notFound();
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", appUrl()), 303);
  const access = await resolveAccess(user, orgId.data);
  if (!access || !ADMIN.includes(access.role)) return notFound();

  const returnTo = safeReturnPath(url.searchParams.get("returnTo")) ?? defaultChannelsPath(access.org);
  const { state, nonce } = signSlackState({ orgId: access.org.id, userId: user.id, returnTo });
  const authorize = slackAuthorizeUrl(state);
  if (!authorize) return back(returnTo, "unconfigured");
  const res = NextResponse.redirect(authorize, 303);
  res.cookies.set(SLACK_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: appUrl().startsWith("https://"),
    sameSite: "lax",
    path: "/api/slack",
    maxAge: 600,
  });
  return res;
}

export async function handleSlackCallback(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const state = verifySlackState(url.searchParams.get("state"), req.cookies.get(SLACK_NONCE_COOKIE)?.value);
  if (!state) {
    return new NextResponse("This Slack connection link expired or was already used. Start again from Settings → Channels.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const user = await getCurrentUser();
  if (!user || user.id !== state.userId) return notFound();
  const access = await resolveAccess(user, state.orgId);
  if (!access || !ADMIN.includes(access.role)) return notFound();
  const returnTo = state.returnTo ?? defaultChannelsPath(access.org);

  if (url.searchParams.get("error")) return back(returnTo, "denied");
  const code = url.searchParams.get("code");
  if (!code || code.length > 500) return back(returnTo, "error");

  try {
    const oauth = await exchangeSlackCode(code);
    await saveSlackInstall({ orgId: access.org.id, userId: user.id, access: oauth, ip: clientIp(req.headers) });
    return back(returnTo, "connected");
  } catch (err) {
    if (err instanceof SlackInstallError && err.code === "conflict") return back(returnTo, "conflict");
    logger.error({ orgId: access.org.id, error: err instanceof Error ? err.message : "unknown" }, "slack: install failed");
    return back(returnTo, "error");
  }
}

/** Org lookup helper for UI builders who want the default return path. */
export async function channelsPathFor(orgId: string): Promise<string | null> {
  const [org] = await db().select({ kind: schema.organizations.kind, slug: schema.organizations.slug }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  return org ? defaultChannelsPath(org) : null;
}
