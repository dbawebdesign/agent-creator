/** Tool registry. Tool ids here are what AgentSpec.tools / agents.config.tools reference. */
import { computerProvider } from "@/server/computer";
import { createDeliverable, knowledgeSearch, memoryRecall, memorySave, requestApproval, scheduleFollowup, sendMessage } from "./core";
import type { AgentRow, ToolDef } from "./types";
import { computerBash, computerClick, computerKey, computerScreenshot, computerType, httpFetch } from "./web-computer";

export const TOOLS: Record<string, ToolDef> = Object.fromEntries(
  [
    knowledgeSearch,
    memoryRecall,
    memorySave,
    createDeliverable,
    sendMessage,
    requestApproval,
    scheduleFollowup,
    httpFetch,
    computerScreenshot,
    computerClick,
    computerType,
    computerKey,
    computerBash,
  ].map((t) => [t.name, t as unknown as ToolDef]),
);

/** Always available to every agent. */
export const CORE_TOOLS = ["knowledge_search", "memory_recall", "memory_save", "create_deliverable", "send_message", "request_approval", "schedule_followup"];

/** Tools an agent may use in a run: core + configured, computer tools only with a ready computer. */
export function toolsForAgent(agent: AgentRow): ToolDef[] {
  const wanted = new Set([...CORE_TOOLS, ...(agent.config.tools ?? [])]);
  const hasComputer = Boolean(agent.computerId) && agent.computerStatus === "ready" && computerProvider().configured;
  return [...wanted]
    .filter((n) => TOOLS[n])
    .filter((n) => !n.startsWith("computer_") || hasComputer)
    .sort()
    .map((n) => TOOLS[n]!);
}

export type { ToolContext, ToolDef, ToolOutput } from "./types";
