import { notFound } from "next/navigation";
import { getAgentPage, getPortal } from "@/server/queries/portal";

/** Resolve the teammate before streaming starts, so a missing one answers with a real 404. */
export default async function AgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; agentId: string }>;
}) {
  const { org, agentId } = await params;
  const p = await getPortal(org);
  if (!(await getAgentPage(p.org.id, agentId, p.user.id))) notFound();
  return children;
}
