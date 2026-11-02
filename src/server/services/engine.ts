/**
 * Engine service contract — the ONLY entry points UI/API code should call for agent work.
 * Owner: engine slice. UI slices import from here; do not reach into engine internals.
 *
 * All functions take an explicit `orgId` (already authorized by the caller via requireOrg/requireOrgById
 * or API-key auth) and must scope every query by it.
 */
import "server-only";
import type { AgentSpec } from "@/server/agents/spec";

export type Actor = { type: "user"; userId: string } | { type: "api_key"; keyId: string } | { type: "system" };

/** Create a discovery from a call transcript and queue the Architect. Returns the discovery id. */
export async function createDiscovery(_input: {
  orgId: string; // the CLIENT org the agent will work for
  title: string;
  transcript: string;
  actor: Actor;
}): Promise<{ discoveryId: string }> {
  throw new Error("not implemented");
}

/** Run the Architect synchronously (used by the worker job and by tests). Stores the proposal. */
export async function analyzeDiscovery(_discoveryId: string): Promise<AgentSpec> {
  throw new Error("not implemented");
}

/** Provision a live agent from a (possibly edited) proposal: agent, workflows, memories, KB, inbox, first deliverable. */
export async function hireAgent(_input: {
  orgId: string;
  spec: AgentSpec;
  discoveryId?: string;
  blueprintId?: string;
  actor: Actor;
}): Promise<{ agentId: string }> {
  throw new Error("not implemented");
}

/** Queue a workflow run now. */
export async function runWorkflowNow(_input: { orgId: string; workflowId: string; actor: Actor }): Promise<{ runId: string }> {
  throw new Error("not implemented");
}

/**
 * Send a message/request to an agent from the portal, API or MCP. Creates/continues a conversation and
 * queues a run. With `wait`, executes inline (bounded) and returns the reply — used by API/MCP sync calls.
 */
export async function messageAgent(_input: {
  orgId: string;
  agentId: string;
  text: string;
  conversationId?: string;
  channel: "portal" | "api" | "mcp";
  actor: Actor;
  wait?: boolean;
}): Promise<{ conversationId: string; runId: string; reply?: string }> {
  throw new Error("not implemented");
}

/** Approve or reject a pending approval; approved actions are executed by the worker. */
export async function decideApproval(_input: {
  orgId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  actor: Actor;
}): Promise<void> {
  throw new Error("not implemented");
}

/** Mark a deliverable seen/approved/changes requested (feedback is written to agent memory). */
export async function reviewDeliverable(_input: {
  orgId: string;
  deliverableId: string;
  action: "seen" | "approve" | "request_changes" | "archive";
  feedback?: string;
  actor: Actor;
}): Promise<void> {
  throw new Error("not implemented");
}

/** Add a knowledge source (text or URL) and queue indexing. */
export async function addKnowledge(_input: {
  orgId: string;
  agentId?: string | null;
  title: string;
  kind: "text" | "url";
  content?: string;
  url?: string;
  actor: Actor;
}): Promise<{ sourceId: string }> {
  throw new Error("not implemented");
}

/** Pause/resume/archive an agent. */
export async function setAgentStatus(_input: { orgId: string; agentId: string; status: "active" | "paused" | "archived"; actor: Actor }): Promise<void> {
  throw new Error("not implemented");
}

/** Save an agent as a reusable blueprint at the agency level. */
export async function saveBlueprint(_input: { agencyId: string; agentId: string; name?: string; actor: Actor }): Promise<{ blueprintId: string }> {
  throw new Error("not implemented");
}

/**
 * B2B2B: clone an agent from a client org into one of its customer orgs (resale).
 * Copies spec, workflows and shared knowledge; memories and conversations are NOT copied.
 */
export async function resellAgent(_input: { orgId: string; agentId: string; customerOrgId: string; actor: Actor }): Promise<{ agentId: string }> {
  throw new Error("not implemented");
}
