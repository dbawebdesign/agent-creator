import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/server/auth/access";
import { agentWorkflows, getAgent } from "@/server/queries/studio";
import { WorkflowManager } from "@/components/studio/workflow-manager";

export const metadata = { title: "Workflows" };

export default async function WorkflowsPage({ params }: { params: Promise<{ agency: string; agentId: string }> }) {
  const { agency: slug, agentId } = await params;
  const access = await requireOrg(slug, "viewer");
  const found = await getAgent(access.org.id, agentId);
  if (!found) notFound();
  const workflows = await agentWorkflows(found.agent.orgId, found.agent.id);
  return (
    <div>
      <p className="mb-5 max-w-[60ch] text-[13.5px] text-ink-3">
        What {found.agent.name} does without being asked. Schedules run in {found.org.name}’s time zone ({found.org.timezone.replace(/_/g, " ")}).
      </p>
      <WorkflowManager
        agency={slug}
        agentId={found.agent.id}
        agentName={found.agent.name}
        workflows={workflows}
        canEdit={hasRole(access, "member") && found.agent.status !== "archived"}
        defaultDelivery={found.agent.config.defaultDelivery ?? ["portal"]}
      />
    </div>
  );
}
