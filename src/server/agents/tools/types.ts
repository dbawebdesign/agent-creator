import { z } from "zod";
import type { DB } from "@/server/db/client";
import type { schema } from "@/server/db/client";
import type { LlmToolDef } from "@/server/llm/types";

export type AgentRow = typeof schema.agents.$inferSelect;
export type OrgRow = typeof schema.organizations.$inferSelect;
export type WorkflowRow = typeof schema.workflows.$inferSelect;
export type RunRow = typeof schema.runs.$inferSelect;

export type ToolContext = {
  db: DB;
  run: RunRow;
  agent: AgentRow;
  org: OrgRow;
  workflow: WorkflowRow | null;
  toolUseId: string;
  /** Mutable per-run state shared across tool calls. */
  state: { deliverableIds: string[]; followups: number; messagesSent: number };
};

export type ToolOutput = {
  /** Text (often JSON) returned to the model as the tool_result. */
  content: string;
  isError?: boolean;
};

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  /**
   * If this particular call is a gated action, return its action id (e.g. "send_external_email").
   * When the id is in agent.config.requireApprovalFor the runtime pauses the run for a human instead of running it.
   */
  approvalAction?: (input: z.infer<S>, ctx: ToolContext) => Promise<string | null> | string | null;
  /** Human-readable description shown on the approval card. */
  describe?: (input: z.infer<S>) => string;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
};

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function toLlmTool(def: ToolDef): LlmToolDef {
  const json = z.toJSONSchema(def.schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return { name: def.name, description: def.description, input_schema: { ...json, type: "object" } };
}

export function ok(value: unknown): ToolOutput {
  return { content: typeof value === "string" ? value : JSON.stringify(value) };
}

export function toolError(message: string): ToolOutput {
  return { content: JSON.stringify({ error: message }), isError: true };
}
