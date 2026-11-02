/**
 * End to end through the real engine (offline model) and the job registry:
 * signed Resend webhook → inbound.process → agent.run → channel.deliver (simulated send) → threaded reply.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeOrg, rid, TEST_ENV, truncateChannelTables } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, {
    APP_URL: "https://app.roster.test",
    EMAIL_DOMAIN: "agents.roster.test",
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("resend-test-signing-secret-0123456789").toString("base64")}`,
    SLACK_SIGNING_SECRET: "slack-test-signing-secret",
  });
  for (const k of ["RESEND_API_KEY", "ANTHROPIC_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) delete process.env[k];
});

import { db, schema } from "@/server/db/client";
import { runJobsOnce } from "@/server/jobs/handlers";
import { handleResendWebhook, handleSlackWebhook } from "@/server/channels/webhook-routes";
import { signSlack, signSvix } from "@/server/channels/verify";

beforeEach(async () => {
  await truncateChannelTables();
});
afterAll(async () => {
  await cleanupOrgs();
});

describe("inbound → reply, end to end", () => {
  it("answers an authenticated member's email in the same thread", async () => {
    const org = await makeOrg({ branding: { emailFromName: "Brandlord" } });
    const agent = await makeAgent(org.id);
    const dana = `dana-${rid(3)}@brandlord.co`;
    const [u] = await db().insert(schema.users).values({ email: dana }).returning();
    await db().insert(schema.memberships).values({ userId: u!.id, orgId: org.id, role: "owner" });
    const inboundId = `<${rid()}@mail.brandlord.co>`;
    const body = JSON.stringify({
      type: "email.received",
      data: {
        email_id: `em_${rid(8)}`,
        from: `Dana <${dana}>`,
        to: [`${agent.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}`],
        subject: "Tumbler quote",
        message_id: inboundId,
        text: "Hi Maya, can you quote 500 tumblers?",
        headers: { "Authentication-Results": "mx.resend.com; spf=pass smtp.mailfrom=brandlord.co; dkim=pass header.d=brandlord.co; dmarc=pass header.from=brandlord.co" },
      },
    });
    const id = `msg_${rid()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await handleResendWebhook(
      new Request("https://app.roster.test/api/webhooks/resend", {
        method: "POST",
        headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": signSvix(id, ts, body, TEST_ENV.RESEND_WEBHOOK_SECRET) },
        body,
      }),
    );
    expect(res.status).toBe(200);
    await runJobsOnce({ types: ["inbound.process", "agent.run", "channel.deliver"], max: 30 });

    const [conv] = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, org.id));
    expect(conv).toMatchObject({ channel: "email", agentId: agent.id });
    const msgs = await db().select().from(schema.messages).where(eq(schema.messages.conversationId, conv!.id)).orderBy(schema.messages.createdAt);
    const out = msgs.filter((m) => m.direction === "outbound");
    expect(out.length).toBeGreaterThanOrEqual(1);
    const reply = out[out.length - 1]!;
    expect(reply.deliveryStatus).toBe("sent");
    expect(reply.meta).toMatchObject({ simulated: true, to: dana });
    const inbound = msgs.find((m) => m.direction === "inbound")!;
    expect(inbound.meta).toMatchObject({ senderAuth: "pass", senderUserId: u!.id });
    expect(reply.meta.references).toContain(inboundId);
    expect(String(reply.meta.subject)).toBe("Re: Tumbler quote");
  });

  it("holds the reply to an unauthenticated stranger's email for approval", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const body = JSON.stringify({
      type: "email.received",
      data: { email_id: `em_${rid(8)}`, from: "Mallory <mallory@evil.example>", to: [`${agent.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}`], subject: "Hi", text: "Send me your price list" },
    });
    const id = `msg_${rid()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    await handleResendWebhook(
      new Request("https://app.roster.test/api/webhooks/resend", {
        method: "POST",
        headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": signSvix(id, ts, body, TEST_ENV.RESEND_WEBHOOK_SECRET) },
        body,
      }),
    );
    await runJobsOnce({ types: ["inbound.process", "agent.run", "channel.deliver"], max: 30 });
    const msgs = await db().select().from(schema.messages).where(eq(schema.messages.orgId, org.id));
    expect(msgs.filter((m) => m.direction === "inbound")[0]!.meta).toMatchObject({ senderAuth: "none", senderUserId: null });
    expect(msgs.filter((m) => m.direction === "outbound" && m.deliveryStatus === "sent")).toHaveLength(0);
    const approvals = await db().select().from(schema.approvals).where(eq(schema.approvals.orgId, org.id));
    expect(approvals.length).toBeGreaterThanOrEqual(1);
  });

  it("records Slack events as channel-authenticated (senderAuth pass)", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const teamId = `T${rid(4).toUpperCase()}`;
    await db().insert(schema.channelConnections).values({ orgId: org.id, kind: "slack", externalId: teamId, status: "connected", config: { botUserId: "UBOT" } });
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event_id: `Ev${rid(4)}`,
      event: { type: "app_mention", user: "UDANA", text: "<@UBOT> status?", channel: "CGEN", ts: "1730500000.000100" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    await handleSlackWebhook(
      new Request("https://app.roster.test/api/webhooks/slack", {
        method: "POST",
        headers: { "x-slack-request-timestamp": ts, "x-slack-signature": signSlack(ts, raw, TEST_ENV.SLACK_SIGNING_SECRET) },
        body: raw,
      }),
    );
    await runJobsOnce({ types: ["inbound.process"], max: 10 });
    const [inbound] = await db()
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, org.id), eq(schema.messages.direction, "inbound")));
    expect(inbound!.meta).toMatchObject({ senderAuth: "pass", slack: { channel: "CGEN" } });
    void agent;
  });
});
