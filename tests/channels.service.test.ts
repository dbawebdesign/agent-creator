/** Slack OAuth install/callback, channel service functions used by the UI. */
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeOrg, rid } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, {
    APP_URL: "https://app.roster.test",
    EMAIL_DOMAIN: "agents.roster.test",
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "slack-client-secret",
    SLACK_SIGNING_SECRET: "slack-test-signing-secret",
    AUTH_SECRET: "test-auth-secret",
  });
});

const session = vi.hoisted(() => ({ current: null as null | { id: string; isPlatformAdmin: boolean } }));
vi.mock("@/server/auth/session", () => ({
  getCurrentUser: async () => session.current,
  requireUser: async () => session.current,
  clientIp: () => null,
}));

import { db, schema } from "@/server/db/client";
import { decrypt } from "@/server/security/crypto";
import { GET as installRoute } from "@/app/api/slack/install/route";
import { GET as callbackRoute } from "@/app/api/slack/oauth/callback/route";
import { SLACK_NONCE_COOKIE, safeReturnPath, signSlackState, verifySlackState } from "@/server/channels/slack";
import { ChannelError, connectSmsNumber, disconnectChannel, getChannelOverview, slackInstallUrl } from "@/server/channels/service";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

async function makeUser(orgId: string, role: "owner" | "admin" | "member") {
  const [u] = await db().insert(schema.users).values({ email: `u-${rid()}@test.dev` }).returning();
  await db().insert(schema.memberships).values({ userId: u!.id, orgId, role });
  return u!;
}

beforeEach(() => {
  fetchMock.mockReset();
  session.current = null;
});
afterAll(async () => {
  await cleanupOrgs();
  await db().execute(sql`delete from users where email like 'u-%@test.dev'`);
});

describe("Slack OAuth", () => {
  it("only admins can start an install; state + nonce cookie are issued", async () => {
    const org = await makeOrg();
    const member = await makeUser(org.id, "member");
    const admin = await makeUser(org.id, "admin");
    const url = slackInstallUrl(org.id, `/p/${org.slug}/settings/channels`);

    let res = await installRoute(new NextRequest(url));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.roster.test/login");

    session.current = { id: member.id, isPlatformAdmin: false };
    expect((await installRoute(new NextRequest(url))).status).toBe(404);

    session.current = { id: admin.id, isPlatformAdmin: false };
    res = await installRoute(new NextRequest(url));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://app.roster.test/api/slack/oauth/callback");
    expect(loc.searchParams.get("state")).toBeTruthy();
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${SLACK_NONCE_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("callback verifies state + cookie + user, stores the bot token encrypted, and redirects only to the app", async () => {
    const org = await makeOrg();
    const admin = await makeUser(org.id, "owner");
    const other = await makeUser(org.id, "owner");
    const teamId = `T${rid(4).toUpperCase()}`;
    const { state, nonce } = signSlackState({ orgId: org.id, userId: admin.id, returnTo: `/p/${org.slug}/settings/channels` });
    const cb = (st: string, cookieNonce: string | null) =>
      new NextRequest(`https://app.roster.test/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(st)}`, {
        headers: cookieNonce ? { cookie: `${SLACK_NONCE_COOKIE}=${cookieNonce}` } : {},
      });

    session.current = { id: admin.id, isPlatformAdmin: false };
    expect((await callbackRoute(cb(state, null))).status).toBe(400); // no cookie (CSRF)
    expect((await callbackRoute(cb(state, "wrong-nonce"))).status).toBe(400);
    expect((await callbackRoute(cb(`${state}x`, nonce))).status).toBe(400); // tampered
    session.current = { id: other.id, isPlatformAdmin: false };
    expect((await callbackRoute(cb(state, nonce))).status).toBe(404); // different signed-in user
    expect(fetchMock).not.toHaveBeenCalled();

    session.current = { id: admin.id, isPlatformAdmin: false };
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        access_token: "xoxb-secret-token",
        bot_user_id: "UBOT",
        team: { id: teamId, name: "Brandlord" },
        incoming_webhook: { channel: "#general", channel_id: "CGEN" },
      }),
    );
    const res = await callbackRoute(cb(state, nonce));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://app.roster.test/p/${org.slug}/settings/channels?slack=connected`);
    const [conn] = await db().select().from(schema.channelConnections).where(eq(schema.channelConnections.externalId, teamId));
    expect(conn).toMatchObject({ orgId: org.id, kind: "slack", status: "connected" });
    expect(conn!.config).toMatchObject({ teamName: "Brandlord", botUserId: "UBOT", defaultChannelId: "CGEN" });
    expect(JSON.stringify(conn!.config)).not.toContain("xoxb");
    const [secret] = await db().select().from(schema.secrets).where(eq(schema.secrets.id, conn!.secretId!));
    expect(secret!.ciphertext).not.toContain("xoxb");
    expect(decrypt(secret!.ciphertext)).toBe("xoxb-secret-token");

    // Another tenant installing the same Slack workspace cannot hijack its routing.
    const org2 = await makeOrg();
    const admin2 = await makeUser(org2.id, "owner");
    const s2 = signSlackState({ orgId: org2.id, userId: admin2.id });
    session.current = { id: admin2.id, isPlatformAdmin: false };
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, access_token: "xoxb-attacker", team: { id: teamId, name: "Brandlord" } }));
    const res2 = await callbackRoute(cb(s2.state, s2.nonce));
    expect(res2.headers.get("location")).toContain("slack=conflict");
    const [still] = await db().select().from(schema.channelConnections).where(eq(schema.channelConnections.externalId, teamId));
    expect(still!.orgId).toBe(org.id);
  });

  it("rejects expired state and unsafe return paths", () => {
    const { state, nonce } = signSlackState({ orgId: "o", userId: "u", now: Date.now() - 11 * 60_000 });
    expect(verifySlackState(state, nonce)).toBeNull();
    for (const bad of ["//evil.com", "https://evil.com/p/x", "/p/x/../../admin", "/\\evil.com", "/p/x//evil.com", "/login?next=https://evil.com", "javascript:alert(1)"]) {
      expect(safeReturnPath(bad)).toBeNull();
    }
    expect(safeReturnPath("/p/brandlord/settings/channels?tab=slack")).toBe("/p/brandlord/settings/channels?tab=slack");
  });
});

describe("channel service", () => {
  it("connects an SMS number, reports the overview, refuses a number owned elsewhere, and disconnects", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const phone = `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const { connectionId } = await connectSmsNumber(org.id, agent.id, phone.replace(/^(\+1)(\d{3})/, "$1 ($2) "));
    const overview = await getChannelOverview(org.id);
    const row = overview.agents.find((a) => a.agentId === agent.id)!;
    expect(row.email.address).toBe(`${agent.emailHandle}@agents.roster.test`);
    expect(row.sms).toMatchObject({ phone, connectionId });
    expect(row.mcp.url).toBe("https://app.roster.test/api/mcp");
    expect(overview.providers).toMatchObject({ slack: true });

    const other = await makeOrg();
    const otherAgent = await makeAgent(other.id);
    await expect(connectSmsNumber(other.id, otherAgent.id, phone)).rejects.toBeInstanceOf(ChannelError);
    await expect(connectSmsNumber(org.id, agent.id, "555-1234")).rejects.toThrow(/international format/);
    await expect(connectSmsNumber(other.id, agent.id, "+14155550100")).rejects.toThrow(/not found/i);
    await expect(disconnectChannel(other.id, connectionId)).rejects.toThrow(/not found/i);

    await disconnectChannel(org.id, connectionId);
    const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, agent.id));
    expect(a!.phoneNumber).toBeNull();
    const audits = await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.orgId, org.id));
    expect(audits.map((x) => x.action).sort()).toEqual(["channel.sms.connected", "channel.sms.disconnected"]);
  });
});
