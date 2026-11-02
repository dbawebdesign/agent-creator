"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { requireOrg } from "@/server/auth/access";
import { clientIp } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";
import { randomToken, sha256 } from "@/server/security/crypto";
import * as engine from "@/server/services/engine";
import { slugify } from "@/lib/utils";

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const slugSchema = z.string().min(1).max(64);

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Engine calls can fail while the team is being provisioned; keep the message human. */
function engineError(
  err: unknown,
  fallback: string,
): { ok: false; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  // Never forward internals (stack traces, SQL, model errors) to clients.
  logger.warn({ err: msg }, "portal engine call failed");
  if (/not implemented/i.test(msg))
    return fail("Your team isn't reachable right now. Try again in a minute.");
  return fail(fallback);
}

function refresh(slug: string) {
  revalidatePath(`/p/${slug}`, "layout");
}

/* ----------------------------------------------------------------- Talk */

const askInput = z.object({
  slug: slugSchema,
  agentId: z.uuid(),
  text: z.string().trim().min(1, "Write a message first").max(8000),
  conversationId: z.uuid().optional(),
});

export async function askTeam(
  input: z.input<typeof askInput>,
): Promise<ActionResult<{ conversationId: string }>> {
  const parsed = askInput.safeParse(input);
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Check your message");
  const { slug, agentId, text, conversationId } = parsed.data;
  const access = await requireOrg(slug, "member");
  const [agent] = await db()
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.id, agentId),
        eq(schema.agents.orgId, access.org.id),
      ),
    )
    .limit(1);
  if (!agent) return fail("That teammate isn't on your team");
  if (conversationId) {
    const [c] = await db()
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.orgId, access.org.id),
        ),
      )
      .limit(1);
    if (!c) return fail("That conversation is gone");
  }
  try {
    const res = await engine.messageAgent({
      orgId: access.org.id,
      agentId,
      text,
      conversationId,
      channel: "portal",
      actor: { type: "user", userId: access.user.id },
    });
    refresh(slug);
    return { ok: true, conversationId: res.conversationId };
  } catch (err) {
    return engineError(err, "Couldn't send that. Try again.");
  }
}

/* ---------------------------------------------------------------- Review */

const reviewInput = z.object({
  slug: slugSchema,
  deliverableId: z.uuid(),
  action: z.enum(["approve", "request_changes", "archive"]),
  feedback: z.string().trim().max(4000).optional(),
});

export async function reviewDeliverableAction(
  input: z.input<typeof reviewInput>,
): Promise<ActionResult> {
  const parsed = reviewInput.safeParse(input);
  if (!parsed.success) return fail("Something about that didn't look right");
  const { slug, deliverableId, action, feedback } = parsed.data;
  if (action === "request_changes" && !feedback)
    return fail("Tell them what to change");
  const access = await requireOrg(slug, "member");
  const [d] = await db()
    .select({ id: schema.deliverables.id, runId: schema.deliverables.runId })
    .from(schema.deliverables)
    .where(
      and(
        eq(schema.deliverables.id, deliverableId),
        eq(schema.deliverables.orgId, access.org.id),
      ),
    )
    .limit(1);
  if (!d) return fail("That item is gone");
  const actor = { type: "user" as const, userId: access.user.id };
  try {
    await engine.reviewDeliverable({
      orgId: access.org.id,
      deliverableId,
      action,
      feedback,
      actor,
    });
    // An email draft that waits on a send approval is decided together with its review.
    if (d.runId && action !== "archive") {
      const pending = await db()
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.orgId, access.org.id),
            eq(schema.approvals.runId, d.runId),
            eq(schema.approvals.status, "pending"),
          ),
        );
      for (const a of pending) {
        await engine.decideApproval({
          orgId: access.org.id,
          approvalId: a.id,
          decision: action === "approve" ? "approved" : "rejected",
          actor,
        });
      }
    }
    refresh(slug);
    return { ok: true };
  } catch (err) {
    return engineError(err, "Couldn't save that. Try again.");
  }
}

const approvalInput = z.object({
  slug: slugSchema,
  approvalId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
});

export async function decideApprovalAction(
  input: z.input<typeof approvalInput>,
): Promise<ActionResult> {
  const parsed = approvalInput.safeParse(input);
  if (!parsed.success) return fail("Something about that didn't look right");
  const { slug, approvalId, decision } = parsed.data;
  const access = await requireOrg(slug, "member");
  try {
    await engine.decideApproval({
      orgId: access.org.id,
      approvalId,
      decision,
      actor: { type: "user", userId: access.user.id },
    });
    refresh(slug);
    return { ok: true };
  } catch (err) {
    return engineError(err, "Couldn't save that. Try again.");
  }
}

/* --------------------------------------------------------------- API keys */

const keyInput = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1, "Give the key a name").max(80),
  agentId: z.uuid().optional(),
});

export async function createApiKeyAction(
  input: z.input<typeof keyInput>,
): Promise<ActionResult<{ key: string; prefix: string }>> {
  const parsed = keyInput.safeParse(input);
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Check the name");
  const { slug, name, agentId } = parsed.data;
  const access = await requireOrg(slug, "admin");
  try {
    const { createApiKey } = await import("@/server/api/keys");
    const h = await headers();
    const res = await createApiKey({
      orgId: access.org.id,
      name,
      agentId: agentId ?? null,
      scopes: ["agents:read", "agents:invoke", "deliverables:read"],
      createdBy: access.user.id,
      ip: clientIp(h),
    });
    refresh(slug);
    return { ok: true, key: res.key, prefix: res.apiKey.prefix };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "api key create failed",
    );
    return fail("Couldn't create a key right now. Try again in a minute.");
  }
}

export async function revokeApiKeyAction(input: {
  slug: string;
  keyId: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({ slug: slugSchema, keyId: z.uuid() })
    .safeParse(input);
  if (!parsed.success) return fail("Unknown key");
  const access = await requireOrg(parsed.data.slug, "admin");
  try {
    const { revokeApiKey } = await import("@/server/api/keys");
    const h = await headers();
    await revokeApiKey(access.org.id, parsed.data.keyId, {
      userId: access.user.id,
      ip: clientIp(h),
    });
    refresh(parsed.data.slug);
    return { ok: true };
  } catch {
    return fail("Couldn't revoke that key");
  }
}

/* ----------------------------------------------------------------- Resell */

async function requireReseller(slug: string) {
  const access = await requireOrg(slug, "admin");
  if (access.org.kind !== "client") return null;
  return access;
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "customer";
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [hit] = await db()
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, candidate))
      .limit(1);
    if (!hit) return candidate;
  }
  return `${root}-${randomToken(3)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}`;
}

async function issueInvite(
  orgId: string,
  email: string,
  role: "admin" | "member" | "viewer" | "owner",
  invitedBy: string,
) {
  const token = randomToken(32);
  await db()
    .insert(schema.invitations)
    .values({
      orgId,
      email: email.toLowerCase(),
      role,
      tokenHash: sha256(token),
      invitedBy,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
    });
  return `${env().APP_URL.replace(/\/+$/, "")}/invite/${token}`;
}

const customerInput = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2, "Add the business name").max(120),
  email: z
    .union([z.literal(""), z.email("That email doesn't look right")])
    .optional(),
});

export async function addCustomerAction(
  input: z.input<typeof customerInput>,
): Promise<ActionResult<{ customerSlug: string; inviteUrl: string | null }>> {
  const parsed = customerInput.safeParse(input);
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Check the details");
  const access = await requireReseller(parsed.data.slug);
  if (!access) return fail("Only client workspaces can resell");
  const { name, email } = parsed.data;
  const [dupe] = await db()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.parentId, access.org.id),
        isNull(schema.organizations.deletedAt),
        sql`lower(${schema.organizations.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (dupe) return fail(`You already have a customer called ${name}`);
  const slug = await uniqueSlug(name);
  const [org] = await db()
    .insert(schema.organizations)
    .values({
      kind: "customer",
      parentId: access.org.id,
      agencyId: access.org.agencyId,
      name,
      slug,
      timezone: access.org.timezone,
    })
    .returning({ id: schema.organizations.id });
  if (!org) return fail("Couldn't add that customer");
  const inviteUrl = email
    ? await issueInvite(org.id, email, "owner", access.user.id)
    : null;
  await audit({
    orgId: access.org.id,
    actorType: "user",
    actorId: access.user.id,
    action: "customer.created",
    targetType: "organization",
    targetId: org.id,
    metadata: { name, invited: Boolean(email) },
  });
  refresh(parsed.data.slug);
  return { ok: true, customerSlug: slug, inviteUrl };
}

const offerInput = z.object({
  slug: slugSchema,
  agentId: z.uuid("Pick a teammate"),
  customerId: z.uuid("Pick a customer"),
  planId: z.uuid().optional(),
});

export async function offerAgentAction(
  input: z.input<typeof offerInput>,
): Promise<ActionResult> {
  const parsed = offerInput.safeParse(input);
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Check the details");
  const access = await requireReseller(parsed.data.slug);
  if (!access) return fail("Only client workspaces can resell");
  const { agentId, customerId, planId } = parsed.data;
  const [customer] = await db()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.id, customerId),
        eq(schema.organizations.parentId, access.org.id),
        eq(schema.organizations.kind, "customer"),
        isNull(schema.organizations.deletedAt),
      ),
    )
    .limit(1);
  if (!customer) return fail("That customer isn't yours");
  if (planId) {
    const [plan] = await db()
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(
        and(eq(schema.plans.id, planId), eq(schema.plans.orgId, access.org.id)),
      )
      .limit(1);
    if (!plan) return fail("That price plan isn't yours");
  }
  try {
    await engine.resellAgent({
      orgId: access.org.id,
      agentId,
      customerOrgId: customerId,
      actor: { type: "user", userId: access.user.id },
    });
  } catch (err) {
    return engineError(err, "Couldn't set that up. Try again.");
  }
  if (planId) {
    await db()
      .insert(schema.subscriptions)
      .values({ orgId: customerId, planId, status: "active" });
  }
  refresh(parsed.data.slug);
  return { ok: true };
}

const planInput = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2, "Name your plan").max(80),
  price: z.coerce.number().min(1, "Set a monthly price").max(1_000_000),
  description: z.string().trim().max(400).optional(),
});

export async function createPlanAction(
  input: z.input<typeof planInput>,
): Promise<ActionResult> {
  const parsed = planInput.safeParse(input);
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Check the plan");
  const access = await requireReseller(parsed.data.slug);
  if (!access) return fail("Only client workspaces can resell");
  const [dupe] = await db()
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(
      and(
        eq(schema.plans.orgId, access.org.id),
        eq(schema.plans.active, true),
        sql`lower(${schema.plans.name}) = lower(${parsed.data.name})`,
      ),
    )
    .limit(1);
  if (dupe) return fail("You already have a plan with that name");
  await db()
    .insert(schema.plans)
    .values({
      orgId: access.org.id,
      name: parsed.data.name,
      description: parsed.data.description || null,
      priceCents: Math.round(parsed.data.price * 100),
    });
  refresh(parsed.data.slug);
  return { ok: true };
}

/* --------------------------------------------------------------- Settings */

const inviteInput = z.object({
  slug: slugSchema,
  email: z.email("That email doesn't look right"),
  role: z.enum(["admin", "member", "viewer"]),
});

export async function inviteMemberAction(
  input: z.input<typeof inviteInput>,
): Promise<ActionResult<{ inviteUrl: string }>> {
  const parsed = inviteInput.safeParse(input);
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Check the email");
  const access = await requireOrg(parsed.data.slug, "admin");
  const email = parsed.data.email.toLowerCase();
  const [existing] = await db()
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(
      and(
        eq(schema.memberships.orgId, access.org.id),
        sql`lower(${schema.users.email}) = ${email}`,
      ),
    )
    .limit(1);
  if (existing) return fail("They're already on this workspace");
  const inviteUrl = await issueInvite(
    access.org.id,
    email,
    parsed.data.role,
    access.user.id,
  );
  await audit({
    orgId: access.org.id,
    actorType: "user",
    actorId: access.user.id,
    action: "member.invited",
    targetType: "invitation",
    metadata: { role: parsed.data.role },
  });
  refresh(parsed.data.slug);
  return { ok: true, inviteUrl };
}

export async function revokeInviteAction(input: {
  slug: string;
  inviteId: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({ slug: slugSchema, inviteId: z.uuid() })
    .safeParse(input);
  if (!parsed.success) return fail("Unknown invite");
  const access = await requireOrg(parsed.data.slug, "admin");
  await db()
    .delete(schema.invitations)
    .where(
      and(
        eq(schema.invitations.id, parsed.data.inviteId),
        eq(schema.invitations.orgId, access.org.id),
      ),
    );
  refresh(parsed.data.slug);
  return { ok: true };
}

const prefsInput = z.object({
  slug: slugSchema,
  channels: z.array(z.enum(["email", "sms", "slack", "portal"])).max(4),
  cadence: z.enum(["instant", "digest"]),
});

export async function savePrefsAction(
  input: z.input<typeof prefsInput>,
): Promise<ActionResult> {
  const parsed = prefsInput.safeParse(input);
  if (!parsed.success) return fail("Pick at least one place");
  // Any member (including viewers) may choose where *they* hear about work.
  const access = await requireOrg(parsed.data.slug, "viewer");
  const userId = access.user.id;
  const value = JSON.stringify({
    [userId]: { channels: parsed.data.channels, cadence: parsed.data.cadence },
  });
  // Merge just this user's entry so concurrent saves by teammates don't clobber each other.
  await db()
    .update(schema.organizations)
    .set({
      settings: sql`coalesce(${schema.organizations.settings}, '{}'::jsonb) || jsonb_build_object('notificationPrefs', coalesce(${schema.organizations.settings}->'notificationPrefs', '{}'::jsonb) || ${value}::jsonb)`,
    })
    .where(eq(schema.organizations.id, access.org.id));
  refresh(parsed.data.slug);
  return { ok: true };
}

const brandingInput = z.object({
  slug: slugSchema,
  displayName: z.string().trim().max(60).optional(),
  accent: z
    .union([
      z.literal(""),
      z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #E11D48"),
    ])
    .optional(),
  logoUrl: z
    .union([
      z.literal(""),
      z.url({ protocol: /^https$/, message: "Use an https:// image link" }),
    ])
    .optional(),
});

export async function saveBrandingAction(
  input: z.input<typeof brandingInput>,
): Promise<ActionResult> {
  const parsed = brandingInput.safeParse(input);
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Check your branding");
  const access = await requireOrg(parsed.data.slug, "admin");
  if (access.org.kind !== "client")
    return fail("Branding is set by your provider");
  const current = access.org.branding ?? {};
  const next = {
    ...current,
    displayName: parsed.data.displayName || undefined,
    accent: parsed.data.accent ? parsed.data.accent.toLowerCase() : undefined,
    logoUrl: parsed.data.logoUrl || undefined,
  };
  await db()
    .update(schema.organizations)
    .set({ branding: next })
    .where(eq(schema.organizations.id, access.org.id));
  await audit({
    orgId: access.org.id,
    actorType: "user",
    actorId: access.user.id,
    action: "branding.updated",
    targetType: "organization",
    targetId: access.org.id,
  });
  refresh(parsed.data.slug);
  return { ok: true };
}

/* ------------------------------------------------------------ Workflows */

const workflowToggleInput = z.object({
  slug: slugSchema,
  workflowId: z.uuid(),
  enabled: z.boolean(),
});

/** Pause or resume one of a teammate's routines. Admins only; the routine must belong to this workspace. */
export async function setWorkflowEnabledAction(
  input: z.input<typeof workflowToggleInput>,
): Promise<ActionResult> {
  const parsed = workflowToggleInput.safeParse(input);
  if (!parsed.success) return fail("Unknown routine");
  const access = await requireOrg(parsed.data.slug, "admin");
  const [wf] = await db()
    .select({
      id: schema.workflows.id,
      trigger: schema.workflows.trigger,
      name: schema.workflows.name,
    })
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.id, parsed.data.workflowId),
        eq(schema.workflows.orgId, access.org.id),
      ),
    )
    .limit(1);
  if (!wf) return fail("Unknown routine");
  const { nextRunForTrigger } = await import("@/server/jobs/scheduler");
  // Resuming schedules from now, so a paused routine never fires a backlog of missed runs.
  const nextRunAt = parsed.data.enabled
    ? nextRunForTrigger(wf.trigger, access.org.timezone)
    : null;
  await db()
    .update(schema.workflows)
    .set({ enabled: parsed.data.enabled, nextRunAt })
    .where(
      and(
        eq(schema.workflows.id, wf.id),
        eq(schema.workflows.orgId, access.org.id),
      ),
    );
  await audit({
    orgId: access.org.id,
    actorType: "user",
    actorId: access.user.id,
    action: parsed.data.enabled ? "workflow.resumed" : "workflow.paused",
    targetType: "workflow",
    targetId: wf.id,
    metadata: { name: wf.name },
  });
  refresh(parsed.data.slug);
  return { ok: true };
}
