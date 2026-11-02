/**
 * Channel job handlers (owner: channels slice). Registered by the worker's job registry.
 *
 * channel.deliver payload: { orgId, agentId, channel: ChannelKind, messageId?: string, deliverableId?: string,
 *                           conversationId?: string, to?: string, subject?: string, text: string }
 * inbound.process payload: { provider: "resend" | "twilio" | "slack", webhookEventId: string }
 */
import type { DB } from "@/server/db/client";

export type JobContext = { db: DB; jobId: string };

export async function channelDeliver(_payload: Record<string, unknown>, _ctx: JobContext): Promise<void> {
  throw new Error("channel.deliver not implemented");
}

export async function inboundProcess(_payload: Record<string, unknown>, _ctx: JobContext): Promise<void> {
  throw new Error("inbound.process not implemented");
}
