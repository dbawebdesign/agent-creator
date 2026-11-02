/**
 * POST /api/webhooks/stripe — platform + Connect events.
 *
 * raw body → stripe.webhooks.constructEvent (each configured secret; 5-minute tolerance) → one transaction:
 * insert webhook_events(provider "stripe", event.id) on conflict do nothing, lock it, skip if processed,
 * apply, mark processed. A failure rolls back and returns 500 so Stripe retries; a replay is a no-op.
 *
 * Connect events carry `event.account`. Every state change is cross-checked against the seller account we
 * have on file for the subscription/plan, so a connected account can't create sessions with forged metadata
 * and flip another org's subscription.
 */
import "server-only";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { readTextCapped } from "@/server/api/body";
import type { DB } from "@/server/db/client";
import { db, schema } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";
import { errInfo } from "./service";
import { webhookSecrets } from "./stripe";

const MAX_BODY = 512 * 1024;
const TOLERANCE_SEC = 300;
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type SubStatus = "trialing" | "active" | "past_due" | "canceled";

function reject(status: number, message: string) {
  return Response.json({ error: { code: status === 413 ? "invalid_request" : status === 400 ? "invalid_request" : "unauthorized", message } }, { status });
}

/** Verify a Stripe signature against every configured secret (endpoint + Connect endpoint). */
export function verifyStripeEvent(body: string, signature: string | null, secrets = webhookSecrets(), nowSec?: number): Stripe.Event | null {
  if (!signature || signature.length > 4096 || !secrets.length) return null;
  for (const secret of secrets) {
    try {
      // Stripe.webhooks is the static (keyless) helper; constructEvent checks HMAC + timestamp tolerance.
      return Stripe.webhooks.constructEvent(body, signature, secret, TOLERANCE_SEC, undefined, nowSec);
    } catch {
      // try the next secret
    }
  }
  return null;
}

export async function handleStripeWebhook(req: Request): Promise<Response> {
  const body = await readTextCapped(req, MAX_BODY);
  if (body === null) return reject(413, "Payload too large");
  const secrets = webhookSecrets();
  if (!secrets.length) {
    logger.warn("stripe webhook rejected: STRIPE_WEBHOOK_SECRET not set");
    return reject(401, "Invalid signature");
  }
  const event = verifyStripeEvent(body, req.headers.get("stripe-signature"), secrets);
  if (!event) return reject(401, "Invalid signature");
  if (typeof event.id !== "string" || !/^evt_[A-Za-z0-9_]{6,120}$/.test(event.id)) return reject(400, "Invalid event");
  try {
    const res = await processStripeEvent(event);
    return Response.json({ ok: true, duplicate: res.duplicate, handled: res.handled });
  } catch (err) {
    logger.error({ err: errInfo(err), eventId: event.id, type: event.type }, "stripe webhook processing failed");
    return Response.json({ error: { code: "internal", message: "Processing failed" } }, { status: 500 });
  }
}

/** Idempotent: one webhook_events row per event id; processed exactly once (row lock serializes retries). */
export async function processStripeEvent(event: Stripe.Event): Promise<{ duplicate: boolean; handled: boolean }> {
  const after: Array<() => Promise<void>> = [];
  const result = await db().transaction(async (tx) => {
    await tx
      .insert(schema.webhookEvents)
      .values({ provider: "stripe", externalId: event.id, payload: { id: event.id, type: event.type, account: event.account ?? null, created: event.created, livemode: event.livemode } })
      .onConflictDoNothing();
    const locked = await tx.execute<{ id: string; processed_at: Date | null }>(
      sql`select id, processed_at from webhook_events where provider = 'stripe' and external_id = ${event.id} for update`,
    );
    const row = locked.rows[0];
    if (!row) throw new Error("webhook event row missing");
    if (row.processed_at) return { duplicate: true, handled: false };
    const handled = await applyEvent(tx, event, after);
    await tx.update(schema.webhookEvents).set({ processedAt: new Date() }).where(eq(schema.webhookEvents.id, row.id));
    return { duplicate: false, handled };
  });
  // Audit writes are best-effort and outside the transaction (audit() never throws).
  for (const fn of after) await fn();
  return result;
}

// ── event handlers ─────────────────────────────────────────────────────────

async function applyEvent(tx: Tx, event: Stripe.Event, after: Array<() => Promise<void>>): Promise<boolean> {
  const at = new Date(event.created * 1000);
  const account = event.account ?? null;
  switch (event.type) {
    case "account.updated":
      return onAccountUpdated(tx, event.data.object, after);
    case "account.application.deauthorized":
      return onDeauthorized(tx, account, after);
    case "checkout.session.completed":
      return onCheckoutCompleted(tx, event.data.object, account, at, after);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return onSubscription(tx, event.data.object, account, at, event.type === "customer.subscription.deleted", after);
    case "invoice.paid":
      return onInvoice(tx, event.data.object, account, at, "paid", after);
    case "invoice.payment_failed":
      return onInvoice(tx, event.data.object, account, at, "failed", after);
    default:
      return false;
  }
}

async function onAccountUpdated(tx: Tx, a: Stripe.Account, after: Array<() => Promise<void>>) {
  const rows = await tx
    .update(schema.billingAccounts)
    .set({
      chargesEnabled: !!a.charges_enabled,
      payoutsEnabled: !!a.payouts_enabled,
      detailsSubmitted: !!a.details_submitted,
      country: a.country ?? null,
      defaultCurrency: a.default_currency ?? null,
    })
    .where(eq(schema.billingAccounts.stripeAccountId, a.id))
    .returning({ orgId: schema.billingAccounts.orgId });
  const orgId = rows[0]?.orgId;
  if (!orgId) return false;
  after.push(() => audit({ orgId, actorType: "system", action: "billing.account_updated", targetType: "stripe_account", targetId: a.id, metadata: { chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted } }));
  return true;
}

async function onDeauthorized(tx: Tx, account: string | null, after: Array<() => Promise<void>>) {
  if (!account) return false;
  const rows = await tx
    .update(schema.billingAccounts)
    .set({ deauthorizedAt: new Date(), chargesEnabled: false, payoutsEnabled: false })
    .where(eq(schema.billingAccounts.stripeAccountId, account))
    .returning({ orgId: schema.billingAccounts.orgId });
  const orgId = rows[0]?.orgId;
  if (!orgId) return false;
  after.push(() => audit({ orgId, actorType: "system", action: "billing.account_disconnected", targetType: "stripe_account", targetId: account }));
  return true;
}

export function mapStatus(s: Stripe.Subscription.Status): SubStatus {
  switch (s) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      // past_due, unpaid, incomplete, paused: not in good standing.
      return "past_due";
  }
}

function periodEnd(sub: Stripe.Subscription): Date | null {
  // Since API 2025-03-31 the billing period lives on subscription items.
  const ends = (sub.items?.data ?? []).map((i) => i.current_period_end).filter((n): n is number => typeof n === "number");
  const legacy = (sub as unknown as { current_period_end?: unknown }).current_period_end;
  if (typeof legacy === "number") ends.push(legacy);
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

type Target = { buyerOrgId: string; planId: string; sellerOrgId: string; stripeAccountId: string };

/**
 * Resolve metadata (buyer, plan) set by createCheckout and prove it's consistent: the plan's seller owns the
 * account the event came from, and the buyer is that seller's direct child.
 */
async function trustedTarget(tx: Tx, meta: Stripe.Metadata | null | undefined, account: string | null): Promise<Target | null> {
  const buyerOrgId = meta?.roster_buyer_org_id;
  const planId = meta?.roster_plan_id;
  if (!account || !buyerOrgId || !planId || !isUuid(buyerOrgId) || !isUuid(planId)) return null;
  const rows = await tx
    .select({ plan: schema.plans, buyer: schema.organizations, acct: schema.billingAccounts })
    .from(schema.plans)
    .innerJoin(schema.billingAccounts, eq(schema.billingAccounts.orgId, schema.plans.orgId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, buyerOrgId))
    .where(and(eq(schema.plans.id, planId), eq(schema.billingAccounts.stripeAccountId, account)))
    .limit(1);
  const r = rows[0];
  if (!r || r.buyer.parentId !== r.plan.orgId || r.buyer.deletedAt) return null;
  return { buyerOrgId, planId, sellerOrgId: r.plan.orgId, stripeAccountId: account };
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Find-or-create the local subscription row for a Stripe subscription. A buyer's manual (non-Stripe) row for the
 * same plan is adopted rather than duplicated.
 */
async function upsertSubscription(tx: Tx, target: Target, stripeSubId: string): Promise<typeof schema.subscriptions.$inferSelect> {
  const existing = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, stripeSubId)).limit(1);
  if (existing[0]) return existing[0];
  const manual = await tx
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.orgId, target.buyerOrgId), eq(schema.subscriptions.planId, target.planId), isNull(schema.subscriptions.stripeSubscriptionId), ne(schema.subscriptions.status, "canceled")))
    .limit(1);
  if (manual[0]) {
    const [row] = await tx
      .update(schema.subscriptions)
      .set({ stripeSubscriptionId: stripeSubId, stripeAccountId: target.stripeAccountId })
      .where(eq(schema.subscriptions.id, manual[0].id))
      .returning();
    return row!;
  }
  const inserted = await tx
    .insert(schema.subscriptions)
    .values({ orgId: target.buyerOrgId, planId: target.planId, status: "past_due", stripeSubscriptionId: stripeSubId, stripeAccountId: target.stripeAccountId })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const again = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, stripeSubId)).limit(1);
  return again[0]!;
}

/** Retire the buyer's other manual (pre-Stripe) rows from the same seller once a Stripe subscription is live. */
async function retireManualRows(tx: Tx, target: Target, keepId: string) {
  const sellerPlans = tx.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.orgId, target.sellerOrgId));
  await tx
    .update(schema.subscriptions)
    .set({ status: "canceled", canceledAt: new Date() })
    .where(
      and(
        eq(schema.subscriptions.orgId, target.buyerOrgId),
        isNull(schema.subscriptions.stripeSubscriptionId),
        ne(schema.subscriptions.status, "canceled"),
        ne(schema.subscriptions.id, keepId),
        inArray(schema.subscriptions.planId, sellerPlans),
      ),
    );
}

/** Ordering guard: apply only events at or after the last applied one (Stripe doesn't guarantee order). */
function isStale(sub: typeof schema.subscriptions.$inferSelect, at: Date) {
  return !!sub.stripeEventAt && at.getTime() < sub.stripeEventAt.getTime();
}

async function onCheckoutCompleted(tx: Tx, s: Stripe.Checkout.Session, account: string | null, at: Date, after: Array<() => Promise<void>>) {
  if (s.mode !== "subscription") return false;
  const target = await trustedTarget(tx, s.metadata, account);
  const stripeSubId = idOf(s.subscription);
  if (!target || !stripeSubId) {
    logger.warn({ session: s.id, account }, "stripe checkout.session.completed ignored: unknown or mismatched target");
    return false;
  }
  const customerId = idOf(s.customer);
  if (customerId) {
    await tx.insert(schema.billingCustomers).values({ orgId: target.buyerOrgId, stripeAccountId: target.stripeAccountId, stripeCustomerId: customerId }).onConflictDoNothing();
  }
  const sub = await upsertSubscription(tx, target, stripeSubId);
  const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  if (paid && !isStale(sub, at) && sub.status !== "canceled") {
    await tx.update(schema.subscriptions).set({ status: "active", stripeEventAt: at }).where(eq(schema.subscriptions.id, sub.id));
    await retireManualRows(tx, target, sub.id);
  }
  after.push(() =>
    audit({ orgId: target.buyerOrgId, actorType: "system", action: "billing.checkout_completed", targetType: "subscription", targetId: sub.id, metadata: { planId: target.planId, sellerOrgId: target.sellerOrgId, paymentStatus: s.payment_status } }),
  );
  return true;
}

async function onSubscription(tx: Tx, s: Stripe.Subscription, account: string | null, at: Date, deleted: boolean, after: Array<() => Promise<void>>) {
  if (!account) return false;
  const found = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, s.id)).limit(1);
  let sub = found[0];
  let target: Target | null = null;
  if (sub) {
    if (sub.stripeAccountId !== account) {
      logger.warn({ sub: s.id, account }, "stripe subscription event from a different account ignored");
      return false;
    }
  } else {
    target = await trustedTarget(tx, s.metadata, account);
    if (!target) return false;
    sub = await upsertSubscription(tx, target, s.id);
  }
  if (isStale(sub, at)) return true;
  const status: SubStatus = deleted ? "canceled" : mapStatus(s.status);
  const canceledAt = status === "canceled" ? (s.canceled_at ? new Date(s.canceled_at * 1000) : (s.ended_at ? new Date(s.ended_at * 1000) : at)) : null;
  const [updated] = await tx
    .update(schema.subscriptions)
    .set({ status, currentPeriodEnd: periodEnd(s) ?? sub.currentPeriodEnd, cancelAtPeriodEnd: !deleted && (!!s.cancel_at_period_end || !!s.cancel_at), canceledAt, stripeEventAt: at })
    .where(eq(schema.subscriptions.id, sub.id))
    .returning();
  if (status === "active" || status === "trialing") {
    const sellerOrgId = target?.sellerOrgId ?? (await sellerOf(tx, sub.planId));
    if (sellerOrgId) await retireManualRows(tx, { buyerOrgId: sub.orgId, planId: sub.planId, sellerOrgId, stripeAccountId: account }, sub.id);
  }
  if (sub.status !== status) {
    after.push(() => audit({ orgId: sub!.orgId, actorType: "system", action: "billing.subscription_status", targetType: "subscription", targetId: sub!.id, metadata: { from: sub!.status, to: status, stripeStatus: s.status } }));
  }
  return !!updated;
}

async function sellerOf(tx: Tx, planId: string): Promise<string | null> {
  const r = await tx.select({ orgId: schema.plans.orgId }).from(schema.plans).where(eq(schema.plans.id, planId)).limit(1);
  return r[0]?.orgId ?? null;
}

function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const fromParent = inv.parent?.subscription_details?.subscription;
  if (fromParent) return idOf(fromParent);
  // Older API versions put it at the top level.
  const legacy = (inv as unknown as { subscription?: string | { id: string } | null }).subscription;
  return idOf(legacy ?? null);
}

function invoicePeriodEnd(inv: Stripe.Invoice): Date | null {
  const ends = (inv.lines?.data ?? []).map((l) => l.period?.end).filter((n): n is number => typeof n === "number");
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
}

async function onInvoice(tx: Tx, inv: Stripe.Invoice, account: string | null, at: Date, kind: "paid" | "failed", after: Array<() => Promise<void>>) {
  const stripeSubId = invoiceSubscriptionId(inv);
  if (!account || !stripeSubId) return false;
  const found = await tx.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.stripeSubscriptionId, stripeSubId), eq(schema.subscriptions.stripeAccountId, account))).limit(1);
  const sub = found[0];
  if (!sub) return false;
  if (sub.status !== "canceled" && !isStale(sub, at)) {
    const patch: Partial<typeof schema.subscriptions.$inferInsert> =
      kind === "paid" ? { status: "active", stripeEventAt: at, currentPeriodEnd: invoicePeriodEnd(inv) ?? sub.currentPeriodEnd } : { status: "past_due", stripeEventAt: at };
    await tx.update(schema.subscriptions).set(patch).where(eq(schema.subscriptions.id, sub.id));
  }
  if (kind === "failed") await notifyPaymentFailed(tx, sub, inv);
  after.push(() =>
    audit({ orgId: sub.orgId, actorType: "system", action: kind === "paid" ? "billing.invoice_paid" : "billing.invoice_payment_failed", targetType: "subscription", targetId: sub.id, metadata: { invoice: inv.id, amountDue: inv.amount_due, attempt: inv.attempt_count } }),
  );
  return true;
}

/** "Brandlord's payment failed" → the seller org (and its agency, when the seller is a reselling client). */
async function notifyPaymentFailed(tx: Tx, sub: typeof schema.subscriptions.$inferSelect, inv: Stripe.Invoice) {
  const rows = await tx
    .select({ buyer: schema.organizations, plan: schema.plans })
    .from(schema.subscriptions)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.subscriptions.orgId))
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(eq(schema.subscriptions.id, sub.id))
    .limit(1);
  const r = rows[0];
  if (!r) return;
  const sellers = await tx
    .select()
    .from(schema.organizations)
    .where(or(eq(schema.organizations.id, r.plan.orgId), r.buyer.agencyId ? eq(schema.organizations.id, r.buyer.agencyId) : sql`false`));
  const amount = typeof inv.amount_due === "number" ? ` (${(inv.amount_due / 100).toLocaleString("en-US", { style: "currency", currency: (inv.currency || "usd").toUpperCase() })})` : "";
  const values = sellers.map((seller) => {
    const agencySlug = seller.kind === "agency" ? seller.slug : null;
    const href = agencySlug ? (r.buyer.parentId === seller.id ? `/a/${agencySlug}/clients/${r.buyer.slug}` : `/a/${agencySlug}/billing`) : `/p/${seller.slug}/resell`;
    return {
      orgId: seller.id,
      kind: "billing.payment_failed",
      title: `${r.buyer.name}'s payment failed`,
      body: `The ${r.plan.name} invoice${amount} couldn't be charged. Stripe will retry; the subscription is past due until it's paid.`,
      href,
    };
  });
  if (values.length) await tx.insert(schema.notifications).values(values);
}
