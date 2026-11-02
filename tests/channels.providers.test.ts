/** channel.deliver against mocked provider APIs (Resend, Twilio, Slack). */
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeOrg, rid } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, {
    APP_URL: "https://app.roster.test",
    EMAIL_DOMAIN: "agents.roster.test",
    RESEND_API_KEY: "re_test_key",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "twilio-test-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: "MG00000000000000000000000000000000",
  });
});

import { db, schema } from "@/server/db/client";
import { encrypt } from "@/server/security/crypto";
import { channelDeliver } from "@/server/channels/jobs";
import { processResendEvent, processTwilioEvent } from "@/server/channels/inbound";

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let nextResponses: Array<() => Response> = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const make = nextResponses.shift();
    return make ? make() : Response.json({ id: `re_${rid()}`, sid: `SM${rid(16)}`, ok: true, ts: "1730500099.000200" });
  }),
);

beforeEach(() => {
  calls.length = 0;
  nextResponses = [];
});
afterAll(async () => {
  await cleanupOrgs();
});

async function setup(channel: "email" | "sms" | "slack", threadKey?: string) {
  const org = await makeOrg({ name: "Brandlord", branding: { emailFromName: "Brandlord", accent: "#0F766E" } });
  const agent = await makeAgent(org.id, { phone: channel === "sms" ? `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}` : null });
  const [contact] = await db()
    .insert(schema.contacts)
    .values({ orgId: org.id, email: "dana@brandlord.co", phone: "+14155550111", slackUserId: "UDANA" })
    .returning();
  const [conv] = await db()
    .insert(schema.conversations)
    .values({ orgId: org.id, agentId: agent.id, channel, contactId: contact!.id, externalThreadId: threadKey ?? `<root-${rid()}@x>`, subject: "Quote for 500 tumblers" })
    .returning();
  await db().insert(schema.messages).values({
    orgId: org.id,
    conversationId: conv!.id,
    direction: "inbound",
    author: "contact",
    body: "Can you quote?",
    externalId: `email:${rid()}`,
    meta: { emailMessageId: "<in-1@mail.brandlord.co>", references: [] },
    deliveryStatus: "received",
  });
  const [out] = await db()
    .insert(schema.messages)
    .values({ orgId: org.id, conversationId: conv!.id, direction: "outbound", author: "agent", body: "**Quote:** $2,450 for 500 tumblers." })
    .returning();
  return { org, agent, conv: conv!, out: out! };
}

describe("email via Resend", () => {
  it("sends with branded From, threading headers and an idempotency key; later status events update the message", async () => {
    const { org, agent, out } = await setup("email");
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "email", messageId: out.id }, { db: db(), jobId: "j" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Idempotency-Key"]).toBe(`roster-msg-${out.id}`);
    const body = JSON.parse(String(call.init.body));
    expect(body.from).toBe(`"Maya · Brandlord" <${agent.emailHandle}@agents.roster.test>`);
    expect(body.to).toEqual(["dana@brandlord.co"]);
    expect(body.subject).toBe("Re: Quote for 500 tumblers");
    expect(body.headers["In-Reply-To"]).toBe("<in-1@mail.brandlord.co>");
    expect(body.headers.References).toBe("<in-1@mail.brandlord.co>");
    expect(body.headers["Message-ID"]).toMatch(/@agents\.roster\.test>$/);
    expect(body.html).toContain("<strong");
    expect(body.text).toContain("Quote:");

    const [msg] = await db().select().from(schema.messages).where(eq(schema.messages.id, out.id));
    expect(msg!.deliveryStatus).toBe("sent");
    expect(msg!.externalId).toMatch(/^email:re_/);

    // Retried job: nothing sent twice.
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "email", messageId: out.id }, { db: db(), jobId: "j" });
    expect(calls).toHaveLength(1);

    await processResendEvent(db(), { type: "email.delivered", data: { email_id: msg!.externalId!.slice(6) } });
    const [after] = await db().select().from(schema.messages).where(eq(schema.messages.id, out.id));
    expect(after!.deliveryStatus).toBe("delivered");
  });

  it("retries transient errors (throws) and records permanent ones without retrying", async () => {
    const a = await setup("email");
    nextResponses.push(() => new Response("upstream", { status: 503 }));
    await expect(channelDeliver({ orgId: a.org.id, agentId: a.agent.id, channel: "email", messageId: a.out.id }, { db: db(), jobId: "t" })).rejects.toThrow(/resend 503/);
    let [msg] = await db().select().from(schema.messages).where(eq(schema.messages.id, a.out.id));
    expect(msg!.deliveryStatus).toBe("failed");
    await channelDeliver({ orgId: a.org.id, agentId: a.agent.id, channel: "email", messageId: a.out.id }, { db: db(), jobId: "t" });
    [msg] = await db().select().from(schema.messages).where(eq(schema.messages.id, a.out.id));
    expect(msg!.deliveryStatus).toBe("sent");

    const b = await setup("email");
    nextResponses.push(() => Response.json({ message: "invalid to" }, { status: 422 }));
    await expect(channelDeliver({ orgId: b.org.id, agentId: b.agent.id, channel: "email", messageId: b.out.id }, { db: db(), jobId: "p" })).resolves.toBeUndefined();
    [msg] = await db().select().from(schema.messages).where(eq(schema.messages.id, b.out.id));
    expect(msg!.deliveryStatus).toBe("failed");
    expect(String(msg!.meta.lastError)).toContain("422");
    expect(String(msg!.meta.lastError)).not.toContain("re_test_key");
  });
});

describe("sms via Twilio", () => {
  it("posts to the Messages API with the messaging service, from the agent's number, in segments", async () => {
    const { org, agent, out } = await setup("sms", "+14155550111");
    const long = Array.from({ length: 120 }, (_, i) => `Line item ${i} is confirmed.`).join(" ");
    await db().update(schema.messages).set({ body: long }).where(eq(schema.messages.id, out.id));
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "sms", messageId: out.id }, { db: db(), jobId: "s" });
    expect(calls.length).toBeGreaterThan(1);
    const first = calls[0]!;
    expect(first.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json");
    const form = new URLSearchParams(String(first.init.body));
    expect(form.get("To")).toBe("+14155550111");
    expect(form.get("MessagingServiceSid")).toBe("MG00000000000000000000000000000000");
    expect(form.get("From")).toBe(agent.phoneNumber);
    expect(form.get("Body")!.endsWith(`(1/${calls.length})`)).toBe(true);
    const [msg] = await db().select().from(schema.messages).where(eq(schema.messages.id, out.id));
    expect(msg!.meta).toMatchObject({ parts: calls.length, to: "+14155550111" });
    expect(form.get("StatusCallback")).toBe("https://app.roster.test/api/webhooks/twilio");

    // Twilio delivery status callback for the first segment.
    await processTwilioEvent(db(), { MessageSid: String(msg!.externalId).slice(4), MessageStatus: "delivered", From: agent.phoneNumber!, To: "+14155550111" });
    const [after] = await db().select().from(schema.messages).where(eq(schema.messages.id, out.id));
    expect(after!.deliveryStatus).toBe("delivered");
  });
});

describe("slack", () => {
  it("replies in-thread with the decrypted bot token and mrkdwn", async () => {
    const { org, agent, out } = await setup("slack", "CGEN:1730500000.000100");
    const [secret] = await db().insert(schema.secrets).values({ orgId: org.id, name: `slack:bot:T${rid(3)}`, ciphertext: encrypt("xoxb-test-token") }).returning();
    await db().insert(schema.channelConnections).values({ orgId: org.id, kind: "slack", externalId: `T${rid(4).toUpperCase()}`, status: "connected", secretId: secret!.id, config: {} });
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "slack", messageId: out.id }, { db: db(), jobId: "sl" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test-token");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ channel: "CGEN", thread_ts: "1730500000.000100", mrkdwn: true });
    expect(body.text).toBe("*Quote:* $2,450 for 500 tumblers.");
  });

  it("posts DM replies straight into the DM (no thread)", async () => {
    const { org, agent, out } = await setup("slack", "DDANA");
    const [secret] = await db().insert(schema.secrets).values({ orgId: org.id, name: `slack:bot:T${rid(3)}`, ciphertext: encrypt("xoxb-test-token") }).returning();
    await db().insert(schema.channelConnections).values({ orgId: org.id, kind: "slack", externalId: `T${rid(4).toUpperCase()}`, status: "connected", secretId: secret!.id, config: {} });
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "slack", messageId: out.id }, { db: db(), jobId: "dm" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.channel).toBe("DDANA");
    expect(body.thread_ts).toBeUndefined();
    const [conv] = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, org.id));
    expect(conv!.externalThreadId).toBe("DDANA");
  });
});
