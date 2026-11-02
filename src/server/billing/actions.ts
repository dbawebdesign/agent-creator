"use server";
/**
 * Billing server actions (called by src/components/billing/*). Every action: zod-validate → session auth via
 * requireOrgById(…, "admin") → service call → { ok, … } | { ok: false, error }. 404-shaped errors on no access.
 *
 * Who may do what:
 *  - Connect Stripe for org X: a DIRECT admin/owner of X (agency staff can't attach their bank to a client's
 *    resale account).
 *  - Sync a plan: an admin of the plan's seller org.
 *  - Checkout for buyer B: an admin of B — directly (the buyer) or via an ancestor (the seller's staff creating a
 *    link to send). The plan must belong to B's parent.
 *  - Billing portal / cancel for buyer B: an admin of B (direct or inherited).
 */
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgById, type OrgAccess } from "@/server/auth/access";
import { db, schema } from "@/server/db/client";
import { rateLimit } from "@/server/security/rate-limit";
import { cancelSubscription, connectOnboardingLink, createCheckout, customerPortalLink, getBillingStatus, refreshAccount, syncPlanToStripe, type BillingStatus } from "./service";
import { BillingError } from "./stripe";

export type BillingResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string };

const uuid = z.uuid();
const path = z
  .string()
  .trim()
  .max(500)
  .refine((p) => p.startsWith("/") && !p.startsWith("//") && !p.includes("\\"), "Invalid return path")
  .optional();

const NOT_FOUND = "Not found";

function isNextControl(err: unknown): boolean {
  const d = err && typeof err === "object" && "digest" in err ? (err as { digest?: unknown }).digest : undefined;
  return typeof d === "string" && (d.startsWith("NEXT_HTTP_ERROR_FALLBACK") || d === "NEXT_NOT_FOUND");
}

function isRedirect(err: unknown): boolean {
  const d = err && typeof err === "object" && "digest" in err ? (err as { digest?: unknown }).digest : undefined;
  return typeof d === "string" && d.startsWith("NEXT_REDIRECT");
}

function failure(err: unknown): { ok: false; error: string; code?: string } {
  if (isRedirect(err)) throw err; // e.g. requireUser → /login
  if (isNextControl(err)) return { ok: false, error: NOT_FOUND, code: "not_found" };
  if (err instanceof BillingError) return { ok: false, error: err.message, code: err.code };
  return { ok: false, error: "Something went wrong. Try again." };
}

function revalidate(p: string | undefined) {
  if (!p) return;
  try {
    revalidatePath(p);
  } catch {
    // Outside a request (tests, scripts) there is nothing to revalidate.
  }
}

async function limited(access: OrgAccess, bucket: string) {
  const rl = await rateLimit(`billing:${bucket}:${access.user.id}`, 20, 60);
  if (!rl.ok) throw new BillingError("invalid", "Too many billing requests. Wait a minute and try again.");
}

/** Hosted Stripe onboarding for a seller. Returns the Stripe URL to navigate to. */
export async function startStripeConnect(sellerOrgId: string, returnPath?: string): Promise<BillingResult<{ url: string }>> {
  try {
    const id = uuid.parse(sellerOrgId);
    const ret = path.parse(returnPath) ?? "/";
    const access = await requireOrgById(id, "admin");
    if (access.inherited && !access.user.isPlatformAdmin) throw new BillingError("invalid", "Only this organization's own admins can connect its Stripe account.");
    await limited(access, "connect");
    const { url } = await connectOnboardingLink(id, ret, { userId: access.user.id });
    return { ok: true, url };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "Invalid request", code: "invalid" };
    return failure(err);
  }
}

/** Re-read the connected account from Stripe (e.g. a "Refresh status" control). */
export async function refreshStripeAccount(sellerOrgId: string, revalidate_?: string): Promise<BillingResult<{ chargesEnabled: boolean }>> {
  try {
    const id = uuid.parse(sellerOrgId);
    await requireOrgById(id, "admin");
    const a = await refreshAccount(id);
    revalidate(path.parse(revalidate_));
    return { ok: true, chargesEnabled: !!a?.chargesEnabled };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "Invalid request", code: "invalid" };
    return failure(err);
  }
}

export async function syncPlan(planId: string, revalidate_?: string): Promise<BillingResult<{ priceId: string }>> {
  try {
    const id = uuid.parse(planId);
    const plan = (await db().select({ orgId: schema.plans.orgId }).from(schema.plans).where(eq(schema.plans.id, id)).limit(1))[0];
    if (!plan) return { ok: false, error: NOT_FOUND, code: "not_found" };
    const access = await requireOrgById(plan.orgId, "admin");
    await limited(access, "sync");
    const row = await syncPlanToStripe(id, { userId: access.user.id });
    revalidate(path.parse(revalidate_));
    return { ok: true, priceId: row.stripePriceId };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "Invalid request", code: "invalid" };
    return failure(err);
  }
}

/**
 * Checkout link for buyer + plan. The buyer's admin opens it; the seller's admins (inherited access) can create
 * it to copy/send. success/cancel default to `returnPath`.
 */
export async function startCheckout(
  buyerOrgId: string,
  planId: string,
  opts: { returnPath?: string; successPath?: string; cancelPath?: string } = {},
): Promise<BillingResult<{ url: string }>> {
  try {
    const buyer = uuid.parse(buyerOrgId);
    const plan = uuid.parse(planId);
    const ret = path.parse(opts.returnPath) ?? "/";
    const success = path.parse(opts.successPath) ?? ret;
    const cancel = path.parse(opts.cancelPath) ?? ret;
    const access = await requireOrgById(buyer, "admin");
    await limited(access, "checkout");
    const { url } = await createCheckout(buyer, plan, success, cancel, { userId: access.user.id });
    return { ok: true, url };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "Invalid request", code: "invalid" };
    return failure(err);
  }
}

export async function openBillingPortal(buyerOrgId: string, returnPath?: string): Promise<BillingResult<{ url: string }>> {
  try {
    const buyer = uuid.parse(buyerOrgId);
    const ret = path.parse(returnPath) ?? "/";
    const access = await requireOrgById(buyer, "admin");
    await limited(access, "portal");
    const { url } = await customerPortalLink(buyer, ret, { userId: access.user.id });
    return { ok: true, url };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "Invalid request", code: "invalid" };
    return failure(err);
  }
}

export async function cancelBuyerSubscription(subscriptionId: string, opts: { atPeriodEnd?: boolean; revalidatePath?: string } = {}): Promise<BillingResult<{ status: string; cancelAtPeriodEnd: boolean }>> {
  try {
    const id = uuid.parse(subscriptionId);
    const sub = (await db().select({ orgId: schema.subscriptions.orgId }).from(schema.subscriptions).where(eq(schema.subscriptions.id, id)).limit(1))[0];
    if (!sub) return { ok: false, error: NOT_FOUND, code: "not_found" };
    const access = await requireOrgById(sub.orgId, "admin");
    const row = await cancelSubscription(id, { atPeriodEnd: opts.atPeriodEnd !== false, userId: access.user.id });
    revalidate(path.parse(opts.revalidatePath));
    return { ok: true, status: row.status, cancelAtPeriodEnd: row.cancelAtPeriodEnd };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "Invalid request", code: "invalid" };
    return failure(err);
  }
}

/** Status for client components that poll after returning from Stripe. */
export async function loadBillingStatus(orgId: string): Promise<BillingResult<{ status: BillingStatus }>> {
  try {
    const id = uuid.parse(orgId);
    await requireOrgById(id, "viewer");
    return { ok: true, status: await getBillingStatus(id) };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "Invalid request", code: "invalid" };
    return failure(err);
  }
}
