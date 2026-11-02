import { notFound } from "next/navigation";
import { Hash, MessageSquare } from "lucide-react";
import { hasRole, requireOrg } from "@/server/auth/access";
import { getAgent } from "@/server/queries/studio";
import { getChannelOverview } from "@/server/channels/service";
import { AgentSettings } from "@/components/studio/agent-settings";
import { SmsConnect } from "@/components/shared/sms-connect";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Agent settings" };

export default async function AgentSettingsPage({ params }: { params: Promise<{ agency: string; agentId: string }> }) {
  const { agency: slug, agentId } = await params;
  const access = await requireOrg(slug, "viewer");
  const found = await getAgent(access.org.id, agentId);
  if (!found) notFound();
  const a = found.agent;
  if (!hasRole(access, "member")) return <p className="text-[13.5px] text-ink-3">You have view-only access to this agent.</p>;
  const canAdmin = hasRole(access, "admin");
  // Authorized above: the agent belongs to this agency's tree.
  const overview = await getChannelOverview(a.orgId);
  const ch = overview.agents.find((x) => x.agentId === a.id);
  const slack = ch?.slack.connected
    ? { tone: "good" as const, label: ch.slack.teamName ? `Connected · ${ch.slack.teamName}` : "Connected" }
    : overview.slack
      ? { tone: "neutral" as const, label: `Workspace connected${overview.slack.teamName ? ` · ${overview.slack.teamName}` : ""}` }
      : overview.providers.slack
        ? { tone: "neutral" as const, label: "Not connected" }
        : { tone: "neutral" as const, label: "Not set up on this server" };

  return (
    <div className="space-y-12">
      <AgentSettings
        agency={slug}
        canAdmin={canAdmin}
        agent={{ id: a.id, name: a.name, role: a.role, summary: a.summary, instructions: a.instructions, status: a.status, config: { voice: a.config.voice, requireApprovalFor: a.config.requireApprovalFor } }}
      />

      <section aria-labelledby="channels-h" className="max-w-[640px]">
        <h2 id="channels-h" className="text-[14px] font-semibold text-ink">
          Channels
        </h2>
        <p className="mt-0.5 mb-4 text-[12.5px] text-ink-3">How {found.org.name}’s team reaches {a.name} besides the portal and email.</p>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface shadow-xs">
          <div className="px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
              <MessageSquare className="size-4 text-ink-3" aria-hidden />
              <span className="text-[13.5px] font-medium text-ink">Text messages</span>
              {!overview.providers.sms ? <span className="ml-auto text-[12px] text-ink-3">Texts are simulated until Twilio is configured</span> : null}
            </div>
            {canAdmin ? (
              <SmsConnect orgId={a.orgId} agentId={a.id} phone={ch?.sms.phone ?? null} connectionId={ch?.sms.connectionId ?? null} live={overview.providers.sms} />
            ) : (
              <p className="text-[13px] text-ink-3">{ch?.sms.phone ?? "No number yet."} An admin can change this.</p>
            )}
          </div>
          <div className="flex items-center gap-2 px-4 py-4">
            <Hash className="size-4 text-ink-3" aria-hidden />
            <span className="text-[13.5px] font-medium text-ink">Slack</span>
            <Badge tone={slack.tone} className="ml-auto">
              {slack.label}
            </Badge>
          </div>
        </div>
      </section>
    </div>
  );
}
