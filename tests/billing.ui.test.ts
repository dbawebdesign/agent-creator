/** Billing UI components render every state (server components awaited directly, no JSX needed). */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test" });
  delete process.env.STRIPE_SECRET_KEY;
});
const session = vi.hoisted(() => ({ current: null as null | { id: string; isPlatformAdmin: boolean } }));
vi.mock("@/server/auth/session", () => ({ getCurrentUser: async () => session.current, requireUser: async () => session.current, clientIp: () => null }));

import { db, schema } from "@/server/db/client";
import { BillingStatusBadge } from "@/components/billing/billing-status-badge";
import { ConnectStripeCard } from "@/components/billing/connect-stripe-card";
import { SubscriptionCard } from "@/components/billing/subscription-card";
import { CheckoutLinksCard } from "@/components/billing/checkout-links-card";
import { CheckoutLinkButton, ManageBillingButton, SubscribeButton } from "@/components/billing";
import { cleanup, connectAccount, makeTree, makeUser } from "./billing.fixtures";

let t: Awaited<ReturnType<typeof makeTree>>;
const html = async (node: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await node);

beforeEach(async () => {
  await cleanup();
  t = await makeTree();
  delete process.env.STRIPE_SECRET_KEY;
});
afterAll(cleanup);

describe("billing components", () => {
  it("ConnectStripeCard: not configured → connect → ready; inherited staff can't connect", async () => {
    session.current = await makeUser(t.agency.id, "owner");
    let out = await html(ConnectStripeCard({ sellerOrgId: t.agency.id, returnPath: "/a/x/billing" }));
    expect(out).toContain("Test mode");
    expect(out).toContain("isn&#x27;t connected");
    expect(out).not.toContain("/api/billing/connect?");

    process.env.STRIPE_SECRET_KEY = "sk_test_ui";
    out = await html(ConnectStripeCard({ sellerOrgId: t.agency.id, returnPath: "/a/x/billing" }));
    expect(out).toContain("Connect Stripe");
    expect(out).toContain("Stripe test mode");

    await connectAccount(t.agency.id, `acct_bt_ui${t.agency.id.slice(0, 4)}`);
    out = await html(ConnectStripeCard({ sellerOrgId: t.agency.id, returnPath: "/a/x/billing" }));
    expect(out).toContain("Payments go straight to your Stripe account");
    expect(out).toContain("Update details");

    // Agency owner looking at the client's resale payouts: status only, no connect button.
    out = await html(ConnectStripeCard({ sellerOrgId: t.client.id, returnPath: "/p/x/resell" }));
    expect(out).toContain("can connect Stripe");
    expect(out).not.toContain("Connect Stripe<");
  });

  it("SubscriptionCard shows plan, flat price and status; no cost or usage", async () => {
    session.current = await makeUser(t.client.id, "admin");
    let out = await html(SubscriptionCard({ buyerOrgId: t.client.id, returnPath: "/p/x/settings" }));
    expect(out).toContain("No plan");
    await db().insert(schema.subscriptions).values({ orgId: t.client.id, planId: t.plan.id, status: "past_due", currentPeriodEnd: new Date("2026-12-02T00:00:00Z") });
    out = await html(SubscriptionCard({ buyerOrgId: t.client.id, returnPath: "/p/x/settings" }));
    expect(out).toContain("AI employee");
    expect(out).toContain("$5,000");
    expect(out).toContain("Past due");
    expect(out).not.toMatch(/token|cost/i);
  });

  it("CheckoutLinksCard is seller-side only and offers a link per plan once Stripe is ready", async () => {
    session.current = await makeUser(t.client.id, "owner");
    expect(await CheckoutLinksCard({ buyerOrgId: t.client.id, returnPath: "/p/x" })).toBeNull();
    session.current = await makeUser(t.agency.id, "admin");
    let out = await html((await CheckoutLinksCard({ buyerOrgId: t.client.id, returnPath: "/a/x/clients/y" }))!);
    expect(out).toContain("connected to Roster yet");
    expect(out).not.toContain("Copy checkout link");
    process.env.STRIPE_SECRET_KEY = "sk_test_ui";
    await connectAccount(t.agency.id, `acct_bt_ul${t.agency.id.slice(0, 4)}`);
    out = await html((await CheckoutLinksCard({ buyerOrgId: t.client.id, returnPath: "/a/x/clients/y" }))!);
    expect(out).toContain("AI employee");
    expect(out).toContain("Copy checkout link");
  });

  it("badges and buttons render", () => {
    expect(renderToStaticMarkup(createElement(BillingStatusBadge, { status: "active" }))).toContain("Active");
    expect(renderToStaticMarkup(createElement(BillingStatusBadge, { status: "active", cancelAtPeriodEnd: true }))).toContain("Cancels at period end");
    expect(renderToStaticMarkup(createElement(BillingStatusBadge, { status: null }))).toContain("No plan");
    expect(renderToStaticMarkup(createElement(SubscribeButton, { buyerOrgId: t.client.id, planId: t.plan.id }))).toContain("Subscribe");
    expect(renderToStaticMarkup(createElement(CheckoutLinkButton, { buyerOrgId: t.client.id, planId: t.plan.id }))).toContain("Copy checkout link");
    expect(renderToStaticMarkup(createElement(ManageBillingButton, { buyerOrgId: t.client.id }))).toContain("Manage billing");
  });
});
