/**
 * Billing: Stripe Connect state for sellers and buyers.
 *
 * Every plan has a SELLER (the plan's org: an agency, or a client reselling to its customers) and every
 * subscription has a BUYER (the subscribing org). Each seller bills from its own Stripe account (Connect,
 * Standard), so customers, products, prices, checkout sessions and subscriptions all live on the seller's
 * connected account — never on the platform account.
 */
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, organizations, plans, updatedAt } from "./core";

/** A seller org's connected Stripe account (one per org). */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeAccountId: text("stripe_account_id").notNull(),
    chargesEnabled: boolean("charges_enabled").notNull().default(false),
    payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
    detailsSubmitted: boolean("details_submitted").notNull().default(false),
    livemode: boolean("livemode").notNull().default(false),
    country: text("country"),
    defaultCurrency: text("default_currency"),
    /** Set when the account owner disconnects the platform (account.application.deauthorized). */
    deauthorizedAt: timestamp("deauthorized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("billing_accounts_org_uq").on(t.orgId), uniqueIndex("billing_accounts_stripe_uq").on(t.stripeAccountId)],
);

/**
 * The buyer org's Stripe customer. Customers are per connected account, so a buyer has one row per seller
 * account it buys from (in practice one: its parent org's).
 */
export const billingCustomers = pgTable(
  "billing_customers",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeAccountId: text("stripe_account_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("billing_customers_org_account_uq").on(t.orgId, t.stripeAccountId),
    uniqueIndex("billing_customers_stripe_uq").on(t.stripeAccountId, t.stripeCustomerId),
  ],
);

/** A plan's Product + Prices on its seller's connected account (what syncPlanToStripe last wrote). */
export const billingPrices = pgTable(
  "billing_prices",
  {
    id: id(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeAccountId: text("stripe_account_id").notNull(),
    stripeProductId: text("stripe_product_id").notNull(),
    /** Monthly recurring flat-rate price. */
    stripePriceId: text("stripe_price_id").notNull(),
    unitAmount: integer("unit_amount").notNull(),
    currency: text("currency").notNull(),
    /** Optional one-time setup fee price (added to the first invoice). */
    setupPriceId: text("setup_price_id"),
    setupAmount: integer("setup_amount").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("billing_prices_plan_uq").on(t.planId), index("billing_prices_org_idx").on(t.orgId)],
);
