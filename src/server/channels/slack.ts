/**
 * Slack channel: OAuth v2 install (bot token stored encrypted in `secrets`), Events API intake and
 * chat.postMessage replies in-thread.
 *
 * OAuth CSRF/open-redirect defenses:
 *  - `state` is HMAC-signed (AUTH_SECRET), carries org, user, nonce, expiry (10 min) and a return path.
 *  - the nonce is also set as an httpOnly cookie on install and must match on callback (binds the flow to the
 *    browser that started it), and the callback re-checks the signed-in user still has admin on the org.
 *  - redirect_uri is fixed to APP_URL; the return path must be a same-origin /a/… or /p/… path.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";
import { decrypt, encrypt, randomToken, safeEqual } from "@/server/security/crypto";
import { ProviderError, type SendResult } from "./email";

export const SLACK_SCOPES = ["app_mentions:read", "chat:write", "im:history", "im:read", "im:write", "users:read", "incoming-webhook"];
export const SLACK_NONCE_COOKIE = "roster_slack_nonce";
const STATE_TTL_MS = 10 * 60_000;

function stateKey(): string {
  const secret = env().AUTH_SECRET ?? "roster-dev-auth-secret";
  return createHmac("sha256", secret).update("slack-oauth-state/v1").digest("hex");
}

export function appUrl(): string {
  return env().APP_URL.replace(/\/+$/, "");
}

export function slackRedirectUri(): string {
  return `${appUrl()}/api/slack/oauth/callback`;
}

/** Only same-origin app paths under /a/ or /p/ — never absolute or protocol-relative URLs. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 300) return null;
  if (!/^\/(a|p)\/[a-z0-9][a-z0-9-]{0,62}(\/[A-Za-z0-9._~\-/]*)?(\?[A-Za-z0-9._~\-=&]*)?$/.test(raw)) return null;
  if (raw.includes("//") || raw.includes("\\") || raw.includes("..")) return null;
  try {
    const u = new URL(raw, appUrl());
    if (u.origin !== new URL(appUrl()).origin) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

export type SlackState = { orgId: string; userId: string; nonce: string; exp: number; returnTo: string | null };

export function signSlackState(input: { orgId: string; userId: string; returnTo?: string | null; now?: number }): { state: string; nonce: string } {
  const nonce = randomToken(16);
  const payload: SlackState = {
    orgId: input.orgId,
    userId: input.userId,
    nonce,
    exp: (input.now ?? Date.now()) + STATE_TTL_MS,
    returnTo: safeReturnPath(input.returnTo ?? null),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return { state: `${body}.${sig}`, nonce };
}

export function verifySlackState(state: string | null, nonceCookie: string | null | undefined, now = Date.now()): SlackState | null {
  if (!state || state.length > 2000 || !nonceCookie) return null;
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", stateKey()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  let parsed: SlackState;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SlackState;
  } catch {
    return null;
  }
  if (typeof parsed.exp !== "number" || parsed.exp < now) return null;
  if (typeof parsed.nonce !== "string" || !safeEqual(parsed.nonce, nonceCookie)) return null;
  if (typeof parsed.orgId !== "string" || typeof parsed.userId !== "string") return null;
  return { ...parsed, returnTo: safeReturnPath(parsed.returnTo) };
}

export function slackAuthorizeUrl(state: string): string | null {
  const clientId = env().SLACK_CLIENT_ID;
  if (!clientId) return null;
  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("scope", SLACK_SCOPES.join(","));
  u.searchParams.set("redirect_uri", slackRedirectUri());
  u.searchParams.set("state", state);
  return u.toString();
}

type OAuthAccess = {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  app_id?: string;
  scope?: string;
  team?: { id?: string; name?: string };
  enterprise?: { id?: string } | null;
  incoming_webhook?: { channel?: string; channel_id?: string; configuration_url?: string; url?: string };
};

export async function exchangeSlackCode(code: string): Promise<OAuthAccess> {
  const { SLACK_CLIENT_ID: id, SLACK_CLIENT_SECRET: secret } = env();
  if (!id || !secret) throw new ProviderError("slack not configured", false);
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code, redirect_uri: slackRedirectUri() }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ProviderError(`slack oauth ${res.status}`, res.status >= 500);
  return (await res.json()) as OAuthAccess;
}

export class SlackInstallError extends Error {
  constructor(
    public code: "denied" | "conflict" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/** Store a completed install: encrypted bot token + channel_connections row (externalId = team id). */
export async function saveSlackInstall(input: { orgId: string; userId: string; access: OAuthAccess; ip?: string | null }) {
  const a = input.access;
  const teamId = a.team?.id;
  if (!a.ok || !a.access_token || !teamId || !/^[A-Z0-9]{2,32}$/.test(teamId)) {
    throw new SlackInstallError("failed", `Slack install failed${a.error ? `: ${a.error}` : ""}`);
  }
  const secretName = `slack:bot:${teamId}`;
  const config = {
    teamName: a.team?.name ?? null,
    botUserId: a.bot_user_id ?? null,
    appId: a.app_id ?? null,
    scope: a.scope ?? null,
    defaultChannelId: a.incoming_webhook?.channel_id ?? null,
    defaultChannelName: a.incoming_webhook?.channel ?? null,
    installedBy: input.userId,
  };

  const connectionId = await db().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.channelConnections)
      .where(and(eq(schema.channelConnections.kind, "slack"), eq(schema.channelConnections.externalId, teamId)))
      .limit(1);
    if (existing && existing.orgId !== input.orgId) {
      // Never let one tenant take over another tenant's Slack routing.
      throw new SlackInstallError("conflict", "This Slack workspace is already connected to another Roster workspace.");
    }
    const [secret] = await tx
      .insert(schema.secrets)
      .values({ orgId: input.orgId, name: secretName, ciphertext: encrypt(a.access_token!) })
      .onConflictDoUpdate({
        target: [schema.secrets.orgId, schema.secrets.name],
        set: { ciphertext: encrypt(a.access_token!), updatedAt: new Date() },
      })
      .returning({ id: schema.secrets.id });
    if (existing) {
      await tx
        .update(schema.channelConnections)
        .set({ config: { ...existing.config, ...config }, secretId: secret!.id, status: "connected", lastError: null })
        .where(eq(schema.channelConnections.id, existing.id));
      return existing.id;
    }
    const [row] = await tx
      .insert(schema.channelConnections)
      .values({ orgId: input.orgId, kind: "slack", externalId: teamId, config, secretId: secret!.id, status: "connected" })
      .returning({ id: schema.channelConnections.id });
    return row!.id;
  });

  await audit({
    orgId: input.orgId,
    actorType: "user",
    actorId: input.userId,
    action: "channel.slack.connected",
    targetType: "channel_connection",
    targetId: connectionId,
    metadata: { teamId, teamName: a.team?.name ?? null },
    ip: input.ip ?? null,
  });
  return { connectionId, teamId };
}

/** Decrypted bot token for a Slack connection, or null. Never log the return value. */
export async function slackBotToken(orgId: string, secretId: string | null): Promise<string | null> {
  if (!secretId) return null;
  const [row] = await db()
    .select({ ciphertext: schema.secrets.ciphertext })
    .from(schema.secrets)
    .where(and(eq(schema.secrets.id, secretId), eq(schema.secrets.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  try {
    return decrypt(row.ciphertext);
  } catch {
    logger.error({ orgId }, "slack: could not decrypt bot token");
    return null;
  }
}

export async function slackPostMessage(input: {
  token: string | null;
  channel: string;
  text: string;
  threadTs?: string | null;
}): Promise<SendResult> {
  if (!/^[A-Z0-9]{2,32}$/.test(input.channel)) throw new ProviderError("invalid slack channel", false);
  if (!input.token) {
    logger.info({ chars: input.text.length }, "slack: simulated post (no bot token)");
    return { providerId: null, simulated: true };
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      channel: input.channel,
      text: input.text.slice(0, 39_000),
      mrkdwn: true,
      thread_ts: input.threadTs ?? undefined,
      unfurl_links: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ProviderError(`slack ${res.status}`, res.status >= 500 || res.status === 429);
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string };
  if (!data.ok) {
    const permanent = ["channel_not_found", "not_in_channel", "invalid_auth", "account_inactive", "token_revoked", "is_archived", "msg_too_long"];
    throw new ProviderError(`slack: ${data.error ?? "error"}`, !permanent.includes(data.error ?? ""));
  }
  return { providerId: data.ts ?? null, simulated: false };
}

/** Strip the bot mention ("<@U123> do X" → "do X"). */
export function stripMention(text: string, botUserId?: string | null): string {
  const t = botUserId ? text.replace(new RegExp(`<@${botUserId}>`, "g"), "") : text.replace(/^\s*<@[A-Z0-9]+>/, "");
  return t.trim();
}
