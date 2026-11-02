import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db/client";
import { slugify } from "@/lib/utils";
import { notFound } from "next/navigation";
import { requireOrg, type Role } from "@/server/auth/access";
import type { Actor } from "@/server/services/engine";
import { agencyOrgs, getAgent } from "@/server/queries/studio";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function studio(slug: string, min: Role = "member") {
  const access = await requireOrg(slug, min);
  if (access.org.kind !== "agency") notFound();
  const actor: Actor = { type: "user", userId: access.user.id };
  return { access, agency: access.org, actor };
}

/** An agent in this agency's tree, or 404. */
export async function studioAgent(slug: string, agentId: string, min: Role = "member") {
  const ctx = await studio(slug, min);
  const found = await getAgent(ctx.agency.id, agentId);
  if (!found) notFound();
  return { ...ctx, agent: found.agent, org: found.org };
}

/** A client org in this agency's tree, or 404. */
export async function studioClient(slug: string, clientId: string, min: Role = "member") {
  const ctx = await studio(slug, min);
  const org = (await agencyOrgs(ctx.agency.id)).find((o) => o.id === clientId);
  if (!org) notFound();
  return { ...ctx, client: org };
}

export function fail(err: unknown, fallback = "Something went wrong. Try again."): { ok: false; error: string } {
  if (err && typeof err === "object" && "digest" in err && typeof (err as { digest?: unknown }).digest === "string") {
    const d = (err as { digest: string }).digest;
    if (d.startsWith("NEXT_REDIRECT") || d.startsWith("NEXT_HTTP_ERROR_FALLBACK") || d === "NEXT_NOT_FOUND") throw err;
  }
  const msg = err instanceof Error && err.message && err.message !== "not implemented" ? err.message : fallback;
  return { ok: false, error: msg.length > 160 ? fallback : msg };
}

async function uniqueSlug(base: string) {
  const root = slugify(base) || "client";
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    const rows = await db().select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.slug, slug)).limit(1);
    if (!rows[0]) return slug;
  }
  return `${root}-${randomUUID().slice(0, 6)}`;
}

export async function insertClientOrg(agencyId: string, input: { name: string; industry?: string; website?: string; timezone?: string }) {
  const slug = await uniqueSlug(input.name);
  let timezone = input.timezone || null;
  if (!timezone) {
    const [agency] = await db().select({ timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, agencyId)).limit(1);
    timezone = agency?.timezone ?? null;
  }
  const [org] = await db()
    .insert(schema.organizations)
    .values({
      kind: "client",
      parentId: agencyId,
      agencyId,
      name: input.name,
      slug,
      industry: input.industry || null,
      website: input.website || null,
      branding: { displayName: input.name },
      ...(timezone ? { timezone } : {}),
    })
    .returning();
  return org!;
}

