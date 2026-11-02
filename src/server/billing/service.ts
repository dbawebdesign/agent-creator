/**
 * Billing service (Stripe Connect, Standard accounts).
 *
 * SELLER = plan.orgId (agency, or client reselling). BUYER = subscription.orgId. Everything Stripe-side lives
 * on the seller's connected account (`stripeAccount` request option): products/prices, customers, checkout
 * sessions, subscriptions, the customer portal. The platform takes an optional application fee
 * (PLATFORM_FEE_BPS). Authorization is the caller's job (see ./actions.ts); these functions trust their ids
 * but always re-derive seller/buyer relationships from the DB.
 */
import "server-only";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type Stripe from "stripe";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";
import { sha256 } from "@/server/security/crypto";
import { BillingError, billingMode, platformFeeBps, requireStripe, stripeOrNull, toBillingError, type BillingMode } from "./stripe";

type Org = typeof schema.organizations.$inferSelect;
type Plan = typeof schema.plans.$inferSelect;
type BillingAccount = typeof schema.billingAccounts.$inferSelect;
type Actor = { userId?: string | null };

// ── helpers ─────────────────────────────────────────────────────────────────

/** Deterministic idempotency key: same logical request + same params → same key (Stripe dedupes 24h). */
export function idemKey(purpose: string, id: string, params: unknown): string {
  return `roster:${purpose}:${id}:${sha256(JSON.stringify(params)).slice(0, 24)}`;
}

/**
 * Only allow redirects back into this app: a same-origin absolute URL or an absolute path ("/a/x/billing").
 * Prevents Stripe-hosted pages from becoming an open redirect.
 */
export function appUrl(input: string): string {
  const base = new URL(env().APP_URL);
  const raw = input.trim();
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return new URL(raw, base).toString();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BillingError("invalid", "Return URL must be a page in this app.");
  }
  if (u.origin !== base.origin) throw new BillingError("invalid", "Return URL must be a page in this app.");
  return u.toString();
}

async function orgById(orgId: string): Promise<Org> {
  const rows = await db()
    .select()
    .from(schema.organizations)
    .where(and(eq(schema.organizations.id, orgId), isNull(schema.organizations.deletedAt)))
    .limit(1);
  if (!rows[0]) throw new BillingError("not_found", "Organization not found.");
  return rows[0];
}

async function planById(planId: string): Promise<Plan> {
  const rows = await db().select().from(schema.plans).where(eq(schema.plans.id, planId)).limit(1);
  if (!rows[0]) throw new BillingError("not_found", "Plan not found.");
  return rows[0];
}

export async function billingAccountFor(orgId: string): Promise<BillingAccount | null> {
  const rows = await db().select().from(schema.billingAccounts).where(eq(schema.billingAccounts.orgId, orgId)).limit(1);
  return rows[0] ?? null;
}

async function readySellerAccount(sellerOrgId: string): Promise<BillingAccount> {
  const acct = await billingAccountFor(sellerOrgId);
  if (!acct || acct.deauthorizedAt) throw new BillingError("not_connected", "The seller hasn't connected Stripe yet.");
  if (!acct.chargesEnabled) throw new BillingError("charges_disabled", "The seller's Stripe account can't accept payments yet. Finish Stripe onboarding first.");
  return acct;
}

function accountFields(a: Stripe.Account) {
  return {
    chargesEnabled: !!a.charges_enabled,
    payoutsEnabled: !!a.payouts_enabled,
    detailsSubmitted: !!a.details_submitted,
    country: a.country ?? null,
    defaultCurrency: a.default_currency ?? null,
  };
}

/** Upsert local Connect state from a Stripe Account object (webhook account.updated, onboarding return). */
export async function applyAccountUpdate(a: Stripe.Account): Promise<BillingAccount | null> {
  const rows = await db()
    .update(schema.billingAccounts)
    .set({ ...accountFields(a), deauthorizedAt: null })
    .where(eq(schema.billingAccounts.stripeAccountId, a.id))
    .returning();
  return rows[0] ?? null;
}

// ── Seller: Connect onboarding ──────────────────────────────────────────────

/**
 * Hosted Stripe onboarding link for a seller org. Creates the connected account (Standard) on first use.
 * `returnUrl` is where the seller lands afterwards (must be inside the app).
 */
export async function connectOnboardingLink(
  sellerOrgId: string,
  returnUrl: string,
  actor: Actor & { createIfMissing?: boolean } = {},
): Promise<{ url: string; accountId: string }> {
  const stripe = requireStripe();
  const org = await orgById(sellerOrgId);
  const back = appUrl(returnUrl);
  let acct = await billingAccountFor(org.id);
  try {
    if (!acct || acct.deauthorizedAt) {
      // GET entry points (Stripe's refresh_url) only resume onboarding; creating an account takes a POST action.
      if (actor.createIfMissing === false) throw new BillingError("not_connected", "Start Stripe onboarding from the billing page.");
      const params: Stripe.AccountCreateParams = {
        type: "standard",
        business_profile: { name: org.branding.displayName ?? org.name, url: safeWebsite(org.website) },
        metadata: { roster_org_id: org.id, roster_org_kind: org.kind },
      };
      const created = await stripe.accounts.create(params, { idempotencyKey: idemKey("account", org.id, { ...params, n: acct?.stripeAccountId ?? 0 }) });
      if (acct) {
        const updated = await db()
          .update(schema.billingAccounts)
          .set({ stripeAccountId: created.id, livemode: billingMode() === "live", deauthorizedAt: null, ...accountFields(created) })
          .where(eq(schema.billingAccounts.id, acct.id))
          .returning();
        acct = updated[0] ?? null;
      } else {
        await db()
          .insert(schema.billingAccounts)
          .values({ orgId: org.id, stripeAccountId: created.id, livemode: billingMode() === "live", ...accountFields(created) })
          .onConflictDoNothing();
        acct = await billingAccountFor(org.id);
      }
      await audit({ orgId: org.id, actorType: actor.userId ? "user" : "system", actorId: actor.userId, action: "billing.account_created", targetType: "stripe_account", targetId: created.id });
    }
    if (!acct) throw new BillingError("conflict", "Couldn't save the Stripe account. Try again.");
    // Re-entry point when the link expires: our own route regenerates a fresh link and redirects.
    const refresh = appUrl(`/api/billing/connect?org=${encodeURIComponent(org.id)}&return=${encodeURIComponent(new URL(back).pathname + new URL(back).search)}`);
    const ret = appUrl(`/api/billing/connect/return?org=${encodeURIComponent(org.id)}&next=${encodeURIComponent(new URL(back).pathname + new URL(back).search)}`);
    const link = await stripe.accountLinks.create({ account: acct.stripeAccountId, type: "account_onboarding", refresh_url: refresh, return_url: ret });
    return { url: link.url, accountId: acct.stripeAccountId };
  } catch (err) {
    if (!(err instanceof BillingError)) logger.error({ err: errInfo(err), orgId: org.id }, "stripe connect onboarding failed");
    throw toBillingError(err);
  }
}

/** Pull the connected account's current state from Stripe (after onboarding return, or a manual refresh). */
export async function refreshAccount(sellerOrgId: string): Promise<BillingAccount | null> {
  const stripe = stripeOrNull();
  const acct = await billingAccountFor(sellerOrgId);
  if (!stripe || !acct) return acct;
  try {
    const a = await stripe.accounts.retrieve(acct.stripeAccountId);
    return (await applyAccountUpdate(a)) ?? acct;
  } catch (err) {
    logger.warn({ err: errInfo(err), orgId: sellerOrgId }, "stripe account refresh failed");
    return acct;
  }
}

function safeWebsite(w: string | null): string | undefined {
  if (!w) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// ── Seller: plans → Products/Prices ─────────────────────────────────────────

export type SyncedPlan = typeof schema.billingPrices.$inferSelect;

/**
 * Mirror a plan onto its seller's connected account: one Product, one monthly recurring Price (flat rate),
 * and an optional one-time setup-fee Price. Prices are immutable in Stripe, so an amount change creates a
 * new Price and archives the old one. Safe to call repeatedly.
 */
export async function syncPlanToStripe(planId: string, actor: Actor = {}): Promise<SyncedPlan> {
  const stripe = requireStripe();
  const plan = await planById(planId);
  const acct = await billingAccountFor(plan.orgId);
  if (!acct || acct.deauthorizedAt) throw new BillingError("not_connected", "Connect Stripe before syncing plans.");
  if (plan.priceCents <= 0) throw new BillingError("invalid", "Set a monthly price above $0 before selling this plan.");
  const opts = (purpose: string, params: unknown): Stripe.RequestOptions => ({
    stripeAccount: acct.stripeAccountId,
    idempotencyKey: idemKey(purpose, plan.id, { account: acct.stripeAccountId, params }),
  });
  const existingRows = await db().select().from(schema.billingPrices).where(eq(schema.billingPrices.planId, plan.id)).limit(1);
  // A row synced to a different (old) account is useless on the new one: start over.
  const existing = existingRows[0]?.stripeAccountId === acct.stripeAccountId ? existingRows[0] : undefined;
  const currency = plan.currency.toLowerCase();
  const meta = { roster_plan_id: plan.id, roster_seller_org_id: plan.orgId };

  try {
    let productId = existing?.stripeProductId;
    const productParams = { name: plan.name.slice(0, 250), description: plan.description?.slice(0, 1000) || undefined, active: plan.active, metadata: meta };
    if (productId) {
      await stripe.products.update(productId, { name: productParams.name, description: productParams.description ?? "", active: plan.active }, { stripeAccount: acct.stripeAccountId });
    } else {
      const p = await stripe.products.create(productParams, opts("product", productParams));
      productId = p.id;
    }

    let priceId = existing?.stripePriceId;
    if (!existing || existing.unitAmount !== plan.priceCents || existing.currency !== currency) {
      const priceParams: Stripe.PriceCreateParams = {
        product: productId,
        currency,
        unit_amount: plan.priceCents,
        recurring: { interval: "month" },
        nickname: `${plan.name} (monthly)`.slice(0, 250),
        metadata: meta,
      };
      const price = await stripe.prices.create(priceParams, opts("price", priceParams));
      if (existing?.stripePriceId && existing.stripePriceId !== price.id) {
        await stripe.prices.update(existing.stripePriceId, { active: false }, { stripeAccount: acct.stripeAccountId }).catch((err: unknown) => logger.warn({ err: errInfo(err) }, "archive old price failed"));
      }
      priceId = price.id;
    }

    let setupPriceId = existing?.setupPriceId ?? null;
    if (!existing || existing.setupAmount !== plan.setupFeeCents || existing.currency !== currency) {
      if (setupPriceId) {
        await stripe.prices.update(setupPriceId, { active: false }, { stripeAccount: acct.stripeAccountId }).catch((err: unknown) => logger.warn({ err: errInfo(err) }, "archive old setup price failed"));
        setupPriceId = null;
      }
      if (plan.setupFeeCents > 0) {
        const setupParams: Stripe.PriceCreateParams = { product: productId, currency, unit_amount: plan.setupFeeCents, nickname: `${plan.name} (setup fee)`.slice(0, 250), metadata: { ...meta, roster_kind: "setup_fee" } };
        setupPriceId = (await stripe.prices.create(setupParams, opts("setup_price", setupParams))).id;
      }
    }

    const values = {
      planId: plan.id,
      orgId: plan.orgId,
      stripeAccountId: acct.stripeAccountId,
      stripeProductId: productId,
      stripePriceId: priceId!,
      unitAmount: plan.priceCents,
      currency,
      setupPriceId,
      setupAmount: plan.setupFeeCents,
      syncedAt: new Date(),
    };
    const [row] = await db()
      .insert(schema.billingPrices)
      .values(values)
      .onConflictDoUpdate({ target: schema.billingPrices.planId, set: values })
      .returning();
    await db().update(schema.plans).set({ stripePriceId: priceId! }).where(eq(schema.plans.id, plan.id));
    if (!existing || existing.stripePriceId !== priceId) {
      await audit({ orgId: plan.orgId, actorType: actor.userId ? "user" : "system", actorId: actor.userId, action: "billing.plan_synced", targetType: "plan", targetId: plan.id, metadata: { price: priceId, amount: plan.priceCents, setupFee: plan.setupFeeCents } });
    }
    return row!;
  } catch (err) {
    if (!(err instanceof BillingError)) logger.error({ err: errInfo(err), planId }, "stripe plan sync failed");
    throw toBillingError(err);
  }
}

/** Synced row for the plan if it matches the plan's current price on the seller's current account. */
async function freshSyncedPlan(plan: Plan, acct: BillingAccount): Promise<SyncedPlan | null> {
  const rows = await db().select().from(schema.billingPrices).where(eq(schema.billingPrices.planId, plan.id)).limit(1);
  const r = rows[0];
  if (!r || r.stripeAccountId !== acct.stripeAccountId) return null;
  if (r.unitAmount !== plan.priceCents || r.setupAmount !== plan.setupFeeCents || r.currency !== plan.currency.toLowerCase()) return null;
  return r;
}

// ── Buyer: customers, checkout, portal, cancel ─────────────────────────────

async function ensureCustomer(stripe: Stripe, buyer: Org, acct: BillingAccount): Promise<string> {
  const found = await db()
    .select()
    .from(schema.billingCustomers)
    .where(and(eq(schema.billingCustomers.orgId, buyer.id), eq(schema.billingCustomers.stripeAccountId, acct.stripeAccountId)))
    .limit(1);
  if (found[0]) return found[0].stripeCustomerId;
  const params: Stripe.CustomerCreateParams = { name: (buyer.branding.displayName ?? buyer.name).slice(0, 250), metadata: { roster_org_id: buyer.id } };
  const c = await stripe.customers.create(params, { stripeAccount: acct.stripeAccountId, idempotencyKey: idemKey("customer", buyer.id, { account: acct.stripeAccountId }) });
  await db().insert(schema.billingCustomers).values({ orgId: buyer.id, stripeAccountId: acct.stripeAccountId, stripeCustomerId: c.id }).onConflictDoNothing();
  const again = await db()
    .select()
    .from(schema.billingCustomers)
    .where(and(eq(schema.billingCustomers.orgId, buyer.id), eq(schema.billingCustomers.stripeAccountId, acct.stripeAccountId)))
    .limit(1);
  return again[0]?.stripeCustomerId ?? c.id;
}

/**
 * Stripe Checkout (subscription mode) on the seller's connected account. The buyer must be a direct child of
 * the plan's seller (agency → client, client → customer).
 */
export async function createCheckout(
  buyerOrgId: string,
  planId: string,
  successUrl: string,
  cancelUrl: string,
  actor: Actor = {},
): Promise<{ url: string; sessionId: string }> {
  const stripe = requireStripe();
  const [buyer, plan] = await Promise.all([orgById(buyerOrgId), planById(planId)]);
  if (buyer.parentId !== plan.orgId) throw new BillingError("not_found", "Plan not found.");
  if (!plan.active) throw new BillingError("invalid", "This plan isn't on sale.");
  const success = appUrl(successUrl);
  const cancel = appUrl(cancelUrl);
  const acct = await readySellerAccount(plan.orgId);

  const live = await db()
    .select({ id: schema.subscriptions.id })
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.orgId, buyer.id),
        eq(schema.subscriptions.planId, plan.id),
        eq(schema.subscriptions.stripeAccountId, acct.stripeAccountId),
        ne(schema.subscriptions.status, "canceled"),
      ),
    )
    .limit(1);
  if (live[0]) throw new BillingError("conflict", "Already subscribed to this plan. Use Manage billing to change it.");

  try {
    const synced = (await freshSyncedPlan(plan, acct)) ?? (await syncPlanToStripe(plan.id, actor));
    const customer = await ensureCustomer(stripe, buyer, acct);
    const meta = { roster_buyer_org_id: buyer.id, roster_plan_id: plan.id, roster_seller_org_id: plan.orgId };
    const fee = platformFeeBps();
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: synced.stripePriceId, quantity: 1 }];
    if (synced.setupPriceId) lineItems.push({ price: synced.setupPriceId, quantity: 1 });
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      customer,
      client_reference_id: buyer.id,
      line_items: lineItems,
      success_url: withSessionParam(success),
      cancel_url: cancel,
      metadata: meta,
      subscription_data: { metadata: meta, ...(fee ? { application_fee_percent: fee / 100 } : {}) },
      allow_promotion_codes: false,
    };
    // Double-clicks and retries within a 10-minute window reuse the same session.
    const bucket = Math.floor(Date.now() / 600_000);
    const session = await stripe.checkout.sessions.create(params, {
      stripeAccount: acct.stripeAccountId,
      idempotencyKey: idemKey("checkout", `${buyer.id}:${plan.id}`, { params, bucket }),
    });
    if (!session.url) throw new BillingError("stripe_error", "Stripe didn't return a checkout link. Try again.");
    await audit({
      orgId: plan.orgId,
      actorType: actor.userId ? "user" : "system",
      actorId: actor.userId,
      action: "billing.checkout_created",
      targetType: "organization",
      targetId: buyer.id,
      metadata: { planId: plan.id, session: session.id },
    });
    return { url: session.url, sessionId: session.id };
  } catch (err) {
    if (!(err instanceof BillingError)) logger.error({ err: errInfo(err), buyerOrgId, planId }, "stripe checkout failed");
    throw toBillingError(err);
  }
}

function withSessionParam(url: string): string {
  // Stripe substitutes {CHECKOUT_SESSION_ID}; keep the braces unescaped.
  return `${url}${url.includes("?") ? "&" : "?"}checkout=success&session_id={CHECKOUT_SESSION_ID}`;
}

/** The seller account a buyer is billed by: its parent org's connected account. */
async function buyerSellerAccount(buyer: Org): Promise<BillingAccount | null> {
  if (!buyer.parentId) return null;
  return billingAccountFor(buyer.parentId);
}

/** Stripe customer portal (update card, invoices, cancel) on the seller's account. */
export async function customerPortalLink(buyerOrgId: string, returnUrl: string, actor: Actor = {}): Promise<{ url: string }> {
  const stripe = requireStripe();
  const buyer = await orgById(buyerOrgId);
  const back = appUrl(returnUrl);
  const acct = await buyerSellerAccount(buyer);
  if (!acct || acct.deauthorizedAt) throw new BillingError("not_connected", "Billing isn't set up for this workspace yet.");
  const cust = await db()
    .select()
    .from(schema.billingCustomers)
    .where(and(eq(schema.billingCustomers.orgId, buyer.id), eq(schema.billingCustomers.stripeAccountId, acct.stripeAccountId)))
    .limit(1);
  if (!cust[0]) throw new BillingError("not_found", "No billing profile yet. Subscribe to a plan first.");
  try {
    const s = await stripe.billingPortal.sessions.create({ customer: cust[0].stripeCustomerId, return_url: back }, { stripeAccount: acct.stripeAccountId });
    await audit({ orgId: buyer.id, actorType: actor.userId ? "user" : "system", actorId: actor.userId, action: "billing.portal_opened", targetType: "organization", targetId: buyer.id });
    return { url: s.url };
  } catch (err) {
    logger.error({ err: errInfo(err), buyerOrgId }, "stripe portal session failed");
    throw toBillingError(err);
  }
}

/**
 * Cancel a subscription. Stripe-backed: cancel at period end (default) or immediately; local state follows
 * the webhook, but we also mark it now so the UI is immediate. Manual (non-Stripe) rows cancel locally.
 */
export async function cancelSubscription(subscriptionId: string, opts: { atPeriodEnd?: boolean } & Actor = {}): Promise<typeof schema.subscriptions.$inferSelect> {
  const atPeriodEnd = opts.atPeriodEnd ?? true;
  const rows = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId)).limit(1);
  const sub = rows[0];
  if (!sub) throw new BillingError("not_found", "Subscription not found.");
  if (sub.status === "canceled") return sub;
  let patch: Partial<typeof schema.subscriptions.$inferInsert>;
  if (sub.stripeSubscriptionId && sub.stripeAccountId) {
    const stripe = requireStripe();
    try {
      if (atPeriodEnd) {
        await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true }, { stripeAccount: sub.stripeAccountId });
        patch = { cancelAtPeriodEnd: true };
      } else {
        await stripe.subscriptions.cancel(sub.stripeSubscriptionId, {}, { stripeAccount: sub.stripeAccountId });
        patch = { status: "canceled", canceledAt: new Date(), cancelAtPeriodEnd: false };
      }
    } catch (err) {
      logger.error({ err: errInfo(err), subscriptionId }, "stripe cancel failed");
      throw toBillingError(err);
    }
  } else {
    patch = { status: "canceled", canceledAt: new Date() };
  }
  const [updated] = await db().update(schema.subscriptions).set(patch).where(eq(schema.subscriptions.id, sub.id)).returning();
  await audit({ orgId: sub.orgId, actorType: opts.userId ? "user" : "system", actorId: opts.userId, action: "billing.subscription_cancel_requested", targetType: "subscription", targetId: sub.id, metadata: { atPeriodEnd } });
  return updated!;
}

// ── Status for UIs ──────────────────────────────────────────────────────────

export type SellerStatus = {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** "acct_…1234" — enough to recognise, never the full id in UI. */
  accountHint: string | null;
  plansSynced: number;
};

export type BuyerSubscription = {
  id: string;
  planId: string;
  planName: string;
  priceCents: number;
  setupFeeCents: number;
  currency: string;
  status: "trialing" | "active" | "past_due" | "canceled";
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** False for subscriptions recorded manually (no Stripe). */
  stripeManaged: boolean;
};

export type BillingStatus = {
  mode: BillingMode;
  org: { id: string; kind: Org["kind"]; name: string };
  /** Present when the org can sell (agency, or a client that resells). */
  seller: SellerStatus | null;
  /** Present when the org buys from a parent (client, customer). */
  buyer: {
    subscription: BuyerSubscription | null;
    /** Has a Stripe customer on the seller's account → the customer portal can open. */
    hasBillingProfile: boolean;
    /** The parent seller can take payments now. */
    sellerReady: boolean;
  } | null;
};

export async function getBillingStatus(orgId: string): Promise<BillingStatus> {
  const org = await orgById(orgId);
  const mode = billingMode();
  let seller: SellerStatus | null = null;
  if (org.kind !== "customer") {
    const acct = await billingAccountFor(org.id);
    const synced = acct ? await db().select({ id: schema.billingPrices.id }).from(schema.billingPrices).where(eq(schema.billingPrices.stripeAccountId, acct.stripeAccountId)) : [];
    const ok = !!acct && !acct.deauthorizedAt;
    seller = {
      connected: ok,
      chargesEnabled: ok && acct!.chargesEnabled,
      payoutsEnabled: ok && acct!.payoutsEnabled,
      detailsSubmitted: ok && acct!.detailsSubmitted,
      accountHint: ok ? `acct_…${acct!.stripeAccountId.slice(-4)}` : null,
      plansSynced: synced.length,
    };
  }
  let buyer: BillingStatus["buyer"] = null;
  if (org.parentId) {
    const subs = await db()
      .select({ sub: schema.subscriptions, plan: schema.plans })
      .from(schema.subscriptions)
      .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
      .where(eq(schema.subscriptions.orgId, org.id))
      .orderBy(desc(schema.subscriptions.createdAt));
    // Prefer the live one; otherwise the most recent.
    const pick = subs.find((s) => s.sub.status !== "canceled") ?? subs[0];
    const acct = await billingAccountFor(org.parentId);
    const cust = acct
      ? await db()
          .select({ id: schema.billingCustomers.id })
          .from(schema.billingCustomers)
          .where(and(eq(schema.billingCustomers.orgId, org.id), eq(schema.billingCustomers.stripeAccountId, acct.stripeAccountId)))
          .limit(1)
      : [];
    buyer = {
      subscription: pick
        ? {
            id: pick.sub.id,
            planId: pick.plan.id,
            planName: pick.plan.name,
            priceCents: pick.plan.priceCents,
            setupFeeCents: pick.plan.setupFeeCents,
            currency: pick.plan.currency,
            status: pick.sub.status,
            currentPeriodEnd: pick.sub.currentPeriodEnd,
            cancelAtPeriodEnd: pick.sub.cancelAtPeriodEnd,
            stripeManaged: !!pick.sub.stripeSubscriptionId,
          }
        : null,
      hasBillingProfile: !!cust[0],
      sellerReady: mode !== "disabled" && !!acct && !acct.deauthorizedAt && acct.chargesEnabled,
    };
  }
  return { mode, org: { id: org.id, kind: org.kind, name: org.name }, seller, buyer };
}

/** Billing status for several buyer orgs at once (agency client tables). */
export async function subscriptionStatusByOrg(orgIds: string[]): Promise<Map<string, BuyerSubscription["status"]>> {
  const out = new Map<string, BuyerSubscription["status"]>();
  if (!orgIds.length) return out;
  const rows = await db()
    .select({ orgId: schema.subscriptions.orgId, status: schema.subscriptions.status })
    .from(schema.subscriptions)
    .where(inArray(schema.subscriptions.orgId, orgIds))
    .orderBy(desc(schema.subscriptions.createdAt));
  for (const r of rows) if (!out.has(r.orgId) || out.get(r.orgId) === "canceled") out.set(r.orgId, r.status);
  return out;
}

export function errInfo(err: unknown) {
  if (err && typeof err === "object") {
    const e = err as { type?: unknown; code?: unknown; message?: unknown; statusCode?: unknown; requestId?: unknown };
    return { type: e.type, code: e.code, status: e.statusCode, requestId: e.requestId, message: typeof e.message === "string" ? e.message.slice(0, 300) : undefined };
  }
  return { message: String(err) };
}
