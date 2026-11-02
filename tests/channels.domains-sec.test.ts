/**
 * Security r3 regressions (ported from the critic's proof, /tmp/sec3/tests/sec3/domains.test.ts):
 * M1 domain claims (squatting, free-mail, no-DNS verification surviving a key/production) and
 * M2 the loop check (a verified domain must not silence that domain's humans for every tenant).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeOrg, rid, truncateChannelTables } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test", EMAIL_DOMAIN: "agents.roster.test", AUTH_SECRET: "x".repeat(40), EMAIL_AUTHSERV_ID: "mx.resend.com" });
  for (const k of ["RESEND_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];
});

const dns = vi.hoisted(() => ({ txt: new Map<string, string[][]>() }));
vi.mock("node:dns/promises", () => ({
  resolveTxt: async (name: string) => {
    const v = dns.txt.get(name);
    if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return v;
  },
}));

import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { checkOrgEmailDomain, CLAIM_TTL_MS, emailDomainFor, getEmailDomainSettings, resolveInboundDomain, setOrgEmailDomain } from "@/server/channels/domains";
import { processResendEvent } from "@/server/channels/inbound";
import { newMessageId } from "@/server/channels/email";

type MutableEnv = { RESEND_API_KEY?: string; NODE_ENV: string };
const mutable = () => env() as unknown as MutableEnv;
const realFetch = globalThis.fetch;

/** Resend Domains API double: every domain id reports `status` (default "not_started"). */
function mockResend(status: () => string = () => "not_started") {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/verify")) return Response.json({ object: "domain" });
    const records = [{ record: "SPF", name: "send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }];
    return Response.json({ id: `d_${url.split("/").pop()}`, status: status(), records });
  }) as typeof fetch;
}

function inbound(to: string, from: string, extra: Record<string, unknown> = {}) {
  return { type: "email.received", data: { email_id: `em_${rid(8)}`, from, to: [to], subject: "Hi", message_id: `<${rid()}@x.example>`, text: "Hello, please quote 200 mugs", ...extra } };
}

beforeEach(async () => {
  await truncateChannelTables();
  dns.txt.clear();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mutable().RESEND_API_KEY = undefined;
  mutable().NODE_ENV = "test";
});
afterAll(async () => {
  await cleanupOrgs();
});

describe("M2: loop check is per agent address, not per domain", () => {
  it("one tenant verifying a domain no longer silences that domain's people for other tenants", async () => {
    const a = await makeOrg({ kind: "agency" });
    const dom = `bigclient-${rid(3)}.com`;
    expect((await setOrgEmailDomain(a.id, dom)).status).toBe("verified"); // dev: simulated
    const b = await makeOrg({ kind: "agency" });
    const bc = await makeOrg({ kind: "client", parentId: b.id });
    const agentB = await makeAgent(bc.id);
    expect(await processResendEvent(db(), inbound(`${agentB.emailHandle}@agents.roster.test`, `buyer@${dom}`))).toBe("stored");
    expect(await db().select().from(schema.messages).where(and(eq(schema.messages.orgId, bc.id)))).toHaveLength(1);
  });

  it("our own mail is still a loop: agent From, our Message-ID, or our loop header", async () => {
    const org = await makeOrg({ kind: "agency" });
    const agent = await makeAgent(org.id);
    const peer = await makeAgent(org.id);
    const to = `${agent.emailHandle}@agents.roster.test`;
    expect(await processResendEvent(db(), inbound(to, `${peer.emailHandle}@agents.roster.test`))).toBe("ignored:loop");
    expect(await processResendEvent(db(), inbound(to, "relay@forwarder.example", { message_id: newMessageId("agents.roster.test") }))).toBe("ignored:loop");
    expect(await processResendEvent(db(), inbound(to, "relay@forwarder.example", { headers: { "X-Roster-Loop": "1" } }))).toBe("ignored:loop");
    // A Message-ID that merely uses our domain but not our format is someone else's mail.
    expect(await processResendEvent(db(), inbound(to, "relay@forwarder.example", { message_id: "<hello@agents.roster.test>" }))).toBe("stored");
  });
});

describe("M1: domain claims", () => {
  it("refuses mailbox providers and public suffixes", async () => {
    const a = await makeOrg({ kind: "agency" });
    for (const d of ["gmail.com", "Outlook.com", "yahoo.com", "icloud.com", "agents.gmail.com", "co.uk", "github.io", "vercel.app"]) {
      await expect(setOrgEmailDomain(a.id, d)).rejects.toThrow(/mailbox provider|public suffix/);
    }
    expect(await resolveInboundDomain("gmail.com")).toBeNull();
    const b = await makeOrg({ kind: "client" });
    const agentB = await makeAgent(b.id);
    expect(await processResendEvent(db(), inbound(`${agentB.emailHandle}@agents.roster.test`, "someone@gmail.com"))).toBe("stored");
    // A real domain under a public suffix is fine.
    expect((await setOrgEmailDomain(a.id, `agents.acme-${rid(3)}.co.uk`)).status).toBe("verified");
  });

  it("production never verifies without DNS: no key → pending with a plain note", async () => {
    mutable().NODE_ENV = "production";
    const a = await makeOrg({ kind: "agency" });
    const dom = `agents.prod-${rid(3)}.com`;
    const row = await setOrgEmailDomain(a.id, dom);
    expect(row).toMatchObject({ status: "pending", simulated: false, note: expect.stringContaining("Connect email sending") });
    expect(row.records.some((r) => r.type === "TXT" && r.name === `_roster-verify.${dom}`)).toBe(true);
    expect(await resolveInboundDomain(dom)).toBeNull();
    expect(await emailDomainFor(a.id)).toBe("agents.roster.test");
    expect((await checkOrgEmailDomain(a.id)).status).toBe("pending");
  });

  it("a test-mode (simulated) verification stops counting once a key is configured, and must re-verify", async () => {
    const a = await makeOrg({ kind: "agency" });
    const dom = `victim-${rid(3)}.com`;
    await setOrgEmailDomain(a.id, dom);
    expect(await resolveInboundDomain(dom)).toEqual({ platform: false, orgId: a.id });
    mutable().RESEND_API_KEY = "re_test";
    mockResend();
    expect(await resolveInboundDomain(dom)).toBeNull();
    expect(await emailDomainFor(a.id)).toBe("agents.roster.test");
    expect((await getEmailDomainSettings(a.id)).current).toMatchObject({ status: "pending" });
    const after = await checkOrgEmailDomain(a.id);
    expect(after).toMatchObject({ status: "pending", simulated: false });
    expect(await resolveInboundDomain(dom)).toBeNull();
  });

  it("a pending claim doesn't block the real owner; the first claim verified by DNS wins", async () => {
    mutable().RESEND_API_KEY = "re_test";
    let providerStatus = "not_started";
    mockResend(() => providerStatus);
    const squatter = await makeOrg({ kind: "agency" });
    const owner = await makeOrg({ kind: "agency" });
    const dom = `agents.realowner-${rid(3)}.com`;
    const s = await setOrgEmailDomain(squatter.id, dom);
    expect(s.status).toBe("pending");
    const o = await setOrgEmailDomain(owner.id, dom); // no longer "already in use"
    expect(o.status).toBe("pending");
    expect(o.token).not.toBe(s.token);

    // Resend's records are shared, so they prove nothing about WHO claims it: the squatter can't verify
    // without the owner's ownership TXT.
    providerStatus = "verified";
    dns.txt.set(`_roster-verify.${dom}`, [[`roster-verify=${o.token}`]]);
    expect((await checkOrgEmailDomain(squatter.id)).status).toBe("pending");
    expect((await checkOrgEmailDomain(owner.id)).status).toBe("verified");
    const [lost] = await db().select().from(schema.emailDomains).where(eq(schema.emailDomains.orgId, squatter.id));
    expect(lost).toMatchObject({ status: "failed" });
    expect(await resolveInboundDomain(dom)).toEqual({ platform: false, orgId: owner.id });
    // Now it's taken.
    const late = await makeOrg({ kind: "agency" });
    await expect(setOrgEmailDomain(late.id, dom)).rejects.toThrow(/already in use/);
  });

  it("pending claims expire", async () => {
    mutable().RESEND_API_KEY = "re_test";
    mockResend();
    const a = await makeOrg({ kind: "agency" });
    const dom = `agents.slow-${rid(3)}.com`;
    await setOrgEmailDomain(a.id, dom);
    await db().update(schema.emailDomains).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.emailDomains.orgId, a.id));
    expect(await checkOrgEmailDomain(a.id)).toMatchObject({ status: "failed", note: expect.stringContaining("expired") });
    expect(CLAIM_TTL_MS).toBe(72 * 3600_000);
    // Setting it again restarts the claim.
    expect((await setOrgEmailDomain(a.id, dom)).status).toBe("pending");
  });
});
