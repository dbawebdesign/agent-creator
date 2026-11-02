import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestEnv, cleanupOrgs, makeAgent, makeOrg, rid, TEST_ENV, truncateChannelTables } from "./channels.fixtures";

vi.hoisted(() => {
  // env() is cached on first use; set provider secrets before anything reads it.
  Object.assign(process.env, {
    APP_URL: "https://app.roster.test",
    EMAIL_DOMAIN: "agents.roster.test",
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("resend-test-signing-secret-0123456789").toString("base64")}`,
    TWILIO_AUTH_TOKEN: "twilio-test-auth-token",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    SLACK_SIGNING_SECRET: "slack-test-signing-secret",
  });
  delete process.env.RESEND_API_KEY;
});

import { db, schema } from "@/server/db/client";
import { inboundProcess } from "@/server/channels/jobs";
import { handleResendWebhook, handleSlackWebhook, handleTwilioWebhook } from "@/server/channels/webhook-routes";
import { signSlack, signSvix, twilioSignature, verifySvix } from "@/server/channels/verify";
import { POST as resendRoute } from "@/app/api/webhooks/resend/route";

applyTestEnv();

const now = () => Math.floor(Date.now() / 1000);

function resendRequest(body: object, opts: { id?: string; ts?: number; secret?: string; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? `msg_${rid()}`;
  const ts = String(opts.ts ?? now());
  const signature = opts.signature ?? signSvix(id, ts, raw, opts.secret ?? TEST_ENV.RESEND_WEBHOOK_SECRET);
  return new Request("https://app.roster.test/api/webhooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": signature },
    body: raw,
  });
}

function receivedEvent(to: string, extra: Record<string, unknown> = {}) {
  return {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: `em_${rid(8)}`,
      from: "Dana Brand <dana@brandlord.co>",
      to: [to],
      cc: [],
      subject: "Quote for 500 tumblers",
      message_id: `<${rid()}@mail.brandlord.co>`,
      text: "Can you quote 500 tumblers with our logo?\n\nOn Mon, Nov 2, 2026 at 9:00 AM Maya wrote:\n> earlier text",
      headers: {},
      ...extra,
    },
  };
}

async function processAllInbound() {
  const jobs = await db().select().from(schema.jobs).where(and(eq(schema.jobs.type, "inbound.process"), eq(schema.jobs.status, "queued")));
  for (const j of jobs) {
    await inboundProcess(j.payload, { db: db(), jobId: j.id });
    await db().update(schema.jobs).set({ status: "succeeded" }).where(eq(schema.jobs.id, j.id));
  }
  return jobs.length;
}

/** Reply runs started for an org (engine.startConversationRun), checked against their queued agent.run jobs. */
async function agentRunJobs(orgId: string) {
  const runs = await db().select().from(schema.runs).where(eq(schema.runs.orgId, orgId));
  const jobs = await db().select().from(schema.jobs).where(and(eq(schema.jobs.type, "agent.run"), eq(schema.jobs.orgId, orgId)));
  expect(jobs.map((j) => j.payload.runId).sort()).toEqual(runs.map((r) => r.id).sort());
  return runs;
}

beforeEach(async () => {
  await truncateChannelTables();
});
afterAll(async () => {
  await cleanupOrgs();
});

describe("Resend (Svix) webhook", () => {
  it("accepts a valid signature, records the event and queues inbound.process", async () => {
    const res = await resendRoute(resendRequest({ type: "email.sent", data: { email_id: "x" } }));
    expect(res.status).toBe(200);
    const events = await db().select().from(schema.webhookEvents).where(eq(schema.webhookEvents.provider, "resend"));
    expect(events).toHaveLength(1);
    const jobs = await db().select().from(schema.jobs).where(eq(schema.jobs.type, "inbound.process"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ provider: "resend", webhookEventId: events[0]!.id });
  });

  it("rejects a bad signature, a wrong secret, a missing header and a stale timestamp", async () => {
    const body = { type: "email.received", data: {} };
    expect((await handleResendWebhook(resendRequest(body, { signature: "v1,AAAA" }))).status).toBe(401);
    expect(
      (await handleResendWebhook(resendRequest(body, { secret: `whsec_${Buffer.from("other").toString("base64")}` }))).status,
    ).toBe(401);
    const noSig = resendRequest(body);
    noSig.headers.delete("svix-signature");
    expect((await handleResendWebhook(noSig)).status).toBe(401);
    expect((await handleResendWebhook(resendRequest(body, { ts: now() - 6 * 60 }))).status).toBe(401);
    expect((await handleResendWebhook(resendRequest(body, { ts: now() + 6 * 60 }))).status).toBe(401);
    expect(await db().select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it("rejects a body tampered after signing", async () => {
    const id = "msg_tamper";
    const ts = String(now());
    const sig = signSvix(id, ts, JSON.stringify({ a: 1 }), TEST_ENV.RESEND_WEBHOOK_SECRET);
    const req = new Request("https://app.roster.test/api/webhooks/resend", {
      method: "POST",
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig },
      body: JSON.stringify({ a: 2 }),
    });
    expect((await handleResendWebhook(req)).status).toBe(401);
  });

  it("accepts any matching signature during secret rotation", () => {
    const ts = String(now());
    const good = signSvix("id1", ts, "{}", TEST_ENV.RESEND_WEBHOOK_SECRET);
    expect(verifySvix({ id: "id1", timestamp: ts, signature: `v1,bogus ${good}`, body: "{}" }, TEST_ENV.RESEND_WEBHOOK_SECRET)).toBe(true);
    expect(verifySvix({ id: "id1", timestamp: ts, signature: good, body: "{}" }, undefined)).toBe(false);
  });

  it("is idempotent: the same event twice → one event, one job, one message, one agent.run", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const event = receivedEvent(`Maya <${agent.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}>`);
    const id = `msg_${rid()}`;
    const r1 = await handleResendWebhook(resendRequest(event, { id }));
    const r2 = await handleResendWebhook(resendRequest(event, { id }));
    expect(r1.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await db().select().from(schema.webhookEvents)).toHaveLength(1);
    expect(await processAllInbound()).toBe(1);

    // Re-processing the same event (e.g. a retried job) changes nothing.
    const [ev] = await db().select().from(schema.webhookEvents);
    await db().update(schema.webhookEvents).set({ processedAt: null }).where(eq(schema.webhookEvents.id, ev!.id));
    await inboundProcess({ provider: "resend", webhookEventId: ev!.id }, { db: db(), jobId: "retry" });

    const msgs = await db().select().from(schema.messages).where(eq(schema.messages.orgId, org.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toBe("Can you quote 500 tumblers with our logo?");
    expect(msgs[0]!.direction).toBe("inbound");
    const runs = await agentRunJobs(org.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ orgId: org.id, agentId: agent.id, conversationId: msgs[0]!.conversationId, trigger: "message", input: { messageId: msgs[0]!.id } });
    const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.orgId, org.id));
    expect(contact).toMatchObject({ email: "dana@brandlord.co", name: "Dana Brand" });
  });

  it("threads replies via In-Reply-To and falls back to normalized subject", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const to = `${agent.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}`;
    const first = receivedEvent(to);
    await handleResendWebhook(resendRequest(first));
    await processAllInbound();
    const [conv] = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, org.id));

    // Agent's reply in the same conversation (as the engine would store it).
    const ourId = `<reply-${rid()}@${TEST_ENV.EMAIL_DOMAIN}>`;
    await db().insert(schema.messages).values({
      orgId: org.id,
      conversationId: conv!.id,
      direction: "outbound",
      author: "agent",
      body: "Here's the quote.",
      meta: { emailMessageId: ourId },
      deliveryStatus: "sent",
    });

    const reply = receivedEvent(to, { subject: "Re: Quote for 500 tumblers", headers: { "In-Reply-To": ourId, References: `${first.data.message_id} ${ourId}` } });
    await handleResendWebhook(resendRequest(reply));
    const bySubject = receivedEvent(to, { subject: "RE: Fwd: quote for 500 tumblers" });
    await handleResendWebhook(resendRequest(bySubject));
    const otherTopic = receivedEvent(to, { subject: "Totally new topic" });
    await handleResendWebhook(resendRequest(otherTopic));
    await processAllInbound();

    const convs = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, org.id));
    expect(convs).toHaveLength(2);
    const inConv = await db().select().from(schema.messages).where(eq(schema.messages.conversationId, conv!.id));
    expect(inConv).toHaveLength(4);
  });

  it("never threads into another tenant's conversation, even with a known Message-ID", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const agentA = await makeAgent(orgA.id);
    const agentB = await makeAgent(orgB.id);
    const [convB] = await db().insert(schema.conversations).values({ orgId: orgB.id, agentId: agentB.id, channel: "email", externalThreadId: "<root-b@x.test>" }).returning();
    await db().insert(schema.messages).values({ orgId: orgB.id, conversationId: convB!.id, direction: "outbound", author: "agent", body: "secret", meta: { emailMessageId: "<known-b@x.test>" }, deliveryStatus: "sent" });
    const ev = receivedEvent(`${agentA.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}`, { headers: { "In-Reply-To": "<known-b@x.test>", References: "<root-b@x.test> <known-b@x.test>" } });
    await handleResendWebhook(resendRequest(ev));
    await processAllInbound();
    const inB = await db().select().from(schema.messages).where(eq(schema.messages.conversationId, convB!.id));
    expect(inB).toHaveLength(1);
    const inA = await db().select().from(schema.messages).where(eq(schema.messages.orgId, orgA.id));
    expect(inA).toHaveLength(1);
    expect(inA[0]!.conversationId).not.toBe(convB!.id);
  });

  it("recovers if the worker died after storing the message but before starting the run", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const ev = receivedEvent(`${agent.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}`);
    await handleResendWebhook(resendRequest(ev));
    const [row] = await db().select().from(schema.webhookEvents);
    // Simulate the crash: message stored, no run.
    const { ingestInbound } = await import("@/server/channels/inbound");
    await ingestInbound(db(), {
      orgId: org.id,
      agentId: agent.id,
      channel: "email",
      threadKey: ev.data.message_id,
      subject: ev.data.subject,
      contact: { email: "dana@brandlord.co" },
      body: "Can you quote 500 tumblers with our logo?",
      externalId: `email:${ev.data.email_id}`,
      meta: {},
      triggerAgent: true,
    });
    expect(await agentRunJobs(org.id)).toHaveLength(0);
    await inboundProcess({ provider: "resend", webhookEventId: row!.id }, { db: db(), jobId: "retry" });
    expect(await db().select().from(schema.messages).where(eq(schema.messages.orgId, org.id))).toHaveLength(1);
    expect(await agentRunJobs(org.id)).toHaveLength(1);
  });

  it("does not wake the agent for auto-replies or spoofed senders, and ignores unknown recipients", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    await handleResendWebhook(
      resendRequest(receivedEvent(`${agent.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}`, { headers: { "Auto-Submitted": "auto-replied" } })),
    );
    await handleResendWebhook(
      resendRequest(
        receivedEvent(`${agent.emailHandle}@${TEST_ENV.EMAIL_DOMAIN}`, {
          headers: { "Authentication-Results": "mx.resend.com; spf=fail smtp.mailfrom=brandlord.co; dkim=none; dmarc=fail header.from=brandlord.co" },
        }),
      ),
    );
    await handleResendWebhook(resendRequest(receivedEvent(`nobody-${rid()}@${TEST_ENV.EMAIL_DOMAIN}`)));
    await handleResendWebhook(resendRequest(receivedEvent(`${agent.emailHandle}@evil.example`)));
    await processAllInbound();
    expect(await db().select().from(schema.messages).where(eq(schema.messages.orgId, org.id))).toHaveLength(2);
    expect(await agentRunJobs(org.id)).toHaveLength(0);
  });
});

describe("Twilio webhook", () => {
  const url = "https://app.roster.test/api/webhooks/twilio";

  function twilioRequest(params: Record<string, string>, opts: { signature?: string; token?: string; url?: string } = {}) {
    const entries = Object.entries(params);
    const sig = opts.signature ?? twilioSignature(opts.token ?? TEST_ENV.TWILIO_AUTH_TOKEN, opts.url ?? url, entries);
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams(params).toString(),
    });
  }

  function smsParams(to: string, extra: Record<string, string> = {}) {
    return {
      MessageSid: `SM${rid(16)}`,
      AccountSid: TEST_ENV.TWILIO_ACCOUNT_SID,
      From: "+14155550111",
      To: to,
      Body: "Do we have the Acme order ready?",
      NumMedia: "0",
      ...extra,
    };
  }

  it("verifies the signature, routes by To number, responds with empty TwiML, and is idempotent", async () => {
    const org = await makeOrg();
    const phone = `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const agent = await makeAgent(org.id, { phone });
    const params = smsParams(phone);
    const res = await handleTwilioWebhook(twilioRequest(params));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(await res.text()).toContain("<Response></Response>");
    await handleTwilioWebhook(twilioRequest(params)); // Twilio retry
    expect(await db().select().from(schema.webhookEvents).where(eq(schema.webhookEvents.provider, "twilio"))).toHaveLength(1);
    await processAllInbound();
    const msgs = await db().select().from(schema.messages).where(eq(schema.messages.orgId, org.id));
    expect(msgs).toHaveLength(1);
    const runs = await agentRunJobs(org.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: agent.id, input: { messageId: msgs[0]!.id } });
    const [conv] = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, org.id));
    expect(conv).toMatchObject({ channel: "sms", externalThreadId: "+14155550111" });
  });

  it("rejects missing, forged, wrong-token and wrong-URL signatures", async () => {
    const params = smsParams("+14155550199");
    const noSig = twilioRequest(params);
    noSig.headers.delete("x-twilio-signature");
    expect((await handleTwilioWebhook(noSig)).status).toBe(403);
    expect((await handleTwilioWebhook(twilioRequest(params, { signature: "Zm9yZ2Vk" }))).status).toBe(403);
    expect((await handleTwilioWebhook(twilioRequest(params, { token: "other-token" }))).status).toBe(403);
    expect((await handleTwilioWebhook(twilioRequest(params, { url: "https://evil.example/api/webhooks/twilio" }))).status).toBe(403);
    // Param tampering after signing.
    const req = twilioRequest(params);
    const tampered = new Request(url, { method: "POST", headers: req.headers, body: new URLSearchParams({ ...params, Body: "evil" }).toString() });
    expect((await handleTwilioWebhook(tampered)).status).toBe(403);
    expect(await db().select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it("rejects a valid signature from a different Twilio account", async () => {
    const res = await handleTwilioWebhook(twilioRequest(smsParams("+14155550199", { AccountSid: "AC11111111111111111111111111111111" })));
    expect(res.status).toBe(403);
  });

  it("STOP opts the contact out without waking the agent", async () => {
    const org = await makeOrg();
    const phone = `+1628${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    await makeAgent(org.id, { phone });
    await handleTwilioWebhook(twilioRequest(smsParams(phone, { Body: "STOP" })));
    await processAllInbound();
    expect(await agentRunJobs(org.id)).toHaveLength(0);
    const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.orgId, org.id));
    expect(contact?.allowProactive).toBe("no");
  });
});

describe("Slack events webhook", () => {
  function slackRequest(body: object, opts: { ts?: number; secret?: string; signature?: string; retry?: string } = {}) {
    const raw = JSON.stringify(body);
    const ts = String(opts.ts ?? now());
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": opts.signature ?? signSlack(ts, raw, opts.secret ?? TEST_ENV.SLACK_SIGNING_SECRET),
    };
    if (opts.retry) headers["x-slack-retry-num"] = opts.retry;
    return new Request("https://app.roster.test/api/webhooks/slack", { method: "POST", headers, body: raw });
  }

  it("answers url_verification only when signed", async () => {
    const ok = await handleSlackWebhook(slackRequest({ type: "url_verification", challenge: "abc123" }));
    expect(await ok.json()).toEqual({ challenge: "abc123" });
    const bad = await handleSlackWebhook(slackRequest({ type: "url_verification", challenge: "abc123" }, { secret: "wrong" }));
    expect(bad.status).toBe(401);
  });

  it("rejects forged and replayed (stale) requests", async () => {
    const body = { type: "event_callback", team_id: "T1", event_id: "Ev1", event: { type: "app_mention", user: "U1", text: "hi", channel: "C1", ts: "1.2" } };
    expect((await handleSlackWebhook(slackRequest(body, { signature: "v0=deadbeef" }))).status).toBe(401);
    expect((await handleSlackWebhook(slackRequest(body, { ts: now() - 301 }))).status).toBe(401);
    expect(await db().select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it("stores app mentions once (retries deduped), ignores bot messages, threads by channel + thread_ts", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const teamId = `T${rid(4).toUpperCase()}`;
    await db().insert(schema.channelConnections).values({ orgId: org.id, kind: "slack", externalId: teamId, status: "connected", config: { botUserId: "UBOT" } });

    const mention = {
      type: "event_callback",
      team_id: teamId,
      event_id: `Ev${rid(4)}`,
      event: { type: "app_mention", user: "UDANA", text: "<@UBOT> what's on deck today?", channel: "CGEN", ts: "1730500000.000100" },
    };
    expect((await handleSlackWebhook(slackRequest(mention))).status).toBe(200);
    const retry = await handleSlackWebhook(slackRequest(mention, { retry: "1" }));
    expect(await retry.json()).toMatchObject({ duplicate: true });

    const botMsg = {
      type: "event_callback",
      team_id: teamId,
      event_id: `Ev${rid(4)}`,
      event: { type: "message", channel_type: "im", bot_id: "B1", text: "loop", channel: "DBOT", ts: "1730500001.000100" },
    };
    await handleSlackWebhook(slackRequest(botMsg));
    const threadReply = {
      type: "event_callback",
      team_id: teamId,
      event_id: `Ev${rid(4)}`,
      event: { type: "app_mention", user: "UDANA", text: "<@UBOT> and tomorrow?", channel: "CGEN", ts: "1730500002.000100", thread_ts: "1730500000.000100" },
    };
    await handleSlackWebhook(slackRequest(threadReply));

    expect(await db().select().from(schema.webhookEvents).where(eq(schema.webhookEvents.provider, "slack"))).toHaveLength(2);
    await processAllInbound();
    const msgs = await db().select().from(schema.messages).where(eq(schema.messages.orgId, org.id));
    expect(msgs.map((m) => m.body).sort()).toEqual(["and tomorrow?", "what's on deck today?"]);
    const convs = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, org.id));
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ channel: "slack", externalThreadId: "CGEN:1730500000.000100", agentId: agent.id });
    expect(await agentRunJobs(org.id)).toHaveLength(2);
  });

  it("keys direct messages by DM channel so a DM is one running conversation", async () => {
    const org = await makeOrg();
    await makeAgent(org.id);
    const teamId = `T${rid(4).toUpperCase()}`;
    await db().insert(schema.channelConnections).values({ orgId: org.id, kind: "slack", externalId: teamId, status: "connected", config: { botUserId: "UBOT" } });
    for (const ts of ["1730500010.000100", "1730500020.000100"]) {
      await handleSlackWebhook(
        slackRequest({ type: "event_callback", team_id: teamId, event_id: `Ev${rid(4)}`, event: { type: "message", channel_type: "im", user: "UDANA", text: `dm ${ts}`, channel: "DDANA", ts } }),
      );
    }
    await processAllInbound();
    const convs = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, org.id));
    expect(convs).toHaveLength(1);
    expect(convs[0]!.externalThreadId).toBe("DDANA");
  });

  it("ignores events for Slack teams that are not connected", async () => {
    await handleSlackWebhook(
      slackRequest({ type: "event_callback", team_id: "TNOPE", event_id: `Ev${rid(4)}`, event: { type: "app_mention", user: "U1", text: "x", channel: "C1", ts: "1.2" } }),
    );
    await processAllInbound();
    const [{ n }] = (await db().execute(sql`select count(*)::int as n from messages where external_id = 'slack:C1:1.2'`)).rows as [{ n: number }];
    expect(n).toBe(0);
  });
});
