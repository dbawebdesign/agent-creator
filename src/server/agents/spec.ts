/**
 * AgentSpec: the contract between the Architect (transcript → proposal), the
 * provisioner (proposal → live agent), blueprints (reusable specs), and the UI.
 */
import { z } from "zod";

export const channelKind = z.enum(["email", "sms", "slack", "api", "mcp", "portal"]);

export const workflowSpec = z.object({
  name: z.string().min(2).max(80),
  /** The "itch": what the business owner does by hand today. */
  problem: z.string().max(600).default(""),
  /** Step-by-step procedure the agent follows. */
  instructions: z.string().min(10).max(6000),
  trigger: z.discriminatedUnion("type", [
    z.object({ type: z.literal("schedule"), cron: z.string().min(9).max(64), label: z.string().max(80).optional() }),
    z.object({
      type: z.literal("event"),
      event: z.enum(["email.received", "sms.received", "slack.message", "webhook", "deliverable.approved"]),
    }),
    z.object({ type: z.literal("manual") }),
  ]),
  outputKind: z.enum(["report", "document", "table", "email_draft", "message", "action"]).default("report"),
  deliverTo: z.array(channelKind).min(1).default(["portal"]),
  hoursSavedPerRun: z.number().min(0).max(200).default(1),
  /** Tools this workflow needs (ids from the tool registry). */
  tools: z.array(z.string()).default([]),
});

export const agentSpec = z.object({
  name: z.string().min(1).max(40),
  role: z.string().min(2).max(80),
  summary: z.string().max(280),
  /** Industry / vertical, e.g. "Promotional products distribution". */
  vertical: z.string().max(80).default(""),
  instructions: z.string().min(20).max(12000),
  voice: z.string().max(400).default("Warm, concise, and specific. Leads with the result."),
  workflows: z.array(workflowSpec).min(1).max(12),
  /** Knowledge the agent needs: documents/links to request from the client. */
  knowledgeNeeds: z.array(z.object({ title: z.string().max(120), why: z.string().max(300) })).max(20).default([]),
  /** Facts learned in discovery to seed long-term memory. */
  seedMemories: z.array(z.string().max(500)).max(40).default([]),
  channels: z.array(channelKind).min(1).default(["portal", "email"]),
  tools: z.array(z.string()).default([]),
  requireApprovalFor: z.array(z.string()).default(["send_external_email"]),
  /** The proactive "wow" delivered after the first night. */
  firstDeliverable: z.object({
    title: z.string().max(120),
    description: z.string().max(600),
    instructions: z.string().max(4000),
  }),
  /** Packaging ideas: how the client could resell this agent to their own customers (B2B2B). */
  resaleIdea: z.string().max(600).default(""),
  /** Estimated weekly hours saved across workflows. */
  weeklyHoursSaved: z.number().min(0).max(400).default(0),
  /** Open questions the agency should confirm with the client. */
  openQuestions: z.array(z.string().max(300)).max(10).default([]),
});

export type AgentSpec = z.infer<typeof agentSpec>;
export type WorkflowSpec = z.infer<typeof workflowSpec>;
