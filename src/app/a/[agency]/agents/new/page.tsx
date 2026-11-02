import type { Metadata } from "next";
import { and, asc, eq } from "drizzle-orm";
import type { AgentSpec } from "@/server/agents/spec";
import { agentSpec } from "@/server/agents/spec";
import { requireOrg } from "@/server/auth/access";
import { db, schema } from "@/server/db/client";
import { agencyOrgs, getDiscovery } from "@/server/queries/studio";
import { NewAgentFlow } from "@/components/studio/new-agent/flow";
import { money } from "@/components/studio/bits";

export const metadata: Metadata = { title: "New agent" };

export default async function NewAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ agency: string }>;
  searchParams: Promise<{ client?: string; d?: string; blueprint?: string }>;
}) {
  const [{ agency: slug }, sp] = await Promise.all([params, searchParams]);
  const { org: agency } = await requireOrg(slug, "member");
  const orgs = await agencyOrgs(agency.id);
  const clients = orgs.filter((o) => o.kind === "client").map((o) => ({ id: o.id, name: o.name, slug: o.slug }));

  let resume: { discoveryId: string; clientId: string; clientName: string; transcript: string } | null = null;
  if (sp.d) {
    const row = await getDiscovery(agency.id, sp.d);
    if (row) resume = { discoveryId: row.d.id, clientId: row.d.orgId, clientName: row.orgName, transcript: row.d.transcript };
  }

  let blueprint: { id: string; name: string; spec: AgentSpec } | null = null;
  if (sp.blueprint && /^[0-9a-f-]{36}$/i.test(sp.blueprint)) {
    const [bp] = await db().select().from(schema.blueprints).where(and(eq(schema.blueprints.id, sp.blueprint), eq(schema.blueprints.orgId, agency.id))).limit(1);
    const parsed = bp ? agentSpec.safeParse(bp.spec) : null;
    if (bp && parsed?.success) blueprint = { id: bp.id, name: bp.name, spec: parsed.data };
  }

  const [plan] = await db()
    .select({ priceCents: schema.plans.priceCents })
    .from(schema.plans)
    .where(and(eq(schema.plans.orgId, agency.id), eq(schema.plans.active, true)))
    .orderBy(asc(schema.plans.createdAt))
    .limit(1);

  const initialClientId = sp.client ? clients.find((c) => c.slug === sp.client)?.id : undefined;

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <NewAgentFlow
        key={resume?.discoveryId ?? blueprint?.id ?? "new"}
        agency={slug}
        clients={clients}
        initialClientId={initialClientId}
        resume={resume}
        blueprint={blueprint}
        priceLabel={plan ? `${money(plan.priceCents)} / mo flat` : null}
      />
    </div>
  );
}
