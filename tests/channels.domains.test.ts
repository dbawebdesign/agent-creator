/** White-label email domains: chain resolution, fallback, settings, inbound routing across tenants, outbound. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeOrg, rid, truncateChannelTables } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test", EMAIL_DOMAIN: "agents.roster.test", AUTH_SECRET: "test-auth-secret", EMAIL_AUTHSERV_ID: "mx.resend.com" });
  for (const k of ["RESEND_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];
});

const session = vi.hoisted(() => ({ current: null as null | { id: string; isPlatformAdmin: boolean } }));
vi.mock("@/server/auth/session", () => ({
  getCurrentUser: async () => session.current,
  requireUser: async () => session.current,
  clientIp: () => null,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { db, schema } from "@/server/db/client";
import { agentAddressFor, emailDomainFor, emailDomainsFor, normalizeEmailDomain, resolveInboundDomain, setOrgEmailDomain, removeOrgEmailDomain, getEmailDomainSettings } from "@/server/channels/domains";
import { processResendEvent } from "@/server/channels/inbound";
import { channelDeliver } from "@/server/channels/jobs";
import { getChannelOverview } from "@/server/channels/service";
import { setEmailDomainAction } from "@/server/channels/actions";

const dom = (label: string) => `agents.${label}-${rid(4)}.com`;

/** agency → client → customer, each with an agent. */
async function tree() {
  const agency = await makeOrg({ kind: "agency" });
  const client = await makeOrg({ kind: "client", parentId: agency.id });
  const customer = await makeOrg({ kind: "customer", parentId: client.id });
  return { agency, client, customer, agencyAgent: await makeAgent(agency.id), clientAgent: await makeAgent(client.id), customerAgent: await makeAgent(customer.id) };
}

function inbound(to: string, from = `dana-${rid(3)}@brandlord.co`) {
  return {
    type: "email.received",
    data: { email_id: `em_${rid(8)}`, from, to: [to], subject: "Hi", message_id: `<${rid()}@mail.brandlord.co>`, text: "Hello" },
  };
}

async function inboundCount(orgId: string) {
  return (await db().select().from(schema.messages).where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.direction, "inbound")))).length;
}

beforeEach(async () => {
  session.current = null;
  await truncateChannelTables();
});
afterAll(async () => {
  await cleanupOrgs();
  await db().execute(sql`delete from users where email like '%@domains.test'`);
});

describe("domain validation", () => {
  it("normalizes and rejects junk", () => {
    expect(normalizeEmailDomain(" Agents.Northbeam.AI. ")).toBe("agents.northbeam.ai");
    for (const bad of ["northbeam", "a@b.com", "http://x.com", "-x.com", "x..com", "1.2.3.4", "x.com/a", "ab"]) expect(normalizeEmailDomain(bad)).toBeNull();
  });
});

describe("emailDomainFor: nearest verified domain up the chain", () => {
  it("falls back to env, inherits the agency's, and a client's own domain overrides for its subtree", async () => {
    const t = await tree();
    expect(await emailDomainFor(t.customer.id)).toBe("agents.roster.test");

    const agencyDomain = dom("northbeam");
    await setOrgEmailDomain(t.agency.id, agencyDomain); // simulated → verified (no RESEND_API_KEY)
    const all = await emailDomainsFor([t.agency.id, t.client.id, t.customer.id]);
    expect([...all.values()]).toEqual([agencyDomain, agencyDomain, agencyDomain]);
    expect(await agentAddressFor(t.customerAgent)).toBe(`${t.customerAgent.emailHandle}@${agencyDomain}`);

    const clientDomain = dom("brandlord");
    await setOrgEmailDomain(t.client.id, clientDomain);
    expect(await emailDomainFor(t.agency.id)).toBe(agencyDomain);
    expect(await emailDomainFor(t.client.id)).toBe(clientDomain);
    expect(await emailDomainFor(t.customer.id)).toBe(clientDomain);

    // A pending (unverified) domain is ignored.
    await db().update(schema.emailDomains).set({ status: "pending" }).where(eq(schema.emailDomains.orgId, t.client.id));
    expect(await emailDomainFor(t.customer.id)).toBe(agencyDomain);

    await removeOrgEmailDomain(t.agency.id);
    expect(await emailDomainFor(t.customer.id)).toBe("agents.roster.test");
    expect((await getEmailDomainSettings(t.client.id)).current).toMatchObject({ domain: clientDomain, status: "pending" });
  });

  it("settings: one domain per org, unique across orgs, never the platform domain; admins of agency/client only", async () => {
    const a = await makeOrg({ kind: "agency" });
    const b = await makeOrg({ kind: "agency" });
    const d = dom("shared");
    await setOrgEmailDomain(a.id, d);
    await expect(setOrgEmailDomain(b.id, d.toUpperCase())).rejects.toThrow(/already in use/);
    await expect(setOrgEmailDomain(b.id, "agents.roster.test")).rejects.toThrow(/platform/);
    await expect(setOrgEmailDomain(b.id, "x.agents.roster.test")).rejects.toThrow(/platform/);
    await expect(setOrgEmailDomain(b.id, "not a domain")).rejects.toThrow(/Enter a domain/);
    const replaced = await setOrgEmailDomain(a.id, dom("new"));
    expect((await db().select().from(schema.emailDomains).where(eq(schema.emailDomains.orgId, a.id))).map((r) => r.domain)).toEqual([replaced.domain]);

    const [owner] = await db().insert(schema.users).values({ email: `o-${rid()}@domains.test` }).returning();
    await db().insert(schema.memberships).values({ userId: owner!.id, orgId: b.id, role: "owner" });
    const customer = await makeOrg({ kind: "customer", parentId: b.id });
    expect(await setEmailDomainAction({ orgId: b.id, domain: dom("b") })).toEqual({ ok: false, error: "Not found" }); // signed out
    session.current = { id: owner!.id, isPlatformAdmin: false };
    expect(await setEmailDomainAction({ orgId: a.id, domain: dom("x") })).toEqual({ ok: false, error: "Not found" }); // other agency
    expect(await setEmailDomainAction({ orgId: customer.id, domain: dom("c") })).toEqual({ ok: false, error: "Not found" }); // customers can't
    const ok = await setEmailDomainAction({ orgId: b.id, domain: dom("b") });
    expect(ok).toMatchObject({ ok: true, domain: { status: "verified", simulated: true } });
  });
});

describe("inbound routing across tenants", () => {
  it("accepts the env domain and verified org domains; rejects other tenants' and unverified domains", async () => {
    const t = await tree();
    const other = await tree();
    const agencyDomain = dom("nb");
    const otherDomain = dom("rival");
    await setOrgEmailDomain(t.agency.id, agencyDomain);
    await setOrgEmailDomain(other.agency.id, otherDomain);

    expect(await resolveInboundDomain("AGENTS.roster.test")).toEqual({ platform: true });
    expect(await resolveInboundDomain(agencyDomain)).toEqual({ platform: false, orgId: t.agency.id });
    expect(await resolveInboundDomain("agents.unknown.example")).toBeNull();

    // Own domain (customer agent under the agency) and the platform domain both reach the agent.
    expect(await processResendEvent(db(), inbound(`${t.customerAgent.emailHandle}@${agencyDomain}`))).toBe("stored");
    expect(await processResendEvent(db(), inbound(`${t.customerAgent.emailHandle}+quotes@agents.roster.test`))).toBe("stored");
    expect(await inboundCount(t.customer.id)).toBe(2);

    // Another tenant's verified domain can't reach this agent (handle spoofed across tenants).
    expect(await processResendEvent(db(), inbound(`${t.customerAgent.emailHandle}@${otherDomain}`))).toBe("ignored:no-agent");
    // A domain that isn't ours / isn't verified yet: dropped.
    expect(await processResendEvent(db(), inbound(`${t.agencyAgent.emailHandle}@agents.unknown.example`))).toBe("ignored:no-agent");
    await db().update(schema.emailDomains).set({ status: "pending" }).where(eq(schema.emailDomains.orgId, other.agency.id));
    expect(await processResendEvent(db(), inbound(`${other.agencyAgent.emailHandle}@${otherDomain}`))).toBe("ignored:no-agent");
    expect(await inboundCount(t.customer.id)).toBe(2);
    expect(await inboundCount(other.agency.id)).toBe(0);

    // Mail from any of our domains is an agent↔agent loop.
    expect(await processResendEvent(db(), inbound(`${t.agencyAgent.emailHandle}@${agencyDomain}`, `bot@${agencyDomain}`))).toBe("ignored:loop");
    expect(await processResendEvent(db(), inbound(`${t.agencyAgent.emailHandle}@${agencyDomain}`, "bot@agents.roster.test"))).toBe("ignored:loop");
  });
});

describe("addresses shown and sent", () => {
  it("overview, outbound From/Reply-To/Message-ID use the org's domain", async () => {
    const t = await tree();
    const agencyDomain = dom("send");
    await setOrgEmailDomain(t.agency.id, agencyDomain);
    const ov = await getChannelOverview(t.client.id);
    expect(ov.emailDomain).toBe(agencyDomain);
    expect(ov.agents.find((a) => a.agentId === t.clientAgent.id)!.email.address).toBe(`${t.clientAgent.emailHandle}@${agencyDomain}`);

    await processResendEvent(db(), inbound(`${t.clientAgent.emailHandle}@${agencyDomain}`, `dana-${rid(3)}@brandlord.co`));
    const [conv] = await db().select().from(schema.conversations).where(eq(schema.conversations.orgId, t.client.id));
    const [out] = await db().insert(schema.messages).values({ orgId: t.client.id, conversationId: conv!.id, direction: "outbound", author: "agent", body: "Thanks!" }).returning();
    await channelDeliver({ orgId: t.client.id, agentId: t.clientAgent.id, channel: "email", messageId: out!.id }, { db: db(), jobId: `d-${rid()}` });
    const [sent] = await db().select().from(schema.messages).where(eq(schema.messages.id, out!.id));
    expect(sent!.deliveryStatus).toBe("sent");
    expect(String(sent!.meta.emailMessageId)).toMatch(new RegExp(`@${agencyDomain.replace(/\./g, "\\.")}>$`));
  });
});
