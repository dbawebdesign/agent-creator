import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/server/auth/access";
import { getAgent } from "@/server/queries/studio";
import { AgentSettings } from "@/components/studio/agent-settings";

export const metadata = { title: "Agent settings" };

export default async function AgentSettingsPage({ params }: { params: Promise<{ agency: string; agentId: string }> }) {
  const { agency: slug, agentId } = await params;
  const access = await requireOrg(slug, "viewer");
  const found = await getAgent(access.org.id, agentId);
  if (!found) notFound();
  const a = found.agent;
  if (!hasRole(access, "member")) return <p className="text-[13.5px] text-ink-3">You have view-only access to this agent.</p>;
  return (
    <AgentSettings
      agency={slug}
      canAdmin={hasRole(access, "admin")}
      agent={{ id: a.id, name: a.name, role: a.role, summary: a.summary, instructions: a.instructions, status: a.status, config: { voice: a.config.voice, requireApprovalFor: a.config.requireApprovalFor } }}
    />
  );
}
