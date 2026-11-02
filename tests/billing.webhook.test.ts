/** Stripe webhook: signature, replay, idempotency, status transitions, Connect account cross-checks. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const SECRET = "whsec_bt_platform_secret_0123456789";
const CONNECT_SECRET = "whsec_bt_connect_secret_9876543210";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;

import { db, schema } from "@/server/db/client";
import { POST as stripeRoute } from "@/app/api/webhooks/stripe/route";
import { cleanup, connectAccount, makeTree, stripeEvent, stripeRequest } from "./billing.fixtures";

type Tree = Awaited<ReturnType<typeof makeTree>>;
let t: Tree;
const ACCT = () => `acct_bt_${t.agency.id.slice(0, 8)}`;

async function send(event: object, secret = CONNECT_SECRET, opts: Parameters<typeof stripeRequest>[2] = {}) {
  const res = await stripeRoute(stripeRequest(event, secret, opts));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; duplicate?: boolean; handled?: boolean } };
}

async function subRow(stripeSubId: string) {
  return (await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, stripeSubId)))[0];
}

function checkoutCompleted(stripeSubId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `cs_test_${stripeSubId}`,
    object: "checkout.session",
    mode: "subscription",
    payment_status: "paid",
    customer: `cus_${stripeSubId}`,
    subscription: stripeSubId,
    metadata: { roster_buyer_org_id: t.client.id, roster_plan_id: t.plan.id, roster_seller_org_id: t.agency.id },
    ...overrides,
  };
}

function subscriptionObj(stripeSubId: string, status: string, periodEnd: number, extra: Record<string, unknown> = {}) {
  return {
    id: stripeSubId,
    object: "subscription",
    status,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    metadata: { roster_buyer_org_id: t.client.id, roster_plan_id: t.plan.id },
    items: { object: "list", data: [{ id: "si_1", object: "subscription_item", current_period_end: periodEnd }] },
    ...extra,
  };
}

function invoiceObj(stripeSubId: string, periodEnd: number) {
  return {
    id: `in_${Math.random().toString(36).slice(2, 10)}`,
    object: "invoice",
    amount_due: 500_000,
    currency: "usd",
    attempt_count: 1,
    parent: { type: "subscription_details", subscription_details: { subscription: stripeSubId, metadata: {} } },
    lines: { object: "list", data: [{ id: "il_1", period: { start: periodEnd - 2_592_000, end: periodEnd } }] },
  };
}

beforeEach(async () => {
  await cleanup();
  t = await makeTree();
  await connectAccount(t.agency.id, ACCT());
});
afterAll(cleanup);

describe("signature verification", () => {
  it("accepts a valid signature from either configured secret", async () => {
    const e1 = stripeEvent("customer.created", { id: "cus_x", object: "customer" });
    expect((await send(e1, SECRET)).status).toBe(200);
    const e2 = stripeEvent("customer.created", { id: "cus_y", object: "customer" }, { account: ACCT() });
    const r = await send(e2, CONNECT_SECRET);
    expect(r.status).toBe(200);
    expect(r.body.handled).toBe(false);
  });

  it("rejects a wrong secret, a tampered body, a missing header and a stale timestamp", async () => {
    const e = stripeEvent("checkout.session.completed", checkoutCompleted("sub_bt_bad"), { account: ACCT() });
    expect((await send(e, "whsec_attacker")).status).toBe(401);
    const good = stripeRequest(e, CONNECT_SECRET);
    const sig = good.headers.get("stripe-signature")!;
    const tampered = JSON.stringify({ ...e, data: { object: { ...checkoutCompleted("sub_bt_bad"), payment_status: "paid", metadata: { roster_buyer_org_id: t.sibling.id, roster_plan_id: t.plan.id } } } });
    expect((await send(e, CONNECT_SECRET, { body: tampered, signature: sig })).status).toBe(401);
    const noHeader = await stripeRoute(new Request("https://app.roster.test/api/webhooks/stripe", { method: "POST", body: JSON.stringify(e) }));
    expect(noHeader.status).toBe(401);
    // Replay of a captured delivery outside the 5-minute tolerance.
    expect((await send(e, CONNECT_SECRET, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect(await subRow("sub_bt_bad")).toBeUndefined();
  });

  it("rejects everything when no webhook secret is configured", async () => {
    const saved = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET];
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    try {
      const e = stripeEvent("customer.created", { id: "cus_z", object: "customer" });
      expect((await send(e, SECRET)).status).toBe(401);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved[0];
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = saved[1];
    }
  });
});

describe("idempotency", () => {
  it("processes a redelivered event exactly once", async () => {
    const e = stripeEvent("invoice.payment_failed", invoiceObj("sub_bt_idem", 0), { account: ACCT() });
    await send(stripeEvent("checkout.session.completed", checkoutCompleted("sub_bt_idem"), { account: ACCT() }));
    const first = await send(e);
    const second = await send(e); // same event id, fresh valid signature
    expect(first.body).toMatchObject({ ok: true, duplicate: false, handled: true });
    expect(second.body).toMatchObject({ ok: true, duplicate: true });
    const notes = await db().select().from(schema.notifications).where(and(eq(schema.notifications.orgId, t.agency.id), eq(schema.notifications.kind, "billing.payment_failed")));
    expect(notes).toHaveLength(1);
    const rows = await db().select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.provider, "stripe"), eq(schema.webhookEvents.externalId, e.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processedAt).not.toBeNull();
  });

  it("checkout.session.completed and customer.subscription.created in either order make one row", async () => {
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    await send(stripeEvent("customer.subscription.created", subscriptionObj("sub_bt_order", "active", end), { account: ACCT() }));
    await send(stripeEvent("checkout.session.completed", checkoutCompleted("sub_bt_order"), { account: ACCT() }));
    const rows = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, t.client.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", stripeAccountId: ACCT() });
    expect(rows[0]!.currentPeriodEnd?.getTime()).toBe(end * 1000);
    const cust = await db().select().from(schema.billingCustomers).where(eq(schema.billingCustomers.orgId, t.client.id));
    expect(cust[0]?.stripeCustomerId).toBe("cus_sub_bt_order");
  });
});

describe("status transitions", () => {
  it("active → past_due (+ agency notification) → active → cancels at period end → canceled", async () => {
    const now = Math.floor(Date.now() / 1000);
    const end1 = now + 30 * 86400;
    const end2 = now + 60 * 86400;
    // A manual (pre-Stripe) row for the same plan is adopted, not duplicated.
    await db().insert(schema.subscriptions).values({ orgId: t.client.id, planId: t.plan.id, status: "active" });

    await send(stripeEvent("checkout.session.completed", checkoutCompleted("sub_bt_flow"), { account: ACCT(), created: now }));
    expect((await subRow("sub_bt_flow"))?.status).toBe("active");
    expect(await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, t.client.id))).toHaveLength(1);

    await send(stripeEvent("invoice.payment_failed", invoiceObj("sub_bt_flow", end1), { account: ACCT(), created: now + 1 }));
    expect((await subRow("sub_bt_flow"))?.status).toBe("past_due");
    const [note] = await db().select().from(schema.notifications).where(and(eq(schema.notifications.orgId, t.agency.id), eq(schema.notifications.kind, "billing.payment_failed")));
    expect(note?.title).toContain(t.client.name);
    expect(note?.href).toBe(`/a/${t.agency.slug}/clients/${t.client.slug}`);

    await send(stripeEvent("invoice.paid", invoiceObj("sub_bt_flow", end2), { account: ACCT(), created: now + 2 }));
    let row = await subRow("sub_bt_flow");
    expect(row?.status).toBe("active");
    expect(row?.currentPeriodEnd?.getTime()).toBe(end2 * 1000);

    // An older, out-of-order delivery must not regress state.
    await send(stripeEvent("customer.subscription.updated", subscriptionObj("sub_bt_flow", "past_due", end1), { account: ACCT(), created: now + 1 }));
    expect((await subRow("sub_bt_flow"))?.status).toBe("active");

    await send(stripeEvent("customer.subscription.updated", subscriptionObj("sub_bt_flow", "active", end2, { cancel_at_period_end: true }), { account: ACCT(), created: now + 3 }));
    row = await subRow("sub_bt_flow");
    expect(row).toMatchObject({ status: "active", cancelAtPeriodEnd: true });

    await send(stripeEvent("customer.subscription.deleted", subscriptionObj("sub_bt_flow", "canceled", end2, { canceled_at: now + 4, ended_at: now + 4 }), { account: ACCT(), created: now + 4 }));
    row = await subRow("sub_bt_flow");
    expect(row).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
    expect(row?.canceledAt).not.toBeNull();

    // A late invoice.paid can't resurrect a canceled subscription.
    await send(stripeEvent("invoice.paid", invoiceObj("sub_bt_flow", end2), { account: ACCT(), created: now + 5 }));
    expect((await subRow("sub_bt_flow"))?.status).toBe("canceled");

    const actions = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.orgId, t.client.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["billing.checkout_completed", "billing.invoice_payment_failed", "billing.invoice_paid", "billing.subscription_status"]));
  });

  it("account.updated flips charges_enabled; deauthorization disconnects", async () => {
    await db().update(schema.billingAccounts).set({ chargesEnabled: false }).where(eq(schema.billingAccounts.orgId, t.agency.id));
    await send(stripeEvent("account.updated", { id: ACCT(), object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true, country: "US", default_currency: "usd" }, { account: ACCT() }));
    let [a] = await db().select().from(schema.billingAccounts).where(eq(schema.billingAccounts.orgId, t.agency.id));
    expect(a).toMatchObject({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    await send(stripeEvent("account.application.deauthorized", { id: "ca_x", object: "application" }, { account: ACCT() }));
    [a] = await db().select().from(schema.billingAccounts).where(eq(schema.billingAccounts.orgId, t.agency.id));
    expect(a?.chargesEnabled).toBe(false);
    expect(a?.deauthorizedAt).not.toBeNull();
  });
});

describe("Connect cross-checks", () => {
  it("ignores a checkout from another connected account carrying forged metadata", async () => {
    // The sibling client connects its own Stripe and creates a session claiming to be the agency's plan.
    await connectAccount(t.sibling.id, "acct_bt_attacker");
    const forged = checkoutCompleted("sub_bt_forged");
    const r = await send(stripeEvent("checkout.session.completed", forged, { account: "acct_bt_attacker" }));
    expect(r.body.handled).toBe(false);
    expect(await subRow("sub_bt_forged")).toBeUndefined();
    // …and can't touch a real subscription by id either.
    await send(stripeEvent("checkout.session.completed", checkoutCompleted("sub_bt_real"), { account: ACCT() }));
    await send(stripeEvent("customer.subscription.deleted", subscriptionObj("sub_bt_real", "canceled", 0), { account: "acct_bt_attacker" }));
    expect((await subRow("sub_bt_real"))?.status).toBe("active");
  });

  it("rejects a buyer that isn't a direct child of the plan's seller", async () => {
    const meta = { roster_buyer_org_id: t.customer.id, roster_plan_id: t.plan.id };
    const r = await send(stripeEvent("checkout.session.completed", checkoutCompleted("sub_bt_grandchild", { metadata: meta }), { account: ACCT() }));
    expect(r.body.handled).toBe(false);
  });
});
