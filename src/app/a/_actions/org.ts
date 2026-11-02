"use server";

import { and, eq, isNull, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { clientIp } from "@/server/auth/session";
import { audit } from "@/server/security/audit";
import { randomToken, sha256 } from "@/server/security/crypto";
import { API_SCOPES, apiScope, createApiKey, revokeApiKey } from "@/server/api/keys";
import { fail, insertClientOrg, requireVerified, studio, studioClient, type Result } from "./ctx";

const uuid = z.uuid();
const INVITE_TTL = 1000 * 60 * 60 * 24 * 7;

// ── Clients ────────────────────────────────────────────────────────────────

const clientInput = z.object({
  name: z.string().trim().min(2, "Client name is required").max(80),
  industry: z.string().trim().max(80).optional(),
  website: z.string().trim().max(200).optional(),
  planId: uuid.optional().or(z.literal("")),
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine((tz) => {
      if (!tz) return true;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Pick a timezone from the list")
    .optional(),
});

export async function createClient(slug: string, raw: z.input<typeof clientInput>): Promise<Result<{ id: string; slug: string }>> {
  const parsed = clientInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  try {
    const ctx = await studio(slug, "member");
    const org = await insertClientOrg(ctx.agency.id, parsed.data);
    if (parsed.data.planId) {
      const plan = await db().select({ id: schema.plans.id }).from(schema.plans).where(and(eq(schema.plans.id, parsed.data.planId), eq(schema.plans.orgId, ctx.agency.id))).limit(1);
      if (plan[0]) await db().insert(schema.subscriptions).values({ orgId: org.id, planId: plan[0].id, status: "active" });
    }
    await audit({ orgId: ctx.agency.id, actorType: "user", actorId: ctx.access.user.id, action: "client.created", targetType: "organization", targetId: org.id });
    revalidatePath(`/a/${slug}`, "layout");
    return { ok: true, id: org.id, slug: org.slug };
  } catch (err) {
    return fail(err);
  }
}

export async function setClientPlan(slug: string, clientId: string, planId: string | null): Promise<Result> {
  try {
    const ctx = await studioClient(slug, clientId, "admin");
    requireVerified(ctx);
    await db()
      .update(schema.subscriptions)
      .set({ status: "canceled", canceledAt: new Date() })
      .where(and(eq(schema.subscriptions.orgId, ctx.client.id), ne(schema.subscriptions.status, "canceled")));
    if (planId) {
      const plan = await db().select({ id: schema.plans.id }).from(schema.plans).where(and(eq(schema.plans.id, planId), eq(schema.plans.orgId, ctx.agency.id))).limit(1);
      if (!plan[0]) return { ok: false, error: "Plan not found" };
      const end = new Date();
      end.setMonth(end.getMonth() + 1);
      await db().insert(schema.subscriptions).values({ orgId: ctx.client.id, planId: plan[0].id, status: "active", currentPeriodEnd: end });
    }
    await audit({ orgId: ctx.agency.id, actorType: "user", actorId: ctx.access.user.id, action: "subscription.changed", targetType: "organization", targetId: ctx.client.id, metadata: { planId } });
    revalidatePath(`/a/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setClientStatus(slug: string, clientId: string, status: "active" | "trial" | "paused" | "churned"): Promise<Result> {
  if (!["active", "trial", "paused", "churned"].includes(status)) return { ok: false, error: "Invalid status" };
  try {
    const ctx = await studioClient(slug, clientId, "admin");
    await db().update(schema.organizations).set({ status }).where(eq(schema.organizations.id, ctx.client.id));
    revalidatePath(`/a/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

async function createInvite(orgId: string, email: string, role: "owner" | "admin" | "member" | "viewer", invitedBy: string) {
  const token = randomToken(24);
  await db().insert(schema.invitations).values({ orgId, email: email.toLowerCase(), role, tokenHash: sha256(token), invitedBy, expiresAt: new Date(Date.now() + INVITE_TTL) });
  return `${env().APP_URL}/invite?token=${encodeURIComponent(token)}`;
}

const inviteInput = z.object({ email: z.email("Enter a valid email").max(254), role: z.enum(["owner", "admin", "member", "viewer"]).default("member") });

export async function inviteClientOwner(slug: string, clientId: string, email: string): Promise<Result<{ link: string | null }>> {
  const parsed = inviteInput.safeParse({ email, role: "owner" });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a valid email" };
  try {
    const ctx = await studioClient(slug, clientId, "admin");
    requireVerified(ctx);
    // Never grant more than the inviter holds: agency owners invite client owners, agency admins invite client admins.
    const role = ctx.access.role === "owner" ? "owner" : "admin";
    const link = await createInvite(ctx.client.id, parsed.data.email, role, ctx.access.user.id);
    await audit({ orgId: ctx.client.id, actorType: "user", actorId: ctx.access.user.id, action: "invitation.created", metadata: { email: parsed.data.email, role }, ip: clientIp(await headers()) });
    revalidatePath(`/a/${slug}/clients`, "layout");
    return { ok: true, link: env().NODE_ENV === "production" ? null : link };
  } catch (err) {
    return fail(err);
  }
}

// ── Team ───────────────────────────────────────────────────────────────────

export async function inviteMember(slug: string, raw: z.input<typeof inviteInput>): Promise<Result<{ link: string | null }>> {
  const parsed = inviteInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a valid email" };
  try {
    const ctx = await studio(slug, "admin");
    requireVerified(ctx);
    if (parsed.data.role === "owner" && ctx.access.role !== "owner") return { ok: false, error: "Only owners can invite owners" };
    const link = await createInvite(ctx.agency.id, parsed.data.email, parsed.data.role, ctx.access.user.id);
    await audit({ orgId: ctx.agency.id, actorType: "user", actorId: ctx.access.user.id, action: "invitation.created", metadata: { email: parsed.data.email, role: parsed.data.role } });
    revalidatePath(`/a/${slug}/settings`);
    return { ok: true, link: env().NODE_ENV === "production" ? null : link };
  } catch (err) {
    return fail(err);
  }
}

export async function revokeInvite(slug: string, inviteId: string): Promise<Result> {
  if (!uuid.safeParse(inviteId).success) return { ok: false, error: "Invalid invite" };
  try {
    const ctx = await studio(slug, "admin");
    await db().delete(schema.invitations).where(and(eq(schema.invitations.id, inviteId), eq(schema.invitations.orgId, ctx.agency.id), isNull(schema.invitations.acceptedAt)));
    revalidatePath(`/a/${slug}/settings`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// ── Agency profile & branding ──────────────────────────────────────────────

const profileInput = z.object({
  name: z.string().trim().min(2).max(60),
  website: z.string().trim().max(200).optional(),
  timezone: z.string().trim().min(3).max(64),
  displayName: z.string().trim().max(60).optional(),
  accent: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #4F46E5").optional().or(z.literal("")),
  logoUrl: z.string().trim().max(500).refine((v) => !v || /^https:\/\//.test(v), "Logo must be an https:// URL").optional(),
  emailFromName: z.string().trim().max(60).optional(),
  showPoweredBy: z.boolean(),
});

export async function updateAgency(slug: string, raw: z.input<typeof profileInput>): Promise<Result> {
  const parsed = profileInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  try {
    Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone });
  } catch {
    return { ok: false, error: "Unknown time zone" };
  }
  try {
    const ctx = await studio(slug, "admin");
    const d = parsed.data;
    await db()
      .update(schema.organizations)
      .set({
        name: d.name,
        website: d.website || null,
        timezone: d.timezone,
        // "Powered by Roster" is opt-in (portal reads showPoweredBy); whiteLabel stays its inverse for email footers.
        branding: {
          ...ctx.agency.branding,
          displayName: d.displayName || undefined,
          accent: d.accent || undefined,
          logoUrl: d.logoUrl || undefined,
          emailFromName: d.emailFromName || undefined,
          whiteLabel: !d.showPoweredBy,
          showPoweredBy: d.showPoweredBy,
        } as typeof ctx.agency.branding,
      })
      .where(eq(schema.organizations.id, ctx.agency.id));
    await audit({ orgId: ctx.agency.id, actorType: "user", actorId: ctx.access.user.id, action: "agency.updated" });
    revalidatePath(`/a/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// ── Plans ──────────────────────────────────────────────────────────────────

const planInput = z.object({
  name: z.string().trim().min(2, "Name the plan").max(60),
  description: z.string().trim().max(300).optional(),
  price: z.number().min(0).max(1_000_000),
  setupFee: z.number().min(0).max(1_000_000).default(0),
  features: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
});

export async function savePlan(slug: string, planId: string | null, raw: z.input<typeof planInput>): Promise<Result<{ id: string }>> {
  const parsed = planInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  try {
    const ctx = await studio(slug, "admin");
    requireVerified(ctx);
    const values = {
      name: parsed.data.name,
      description: parsed.data.description || null,
      priceCents: Math.round(parsed.data.price * 100),
      setupFeeCents: Math.round(parsed.data.setupFee * 100),
      features: parsed.data.features,
    };
    let id = planId;
    if (planId) {
      const rows = await db().update(schema.plans).set(values).where(and(eq(schema.plans.id, planId), eq(schema.plans.orgId, ctx.agency.id))).returning({ id: schema.plans.id });
      if (!rows[0]) return { ok: false, error: "Plan not found" };
    } else {
      const [row] = await db().insert(schema.plans).values({ ...values, orgId: ctx.agency.id }).returning({ id: schema.plans.id });
      id = row!.id;
    }
    revalidatePath(`/a/${slug}/billing`);
    return { ok: true, id: id! };
  } catch (err) {
    return fail(err);
  }
}

export async function setPlanActive(slug: string, planId: string, active: boolean): Promise<Result> {
  try {
    const ctx = await studio(slug, "admin");
    requireVerified(ctx);
    await db().update(schema.plans).set({ active: !!active }).where(and(eq(schema.plans.id, planId), eq(schema.plans.orgId, ctx.agency.id)));
    revalidatePath(`/a/${slug}/billing`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// ── API keys ───────────────────────────────────────────────────────────────

export async function createKey(slug: string, name: string, scopes: string[]): Promise<Result<{ key: string }>> {
  const parsed = z.object({ name: z.string().trim().min(1, "Name the key").max(80), scopes: z.array(apiScope).min(1, "Pick at least one scope") }).safeParse({ name, scopes });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  try {
    const ctx = await studio(slug, "admin");
    const { key } = await createApiKey({ orgId: ctx.agency.id, name: parsed.data.name, scopes: parsed.data.scopes, createdBy: ctx.access.user.id, ip: clientIp(await headers()) });
    revalidatePath(`/a/${slug}/settings`);
    return { ok: true, key };
  } catch (err) {
    return fail(err);
  }
}

export async function revokeKey(slug: string, keyId: string): Promise<Result> {
  try {
    const ctx = await studio(slug, "admin");
    await revokeApiKey(ctx.agency.id, keyId, { userId: ctx.access.user.id });
    revalidatePath(`/a/${slug}/settings`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
