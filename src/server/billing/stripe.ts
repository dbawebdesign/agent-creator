/**
 * Stripe client factory and billing mode.
 *
 * Without STRIPE_SECRET_KEY billing is "disabled": nothing crashes, the UI shows a calm "not connected"
 * state, and every money-moving call returns a BillingError("not_configured"). Tests swap the factory
 * (setStripeFactory) for a real Stripe client over a fake httpClient, so the SDK's encoding still runs.
 */
import "server-only";
import Stripe from "stripe";
import { env } from "@/server/env";

export type BillingMode = "disabled" | "test" | "live";

export type BillingErrorCode =
  | "not_configured"
  | "not_connected"
  | "charges_disabled"
  | "not_found"
  | "invalid"
  | "conflict"
  | "stripe_error";

/** Safe-to-show billing failure. `message` is written for the UI; Stripe internals stay in logs. */
export class BillingError extends Error {
  constructor(
    public code: BillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

type Factory = (key: string) => Stripe;

const defaultFactory: Factory = (key) =>
  new Stripe(key, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "Roster", url: env().APP_URL },
  });

const g = globalThis as unknown as { __rosterStripe?: { key: string; client: Stripe }; __rosterStripeFactory?: Factory };

function secretKey(): string | undefined {
  // Read process.env directly so tests (and key rotation without restart) can flip modes; env() caches.
  const k = process.env.STRIPE_SECRET_KEY ?? env().STRIPE_SECRET_KEY;
  return k && k.trim() ? k.trim() : undefined;
}

export function billingMode(): BillingMode {
  const k = secretKey();
  if (!k) return "disabled";
  return k.startsWith("sk_live_") || k.startsWith("rk_live_") ? "live" : "test";
}

/** The platform Stripe client, or null when billing is not configured. */
export function stripeOrNull(): Stripe | null {
  const key = secretKey();
  if (!key) return null;
  if (g.__rosterStripe?.key !== key) {
    g.__rosterStripe = { key, client: (g.__rosterStripeFactory ?? defaultFactory)(key) };
  }
  return g.__rosterStripe.client;
}

export function requireStripe(): Stripe {
  const s = stripeOrNull();
  if (!s) throw new BillingError("not_configured", "Stripe isn't connected on this workspace yet (test mode). Add STRIPE_SECRET_KEY to enable billing.");
  return s;
}

/** Test hook: replace how the client is built (pass null to restore the default). */
export function setStripeFactory(factory: Factory | null) {
  g.__rosterStripeFactory = factory ?? undefined;
  g.__rosterStripe = undefined;
}

/** Platform application fee on subscriptions, in basis points (PLATFORM_FEE_BPS, default 0, max 50%). */
export function platformFeeBps(): number {
  const raw = Number(process.env.PLATFORM_FEE_BPS ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(5000, Math.floor(raw));
}

/** Webhook signing secrets: STRIPE_WEBHOOK_SECRET (comma-separated allowed) + STRIPE_CONNECT_WEBHOOK_SECRET. */
export function webhookSecrets(): string[] {
  const raw = [process.env.STRIPE_WEBHOOK_SECRET ?? env().STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET]
    .filter((s): s is string => !!s)
    .join(",");
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Map a Stripe SDK error to something safe to show. */
export function toBillingError(err: unknown, fallback = "Stripe couldn't complete that. Try again in a moment."): BillingError {
  if (err instanceof BillingError) return err;
  if (err instanceof Stripe.errors.StripeError) {
    if (err.type === "StripeInvalidRequestError" && /No configuration provided|portal/i.test(err.message)) {
      return new BillingError("stripe_error", "The billing portal isn't set up on this Stripe account yet. Save a portal configuration in the Stripe dashboard.");
    }
    if (err.type === "StripeAuthenticationError" || err.type === "StripePermissionError") {
      return new BillingError("stripe_error", "Stripe rejected our credentials for this account. Reconnect Stripe and try again.");
    }
  }
  return new BillingError("stripe_error", fallback);
}
