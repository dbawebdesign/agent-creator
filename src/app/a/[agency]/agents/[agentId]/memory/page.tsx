import { notFound } from "next/navigation";
import { Brain } from "lucide-react";
import { hasRole, requireOrg } from "@/server/auth/access";
import { agentMemories, getAgent } from "@/server/queries/studio";
import { EmptyState } from "@/components/ui/empty";
import { MemoryList } from "@/components/studio/memory-list";

export const metadata = { title: "Memory" };

export default async function MemoryPage({ params }: { params: Promise<{ agency: string; agentId: string }> }) {
  const { agency: slug, agentId } = await params;
  const access = await requireOrg(slug, "viewer");
  const found = await getAgent(access.org.id, agentId);
  if (!found) notFound();
  const memories = await agentMemories(found.agent.orgId, found.agent.id);
  return (
    <div className="max-w-[760px]">
      <p className="mb-8 text-[13.5px] text-ink-3">
        What {found.agent.name} has learned about {found.org.name} — from the discovery call, feedback on deliverables and conversations. Recalled by relevance on every run.
      </p>
      {memories.length ? (
        <MemoryList agency={slug} agentId={found.agent.id} memories={memories} canEdit={hasRole(access, "member")} />
      ) : (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState icon={<Brain />} title="Nothing remembered yet" body="Memories are written as the agent works and as the client gives feedback." />
        </div>
      )}
    </div>
  );
}
