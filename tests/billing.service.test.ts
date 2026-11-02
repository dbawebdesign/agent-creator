/** Billing service + actions: Connect onboarding, plan sync, checkout, portal, cancel, authorization, no-key mode. */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test" });
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.PLATFORM_FEE_BPS;
});

const session = vi.hoisted(() => ({ current: null as null | { id: string; isPlatformAdmin: boolean } }));
vi.mock("@/server/auth/session", () => ({
  getCurrentUser: async () => session.current,
  requireUser: async () => {
    if (!session.current) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    return session.current;
  },
  clientIp: () => null,
}));

import { db, schema } from "@/server/db/client";
import { cancelBuyerSubscription, loadBillingStatus, openBillingPortal, startCheckout, startStripeConnect, syncPlan } from "@/server/billing/actions";
import { appUrl, getBillingStatus } from "@/server/billing/service";
import { setStripeFactory } from "@/server/billing/stripe";
import { GET as connectRoute } from "@/app/api/billing/connect/route";
import { GET as connectReturnRoute } from "@/app/api/billing/connect/return/route";
import { cleanup, connectAccount, FakeStripeApi, makeTree, makeUser } from "./billing.fixtures";

type Tree = Awaited<ReturnType<typeof makeTree>>;
let t: Tree;
let api: FakeStripeApi;

function withKey() {
  process.env.STRIPE_SECRET_KEY = "sk_test_bt_fake";
}

beforeEach(async () => {
  await cleanup();
  t = await makeTree();
  api = new FakeStripeApi();
  setStripeFactory(api.client);
  session.current = null;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.PLATFORM_FEE_BPS;
});
afterEach(() => setStripeFactory(null));
afterAll(cleanup);

describe("no-key mode (graceful)", () => {
  it("reports disabled and every money action fails softly without calling Stripe", async () => {
    session.current = await makeUser(t.client.id, "admin");
    const status = await getBillingStatus(t.client.id);
    expect(status.mode).toBe("disabled");
    expect(status.seller).toMatchObject({ connected: false, chargesEnabled: false });
    expect(status.buyer).toMatchObject({ subscription: null, sellerReady: false });

    const r1 = await startCheckout(t.client.id, t.plan.id, { returnPath: "/p/x/settings" });
    expect(r1).toMatchObject({ ok: false, code: "not_configured" });
    expect((r1 as { error: string }).error).toMatch(/test mode/i);
    expect(await startStripeConnect(t.client.id, "/p/x/resell")).toMatchObject({ ok: false, code: "not_configured" });
    expect(await openBillingPortal(t.client.id, "/p/x")).toMatchObject({ ok: false, code: "not_configured" });
    expect(await syncPlan(t.resalePlan.id)).toMatchObject({ ok: false, code: "not_configured" });
    expect(api.calls).toHaveLength(0);

    // Manual subscriptions still cancel locally.
    const [sub] = await db().insert(schema.subscriptions).values({ orgId: t.client.id, planId: t.plan.id, status: "active" }).returning();
    expect(await cancelBuyerSubscription(sub!.id)).toMatchObject({ ok: true, status: "canceled" });
  });

  it("the connect route redirects back with a flag instead of crashing", async () => {
    session.current = await makeUser(t.agency.id, "owner");
    const res = await connectRoute(new Request(`https://app.roster.test/api/billing/connect?org=${t.agency.id}&return=/a/x/billing`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.roster.test/a/x/billing?billing=not_configured");
  });
});

describe("Connect onboarding", () => {
  it("creates a Standard account once and returns a hosted onboarding link", async () => {
    withKey();
    session.current = await makeUser(t.agency.id, "owner");
    const r = await startStripeConnect(t.agency.id, "/a/northbeam/billing");
    expect(r.ok).toBe(true);
    expect((r as { url: string }).url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    const [create] = api.find("POST", "/v1/accounts");
    expect(create?.params.get("type")).toBe("standard");
    expect(create?.idempotencyKey).toMatch(/^roster:account:/);
    const [link] = api.find("POST", "/v1/account_links");
    expect(link?.params.get("type")).toBe("account_onboarding");
    expect(link?.params.get("return_url")).toContain("https://app.roster.test/api/billing/connect/return?org=");
    expect(link?.params.get("refresh_url")).toContain("https://app.roster.test/api/billing/connect?org=");

    // GET (Stripe's refresh_url / CSRF-able) never creates an account for an org that has none.
    const other = await makeUser(t.sibling.id, "owner");
    session.current = other;
    const refresh = await connectRoute(new Request(`https://app.roster.test/api/billing/connect?org=${t.sibling.id}&return=/p/x/resell`));
    expect(refresh.headers.get("location")).toBe("https://app.roster.test/p/x/resell?billing=not_connected");
    session.current = await makeUser(t.agency.id, "owner");
    const resumed = await connectRoute(new Request(`https://app.roster.test/api/billing/connect?org=${t.agency.id}&return=/a/northbeam/billing`));
    expect(resumed.headers.get("location")).toMatch(/^https:\/\/connect\.stripe\.com\//);

    await startStripeConnect(t.agency.id, "/a/northbeam/billing");
    expect(api.find("POST", "/v1/accounts")).toHaveLength(1);
    expect(api.find("POST", "/v1/account_links")).toHaveLength(3);

    // Return from Stripe → account state refreshed → back into the app.
    const res = await connectReturnRoute(new Request(`https://app.roster.test/api/billing/connect/return?org=${t.agency.id}&next=/a/northbeam/billing`));
    expect(res.headers.get("location")).toBe("https://app.roster.test/a/northbeam/billing?billing=connected");
    const status = await getBillingStatus(t.agency.id);
    expect(status.seller).toMatchObject({ connected: true, chargesEnabled: true });
    expect(status.seller?.accountHint).toMatch(/^acct_…/);
  });

  it("only the seller's own admins can connect (not inherited agency staff, not members)", async () => {
    withKey();
    session.current = await makeUser(t.agency.id, "owner");
    expect(await startStripeConnect(t.client.id, "/p/x/resell")).toMatchObject({ ok: false, code: "invalid" });
    session.current = await makeUser(t.client.id, "member");
    expect(await startStripeConnect(t.client.id, "/p/x/resell")).toMatchObject({ ok: false, code: "not_found" });
    session.current = await makeUser(t.client.id, "admin");
    expect(await startStripeConnect(t.agency.id, "/a/x")).toMatchObject({ ok: false, code: "not_found" });
    expect(await startStripeConnect(t.client.id, "https://evil.example/phish")).toMatchObject({ ok: false });
    expect(api.calls).toHaveLength(0);
    expect(await startStripeConnect(t.client.id, "/p/x/resell")).toMatchObject({ ok: true });
  });
});

describe("plan sync", () => {
  it("creates a product, a monthly price and a setup-fee price on the seller's account; re-prices on change", async () => {
    withKey();
    await connectAccount(t.client.id, "acct_bt_client");
    session.current = await makeUser(t.client.id, "admin");
    expect(await syncPlan(t.resalePlan.id)).toMatchObject({ ok: true });
    const prices = api.find("POST", "/v1/prices");
    expect(prices).toHaveLength(2);
    expect(prices.every((c) => c.account === "acct_bt_client" && c.idempotencyKey?.startsWith("roster:"))).toBe(true);
    const monthly = prices.find((c) => c.params.get("recurring[interval]") === "month");
    expect(monthly?.params.get("unit_amount")).toBe("120000");
    const setup = prices.find((c) => !c.params.get("recurring[interval]"));
    expect(setup?.params.get("unit_amount")).toBe("50000");
    expect(api.find("POST", "/v1/products")[0]?.account).toBe("acct_bt_client");

    // Idempotent: nothing changed → no new prices.
    await syncPlan(t.resalePlan.id);
    expect(api.find("POST", "/v1/prices")).toHaveLength(2);

    await db().update(schema.plans).set({ priceCents: 150_000 }).where(eq(schema.plans.id, t.resalePlan.id));
    await syncPlan(t.resalePlan.id);
    expect(api.find("POST", "/v1/prices")).toHaveLength(3);
    expect(api.find("POST", /^\/v1\/prices\/price_/).some((c) => c.params.get("active") === "false")).toBe(true);
    const [row] = await db().select().from(schema.billingPrices).where(eq(schema.billingPrices.planId, t.resalePlan.id));
    expect(row).toMatchObject({ unitAmount: 150_000, stripeAccountId: "acct_bt_client" });
    const [plan] = await db().select().from(schema.plans).where(eq(schema.plans.id, t.resalePlan.id));
    expect(plan?.stripePriceId).toBe(row?.stripePriceId);
  });

  it("a non-seller can't sync someone else's plan", async () => {
    withKey();
    await connectAccount(t.agency.id, "acct_bt_agency");
    session.current = await makeUser(t.client.id, "owner");
    expect(await syncPlan(t.plan.id)).toMatchObject({ ok: false, code: "not_found" });
    session.current = await makeUser(t.sibling.id, "owner");
    expect(await syncPlan(t.resalePlan.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(api.calls).toHaveLength(0);
  });
});

describe("checkout", () => {
  it("opens a subscription-mode session on the agency's connected account, with platform fee and idempotency", async () => {
    withKey();
    process.env.PLATFORM_FEE_BPS = "250";
    await connectAccount(t.agency.id, "acct_bt_agency");
    session.current = await makeUser(t.client.id, "admin");
    const r = await startCheckout(t.client.id, t.plan.id, { returnPath: `/p/${t.client.slug}/settings` });
    expect(r).toMatchObject({ ok: true });
    expect((r as { url: string }).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [cs] = api.find("POST", "/v1/checkout/sessions");
    expect(cs?.account).toBe("acct_bt_agency");
    expect(cs?.idempotencyKey).toMatch(/^roster:checkout:/);
    expect(cs?.params.get("mode")).toBe("subscription");
    expect(cs?.params.get("line_items[0][price]")).toMatch(/^price_/);
    expect(cs?.params.get("line_items[1][price]")).toBeNull(); // no setup fee on this plan
    expect(cs?.params.get("subscription_data[application_fee_percent]")).toBe("2.5");
    expect(cs?.params.get("subscription_data[metadata][roster_buyer_org_id]")).toBe(t.client.id);
    expect(cs?.params.get("success_url")).toBe(`https://app.roster.test/p/${t.client.slug}/settings?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    expect(cs?.params.get("customer")).toMatch(/^cus_/);
    expect(api.find("POST", "/v1/customers")[0]?.account).toBe("acct_bt_agency");

    // Second checkout reuses the customer; the session request carries the same idempotency key.
    await startCheckout(t.client.id, t.plan.id, { returnPath: `/p/${t.client.slug}/settings` });
    expect(api.find("POST", "/v1/customers")).toHaveLength(1);
    const keys = api.find("POST", "/v1/checkout/sessions").map((c) => c.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);

    const audit = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, t.agency.id), eq(schema.auditLogs.action, "billing.checkout_created")));
    expect(audit.length).toBeGreaterThan(0);
  });

  it("a client reselling to its customer bills from the client's own account, setup fee included", async () => {
    withKey();
    await connectAccount(t.client.id, "acct_bt_client");
    session.current = await makeUser(t.client.id, "admin"); // the seller's admin creating a link for its customer
    expect(await startCheckout(t.customer.id, t.resalePlan.id, { returnPath: "/p/x/resell" })).toMatchObject({ ok: true });
    const [cs] = api.find("POST", "/v1/checkout/sessions");
    expect(cs?.account).toBe("acct_bt_client");
    expect(cs?.params.get("line_items[1][price]")).toMatch(/^price_/);
  });

  it("authorization: no checkout for another org, for a plan the buyer's parent doesn't sell, or as a member", async () => {
    withKey();
    await connectAccount(t.agency.id, "acct_bt_agency");
    await connectAccount(t.client.id, "acct_bt_client");
    session.current = await makeUser(t.client.id, "admin");
    expect(await startCheckout(t.sibling.id, t.plan.id)).toMatchObject({ ok: false, code: "not_found" });
    // Client admin buying its own resale plan for itself (seller ≠ parent).
    expect(await startCheckout(t.client.id, t.resalePlan.id)).toMatchObject({ ok: false, code: "not_found" });
    session.current = await makeUser(t.client.id, "member");
    expect(await startCheckout(t.client.id, t.plan.id)).toMatchObject({ ok: false, code: "not_found" });
    session.current = null;
    await expect(startCheckout(t.client.id, t.plan.id)).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
    expect(api.find("POST", "/v1/checkout/sessions")).toHaveLength(0);

    // Agency admin creating a link to send to its client: allowed.
    session.current = await makeUser(t.agency.id, "admin");
    expect(await startCheckout(t.client.id, t.plan.id)).toMatchObject({ ok: true });
    // …but not for another agency's client.
    const other = await makeTree();
    expect(await startCheckout(other.client.id, other.plan.id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses when the seller can't take payments, when already subscribed, and for off-site return URLs", async () => {
    withKey();
    session.current = await makeUser(t.client.id, "admin");
    expect(await startCheckout(t.client.id, t.plan.id)).toMatchObject({ ok: false, code: "not_connected" });
    await connectAccount(t.agency.id, "acct_bt_agency", false);
    expect(await startCheckout(t.client.id, t.plan.id)).toMatchObject({ ok: false, code: "charges_disabled" });
    await db().update(schema.billingAccounts).set({ chargesEnabled: true }).where(eq(schema.billingAccounts.orgId, t.agency.id));
    expect(await startCheckout(t.client.id, t.plan.id, { returnPath: "//evil.example" })).toMatchObject({ ok: false, code: "invalid" });
    expect(() => appUrl("https://evil.example/x")).toThrow();
    expect(appUrl("https://app.roster.test/p/x")).toBe("https://app.roster.test/p/x");
    await db().insert(schema.subscriptions).values({ orgId: t.client.id, planId: t.plan.id, status: "active", stripeSubscriptionId: "sub_bt_live", stripeAccountId: "acct_bt_agency" });
    expect(await startCheckout(t.client.id, t.plan.id)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("surfaces Stripe errors as calm messages", async () => {
    withKey();
    await connectAccount(t.agency.id, "acct_bt_agency");
    api.fail = { path: /checkout\/sessions/, status: 400, body: { error: { type: "invalid_request_error", message: "secret internal detail" } } };
    session.current = await makeUser(t.client.id, "admin");
    const r = await startCheckout(t.client.id, t.plan.id);
    expect(r).toMatchObject({ ok: false, code: "stripe_error" });
    expect((r as { error: string }).error).not.toContain("secret internal detail");
  });
});

describe("portal, cancel, status", () => {
  it("opens the customer portal on the seller's account and cancels at period end", async () => {
    withKey();
    await connectAccount(t.agency.id, "acct_bt_agency");
    session.current = await makeUser(t.client.id, "admin");
    expect(await openBillingPortal(t.client.id, "/p/x/settings")).toMatchObject({ ok: false, code: "not_found" });
    await db().insert(schema.billingCustomers).values({ orgId: t.client.id, stripeAccountId: "acct_bt_agency", stripeCustomerId: "cus_bt_1" });
    session.current = await makeUser(t.agency.id, "owner");
    expect(await openBillingPortal(t.client.id, "/p/x/settings")).toMatchObject({ ok: false, code: "invalid" });
    session.current = await makeUser(t.client.id, "admin");
    const r = await openBillingPortal(t.client.id, "/p/x/settings");
    expect(r).toMatchObject({ ok: true });
    const [ps] = api.find("POST", "/v1/billing_portal/sessions");
    expect(ps).toMatchObject({ account: "acct_bt_agency" });
    expect(ps?.params.get("customer")).toBe("cus_bt_1");
    expect(ps?.params.get("return_url")).toBe("https://app.roster.test/p/x/settings");

    const [sub] = await db().insert(schema.subscriptions).values({ orgId: t.client.id, planId: t.plan.id, status: "active", stripeSubscriptionId: "sub_bt_c", stripeAccountId: "acct_bt_agency" }).returning();
    session.current = await makeUser(t.sibling.id, "owner");
    expect(await cancelBuyerSubscription(sub!.id)).toMatchObject({ ok: false, code: "not_found" });
    session.current = await makeUser(t.client.id, "admin");
    expect(await cancelBuyerSubscription(sub!.id)).toMatchObject({ ok: true, status: "active", cancelAtPeriodEnd: true });
    const [upd] = api.find("POST", "/v1/subscriptions/sub_bt_c");
    expect(upd?.params.get("cancel_at_period_end")).toBe("true");
    expect(upd?.account).toBe("acct_bt_agency");

    const st = await loadBillingStatus(t.client.id);
    expect(st).toMatchObject({ ok: true, status: { mode: "test", buyer: { hasBillingProfile: true, sellerReady: true, subscription: { status: "active", cancelAtPeriodEnd: true, stripeManaged: true } } } });
    session.current = await makeUser(t.sibling.id, "owner");
    expect(await loadBillingStatus(t.client.id)).toMatchObject({ ok: false, code: "not_found" });
  });
});
