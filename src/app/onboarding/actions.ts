"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { audit } from "@/server/security/audit";
import { slugify } from "@/lib/utils";

export type OnboardingState = { error?: string; fieldErrors?: Record<string, string> } | undefined;

const RESERVED = new Set(["a", "p", "api", "login", "signup", "logout", "onboarding", "magic-link", "admin", "app", "www", "settings"]);

const input = z.object({
  name: z.string().trim().min(2, "Give your agency a name").max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, "At least 2 characters")
    .max(40)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and dashes"),
  price: z.coerce.number().int().min(0).max(1_000_000).default(5000),
});

export async function createAgency(_prev: OnboardingState, formData: FormData): Promise<OnboardingState> {
  const user = await requireUser();
  const raw = { name: formData.get("name"), slug: formData.get("slug") || slugify(String(formData.get("name") ?? "")), price: formData.get("price") ?? 5000 };
  const parsed = input.safeParse(raw);
  if (!parsed.success) {
    const fe: Record<string, string> = {};
    for (const i of parsed.error.issues) fe[String(i.path[0])] ??= i.message;
    return { fieldErrors: fe };
  }
  const { name, slug, price } = parsed.data;
  if (RESERVED.has(slug)) return { fieldErrors: { slug: "That address is reserved" } };
  const taken = await db()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.slug, slug), isNull(schema.organizations.deletedAt)))
    .limit(1);
  if (taken[0]) return { fieldErrors: { slug: "That address is taken" } };

  const orgId = randomUUID();
  try {
    await db().transaction(async (tx) => {
      await tx.insert(schema.organizations).values({ id: orgId, agencyId: orgId, kind: "agency", name, slug, branding: { displayName: name } });
      await tx.insert(schema.memberships).values({ userId: user.id, orgId, role: "owner" });
      await tx.insert(schema.plans).values({
        orgId,
        name: "AI employee",
        description: "One full-time AI employee. Flat monthly rate — no setup fee, no token billing.",
        priceCents: price * 100,
        features: ["Memory and knowledge base", "Its own email inbox", "A computer", "Email, SMS, Slack, API and MCP"],
      });
    });
  } catch {
    return { error: "We couldn’t create that agency. Try a different address." };
  }
  await audit({ orgId, actorType: "user", actorId: user.id, action: "agency.created", targetType: "organization", targetId: orgId });
  redirect(`/a/${slug}?welcome=1`);
}
