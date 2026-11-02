/** channel.deliver in simulated mode (no provider keys) + pure helpers (segmentation, header safety, rendering). */
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeDeliverable, makeOrg, rid, TEST_ENV } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test", EMAIL_DOMAIN: "agents.roster.test" });
  for (const k of ["RESEND_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID"]) delete process.env[k];
});

import { db, schema } from "@/server/db/client";
import { channelDeliver } from "@/server/channels/jobs";
import { formatFrom, headerSafe, normalizeSubject, parseMessageIds, stripQuotedReply } from "@/server/channels/email";
import { renderEmail } from "@/server/channels/email-render";
import { segmentSms } from "@/server/channels/sms";
import { markdownToSlack } from "@/server/channels/text";
import { mcpConfigSnippet } from "@/server/api/keys";

afterAll(async () => {
  await cleanupOrgs();
});

const fetchSpy = vi.fn(async () => new Response("{}"));
vi.stubGlobal("fetch", fetchSpy);

async function conversationWithInbound(orgId: string, agentId: string, channel: "email" | "sms", contact: { email?: string; phone?: string }) {
  const [c] = await db().insert(schema.contacts).values({ orgId, email: contact.email ?? null, phone: contact.phone ?? null }).returning();
  const [conv] = await db()
    .insert(schema.conversations)
    .values({ orgId, agentId, channel, contactId: c!.id, externalThreadId: contact.phone ?? `<root-${rid()}@x.test>`, subject: "Quote" })
    .returning();
  await db().insert(schema.messages).values({
    orgId,
    conversationId: conv!.id,
    direction: "inbound",
    author: "contact",
    body: "hello",
    externalId: `email:${rid()}`,
    meta: { emailMessageId: "<in-1@mail.brandlord.co>", references: ["<root@mail.brandlord.co>"] },
    deliveryStatus: "received",
  });
  return conv!;
}

describe("channel.deliver (simulated mode)", () => {
  it("marks an email reply sent with meta.simulated and proper threading, never calling a provider", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const conv = await conversationWithInbound(org.id, agent.id, "email", { email: "dana@brandlord.co" });
    const [out] = await db()
      .insert(schema.messages)
      .values({ orgId: org.id, conversationId: conv.id, direction: "outbound", author: "agent", body: "Here you go." })
      .returning();
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "email", messageId: out!.id, text: "Here you go." }, { db: db(), jobId: "j1" });
    const [msg] = await db().select().from(schema.messages).where(eq(schema.messages.id, out!.id));
    expect(msg!.deliveryStatus).toBe("sent");
    expect(msg!.meta).toMatchObject({ simulated: true, to: "dana@brandlord.co", subject: "Re: Quote" });
    expect(msg!.meta.references).toEqual(["<root@mail.brandlord.co>", "<in-1@mail.brandlord.co>"]);
    expect(String(msg!.meta.emailMessageId)).toMatch(new RegExp(`@${TEST_ENV.EMAIL_DOMAIN.replace(/\./g, "\\.")}>$`));
    expect(fetchSpy).not.toHaveBeenCalled();

    // A retried job is a no-op.
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "email", messageId: out!.id }, { db: db(), jobId: "j1-retry" });
    const [again] = await db().select().from(schema.messages).where(eq(schema.messages.id, out!.id));
    expect(again!.meta.sentAt).toBe(msg!.meta.sentAt);
  });

  it("refuses to deliver another org's message (cross-tenant payload)", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const agentA = await makeAgent(orgA.id);
    const agentB = await makeAgent(orgB.id);
    const conv = await conversationWithInbound(orgA.id, agentA.id, "email", { email: "a@a.test" });
    const [out] = await db().insert(schema.messages).values({ orgId: orgA.id, conversationId: conv.id, direction: "outbound", author: "agent", body: "x" }).returning();
    await channelDeliver({ orgId: orgB.id, agentId: agentB.id, channel: "email", messageId: out!.id }, { db: db(), jobId: "j2" });
    const [msg] = await db().select().from(schema.messages).where(eq(schema.messages.id, out!.id));
    expect(msg!.deliveryStatus).toBe("pending");
  });

  it("delivers a deliverable to the portal (no-op) and by email once, even when the job repeats", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const d = await makeDeliverable(org.id, agent.id);
    await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "portal", deliverableId: d.id }, { db: db(), jobId: "p" });
    for (let i = 0; i < 2; i++) {
      await channelDeliver({ orgId: org.id, agentId: agent.id, channel: "email", deliverableId: d.id, to: "Dana@Brandlord.co" }, { db: db(), jobId: `e${i}` });
    }
    const [row] = await db().select().from(schema.deliverables).where(eq(schema.deliverables.id, d.id));
    expect(row!.deliveredVia.sort()).toEqual(["email", "portal"]);
    const msgs = await db()
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, org.id), eq(schema.messages.deliverableId, d.id)));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "outbound", deliveryStatus: "sent" });
    expect(msgs[0]!.meta).toMatchObject({ simulated: true, to: "dana@brandlord.co", subject: d.title });
  });

  it("drops a malformed payload without throwing", async () => {
    await expect(channelDeliver({ orgId: "nope", channel: "email" }, { db: db(), jobId: "bad" })).resolves.toBeUndefined();
  });
});

describe("channel helpers", () => {
  it("strips CR/LF from header values (no header injection)", () => {
    expect(headerSafe("Hello\r\nBcc: victim@x.com")).toBe("Hello Bcc: victim@x.com");
    const from = formatFrom('Maya "\r\nBcc: x@y.z', "maya@agents.roster.test");
    expect(from).not.toMatch(/[\r\n]/);
    expect(from).toBe('"Maya Bcc: x@y.z" <maya@agents.roster.test>');
    expect(() => formatFrom("Maya", "maya@agents.roster.test>\r\nBcc: x@y.z")).toThrow();
    expect(parseMessageIds("<a@b.c> junk <evil\r\n@x> <ok@d.e>")).toEqual(["<a@b.c>", "<ok@d.e>"]);
  });

  it("normalizes subjects and strips quoted replies", () => {
    expect(normalizeSubject("Re: Fwd: RE: Weekly  report")).toBe("weekly report");
    expect(stripQuotedReply("Sounds good!\n\nOn Tue, Nov 3, 2026 at 9:00 AM Maya <m@x.y> wrote:\n> old")).toBe("Sounds good!");
  });

  it("segments long SMS at sentence boundaries with numbering and caps the parts", () => {
    expect(segmentSms("short")).toEqual(["short"]);
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const parts = segmentSms(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1500)).toBe(true);
    expect(parts[0]).toMatch(/\.\s\(1\/\d\)$/);
    const huge = "word ".repeat(5000);
    const capped = segmentSms(huge, "https://app.roster.test/p/x/d/1");
    expect(capped).toHaveLength(4);
    expect(capped[3]).toContain("Full reply: https://app.roster.test/p/x/d/1");
  });

  it("renders deliverable email safely with a portal link", async () => {
    const r = await renderEmail({
      title: 'Report <img src=x onerror="alert(1)">',
      preview: "Preview",
      markdown: "Hi **there** [click](javascript:alert(1)) [ok](https://example.com)\n\n<script>alert(1)</script>",
      agentName: "Maya",
      orgName: "Brandlord",
      portalUrl: "https://app.roster.test/p/brandlord/d/123",
      branding: { accent: "red;background:url(x)" },
    });
    expect(r.html).not.toContain("<script");
    expect(r.html).not.toContain("<img");
    expect(r.html).not.toContain("javascript:");
    expect(r.html).toContain("&lt;img");
    expect(r.html).toContain("<strong");
    expect(r.html).toContain('href="https://example.com/"');
    expect(r.html).toContain("View in portal");
    expect(r.html).toContain("#4F46E5"); // unsafe accent rejected
    expect(r.text).toContain("View in portal: https://app.roster.test/p/brandlord/d/123");
  });

  it("converts markdown to Slack mrkdwn with escaping", () => {
    expect(markdownToSlack("**Bold** <b> & [link](https://x.y/z)")).toBe("*Bold* &lt;b&gt; &amp; <https://x.y/z|link>");
  });

  it("generates MCP client config snippets", () => {
    const s = mcpConfigSnippet("https://app.roster.test/", "rk_live_ab12…");
    expect(s.url).toBe("https://app.roster.test/api/mcp");
    expect(s.claudeCode).toContain("claude mcp add --transport http roster https://app.roster.test/api/mcp");
    expect(JSON.parse(s.claudeDesktop).mcpServers.roster.args).toContain("mcp-remote@latest");
    expect(s.codex).toContain('bearer_token_env_var = "ROSTER_API_KEY"');
  });
});
