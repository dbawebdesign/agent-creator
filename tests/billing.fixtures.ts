/** Shared helpers for billing tests (not a test file): orgs/users, a fake Stripe over a custom httpClient. */
import { inArray, like, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db, schema } from "@/server/db/client";

export const rid = (n = 10) => Math.random().toString(36).slice(2, 2 + n);

const created = { orgs: [] as string[], users: [] as string[] };

export async function makeTree() {
  const tag = rid(6);
  const [agency] = await db().insert(schema.organizations).values({ kind: "agency", name: `Northbeam ${tag}`, slug: `bt-agency-${tag}` }).returning();
  await db().update(schema.organizations).set({ agencyId: agency!.id }).where(sql`id = ${agency!.id}`);
  const mk = async (name: string, kind: "client" | "customer", parentId: string) =>
    (await db().insert(schema.organizations).values({ kind, name: `${name} ${tag}`, slug: `bt-${name.toLowerCase()}-${tag}`, parentId, agencyId: agency!.id }).returning())[0]!;
  const client = await mk("Brandlord", "client", agency!.id);
  const sibling = await mk("Otherco", "client", agency!.id);
  const customer = await mk("Shopper", "customer", client.id);
  created.orgs.push(agency!.id, client.id, sibling.id, customer.id);
  const [plan] = await db().insert(schema.plans).values({ orgId: agency!.id, name: "AI employee", priceCents: 500_000 }).returning();
  const [resalePlan] = await db().insert(schema.plans).values({ orgId: client.id, name: "Brandlord Concierge", priceCents: 120_000, setupFeeCents: 50_000 }).returning();
  return { agency: agency!, client, sibling, customer, plan: plan!, resalePlan: resalePlan! };
}

export async function makeUser(orgId: string, role: "owner" | "admin" | "member" | "viewer" = "admin") {
  const [u] = await db().insert(schema.users).values({ email: `bt-${rid()}@billing.test` }).returning();
  await db().insert(schema.memberships).values({ userId: u!.id, orgId, role });
  created.users.push(u!.id);
  return { id: u!.id, isPlatformAdmin: false };
}

export async function connectAccount(orgId: string, stripeAccountId: string, chargesEnabled = true) {
  await db().insert(schema.billingAccounts).values({ orgId, stripeAccountId, chargesEnabled, detailsSubmitted: chargesEnabled, payoutsEnabled: chargesEnabled });
}

export async function cleanup() {
  created.orgs.splice(0);
  // Every billing-test org has a "bt-" slug: sweep them all (also leftovers from an interrupted run).
  const orgs = (await db().select({ id: schema.organizations.id }).from(schema.organizations).where(like(schema.organizations.slug, "bt-%"))).map((o) => o.id);
  const users = created.users.splice(0);
  if (orgs.length) {
    const plans = db().select({ id: schema.plans.id }).from(schema.plans).where(inArray(schema.plans.orgId, orgs));
    await db().delete(schema.subscriptions).where(or(inArray(schema.subscriptions.orgId, orgs), inArray(schema.subscriptions.planId, plans)));
    await db().delete(schema.auditLogs).where(inArray(schema.auditLogs.orgId, orgs));
    await db().delete(schema.organizations).where(inArray(schema.organizations.id, orgs));
  }
  if (users.length) await db().delete(schema.users).where(inArray(schema.users.id, users));
  await db().delete(schema.webhookEvents).where(or(like(schema.webhookEvents.externalId, "evt_bt%")));
}

// ── fake Stripe API ─────────────────────────────────────────────────────────

export type StripeCall = { method: string; path: string; params: URLSearchParams; account: string | null; idempotencyKey: string | null };

export class FakeStripeApi {
  calls: StripeCall[] = [];
  n = 0;
  accountChargesEnabled = true;
  fail: null | { path: RegExp; status: number; body: object } = null;

  route(method: string, path: string, params: URLSearchParams): { status: number; body: object } {
    const id = (p: string) => `${p}_${++this.n}${rid(6)}`;
    if (this.fail && this.fail.path.test(path)) return { status: this.fail.status, body: this.fail.body };
    if (method === "POST" && path === "/v1/accounts") return ok({ id: id("acct"), object: "account", charges_enabled: false, details_submitted: false, payouts_enabled: false, country: "US", default_currency: "usd" });
    if (method === "GET" && /^\/v1\/accounts\/acct_/.test(path))
      return ok({ id: path.split("/").pop(), object: "account", charges_enabled: this.accountChargesEnabled, details_submitted: true, payouts_enabled: this.accountChargesEnabled, country: "US", default_currency: "usd" });
    if (method === "POST" && path === "/v1/account_links") return ok({ object: "account_link", url: `https://connect.stripe.com/setup/s/${rid()}`, expires_at: 0, created: 0 });
    if (method === "POST" && path === "/v1/products") return ok({ id: id("prod"), object: "product", name: params.get("name") });
    if (method === "POST" && /^\/v1\/products\//.test(path)) return ok({ id: path.split("/").pop(), object: "product" });
    if (method === "POST" && path === "/v1/prices") return ok({ id: id("price"), object: "price", unit_amount: Number(params.get("unit_amount")) });
    if (method === "POST" && /^\/v1\/prices\//.test(path)) return ok({ id: path.split("/").pop(), object: "price", active: false });
    if (method === "POST" && path === "/v1/customers") return ok({ id: id("cus"), object: "customer" });
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const s = id("cs_test");
      return ok({ id: s, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${s}`, mode: "subscription" });
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") return ok({ id: id("bps"), object: "billing_portal.session", url: `https://billing.stripe.com/p/session/${rid()}` });
    if (method === "POST" && /^\/v1\/subscriptions\//.test(path)) return ok({ id: path.split("/").pop(), object: "subscription", cancel_at_period_end: true });
    if (method === "DELETE" && /^\/v1\/subscriptions\//.test(path)) return ok({ id: path.split("/").pop(), object: "subscription", status: "canceled" });
    return { status: 404, body: { error: { type: "invalid_request_error", message: `fake: no route ${method} ${path}` } } };
  }

  client = (key: string) =>
    new Stripe(key, {
      maxNetworkRetries: 0,
      httpClient: {
        getClientName: () => "fake",
        makeRequest: async (_host, _port, path, method, headers, requestData) => {
          const [p, qs] = path.split("?");
          const params = new URLSearchParams(method === "GET" || method === "DELETE" ? (qs ?? "") : requestData);
          const h = headers as Record<string, string | undefined>;
          const call = { method, path: p!, params, account: h["Stripe-Account"] ?? null, idempotencyKey: h["Idempotency-Key"] ?? null };
          this.calls.push(call);
          const res = this.route(method, p!, params);
          const json = JSON.stringify(res.body);
          return {
            getStatusCode: () => res.status,
            getHeaders: () => ({ "request-id": `req_${rid()}` }),
            getRawResponse: () => ({}),
            toStream: () => null,
            toJSON: async () => JSON.parse(json),
          };
        },
      },
    });

  find(method: string, path: string | RegExp) {
    return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)));
  }
}

function ok(body: object) {
  return { status: 200, body };
}

/** A signed Stripe webhook Request (Stripe.webhooks.generateTestHeaderString). */
export function stripeRequest(event: object, secret: string, opts: { timestamp?: number; signature?: string; body?: string } = {}) {
  const payload = opts.body ?? JSON.stringify(event);
  const signature = opts.signature ?? Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000) });
  return new Request("https://app.roster.test/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload });
}

let evtN = 0;
export function stripeEvent(type: string, object: object, opts: { account?: string; created?: number; id?: string } = {}) {
  return {
    id: opts.id ?? `evt_bt${Date.now()}${++evtN}${rid(4)}`,
    object: "event",
    api_version: "2026-10-28.endive",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    account: opts.account,
    data: { object },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  };
}
