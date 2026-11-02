/**
 * Channel service functions for the Studio/Portal UI.
 *
 * Callers MUST authorize `orgId` first (requireOrg(slug, "admin") for mutations, "viewer" for reads);
 * every query here is additionally scoped by `orgId`.
 */
import "server-only";
import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { audit } from "@/server/security/audit";
import { mcpConfigSnippet, type McpSnippets } from "@/server/api/mcp-config";
import { normalizeE164 } from "./sms";

export { mcpConfigSnippet, type McpSnippets };

export type ProviderStatus = {
  /** false = outbound email is simulated (RESEND_API_KEY unset). */
  email: boolean;
  /** false = inbound email webhooks will be rejected (RESEND_WEBHOOK_SECRET unset). */
  emailInbound: boolean;
  sms: boolean;
  slack: boolean;
};

export type AgentChannels = {
  agentId: string;
  name: string;
  role: string;
  status: string;
  email: { address: string | null; live: boolean };
  sms: { phone: string | null; connectionId: string | null; live: boolean };
  slack: { connected: boolean; teamName: string | null; connectionId: string | null };
  api: { available: boolean; keyCount: number };
  mcp: { available: boolean; url: string };
};

export type ChannelOverview = {
  emailDomain: string;
  apiBaseUrl: string;
  mcpUrl: string;
  openapiUrl: string;
  providers: ProviderStatus;
  slack: { connectionId: string; teamId: string | null; teamName: string | null; status: string; defaultChannel: string | null; agentId: string | null } | null;
  agents: AgentChannels[];
};

export class ChannelError extends Error {
  constructor(
    public code: "not_found" | "invalid_input" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

function base(): string {
  return env().APP_URL.replace(/\/+$/, "");
}

export function providerStatus(): ProviderStatus {
  const e = env();
  return {
    email: !!e.RESEND_API_KEY,
    emailInbound: !!e.RESEND_WEBHOOK_SECRET,
    sms: !!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_MESSAGING_SERVICE_SID),
    slack: !!(e.SLACK_CLIENT_ID && e.SLACK_CLIENT_SECRET && e.SLACK_SIGNING_SECRET),
  };
}

export async function getChannelOverview(orgId: string): Promise<ChannelOverview> {
  const database = db();
  const [agents, connections, keys] = await Promise.all([
    database
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), ne(schema.agents.status, "archived")))
      .orderBy(schema.agents.createdAt),
    database.select().from(schema.channelConnections).where(eq(schema.channelConnections.orgId, orgId)),
    database
      .select({ agentId: schema.apiKeys.agentId, n: count() })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.orgId, orgId), isNull(schema.apiKeys.revokedAt)))
      .groupBy(schema.apiKeys.agentId),
  ]);
  const providers = providerStatus();
  const domain = env().EMAIL_DOMAIN;
  const slackConn = connections.find((c) => c.kind === "slack" && c.status !== "disabled") ?? null;
  const orgWideKeys = keys.find((k) => k.agentId === null)?.n ?? 0;
  const mcpUrl = `${base()}/api/mcp`;

  return {
    emailDomain: domain,
    apiBaseUrl: `${base()}/api/v1`,
    mcpUrl,
    openapiUrl: `${base()}/api/v1/openapi.json`,
    providers,
    slack: slackConn
      ? {
          connectionId: slackConn.id,
          teamId: slackConn.externalId,
          teamName: typeof slackConn.config.teamName === "string" ? slackConn.config.teamName : null,
          status: slackConn.status,
          defaultChannel: typeof slackConn.config.defaultChannelName === "string" ? slackConn.config.defaultChannelName : null,
          agentId: slackConn.agentId,
        }
      : null,
    agents: agents.map((a) => {
      const sms = connections.find((c) => c.kind === "sms" && c.agentId === a.id && c.status === "connected");
      const slackForAgent = slackConn && (!slackConn.agentId || slackConn.agentId === a.id) && slackConn.status === "connected";
      const keyCount = orgWideKeys + (keys.find((k) => k.agentId === a.id)?.n ?? 0);
      return {
        agentId: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        email: { address: a.emailHandle ? `${a.emailHandle}@${domain}` : null, live: providers.email && !!a.emailHandle },
        sms: { phone: a.phoneNumber ?? (sms?.externalId ?? null), connectionId: sms?.id ?? null, live: providers.sms && !!(a.phoneNumber || sms) },
        slack: {
          connected: !!slackForAgent,
          teamName: slackForAgent && typeof slackConn.config.teamName === "string" ? slackConn.config.teamName : null,
          connectionId: slackForAgent ? slackConn.id : null,
        },
        api: { available: a.status === "active", keyCount },
        mcp: { available: a.status === "active", url: mcpUrl },
      };
    }),
  };
}

/** URL the "Add to Slack" button should link to (the route checks the signed-in user is an org admin). */
export function slackInstallUrl(orgId: string, returnTo?: string): string {
  const u = new URL(`${base()}/api/slack/install`);
  u.searchParams.set("org", orgId);
  if (returnTo) u.searchParams.set("returnTo", returnTo);
  return u.toString();
}

/** Give an agent an SMS number (E.164). The number must already be in the Twilio Messaging Service. */
export async function connectSmsNumber(
  orgId: string,
  agentId: string,
  e164: string,
  actor?: { userId?: string | null; ip?: string | null },
): Promise<{ connectionId: string; phone: string }> {
  const phone = normalizeE164(e164);
  if (!phone) throw new ChannelError("invalid_input", "Enter the number in international format, like +14155550123.");
  const database = db();
  const connectionId = await database.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: schema.agents.id, phoneNumber: schema.agents.phoneNumber })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)))
      .limit(1);
    if (!agent) throw new ChannelError("not_found", "Agent not found.");
    const [takenByAgent] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.phoneNumber, phone), ne(schema.agents.id, agentId)))
      .limit(1);
    const [conn] = await tx
      .select()
      .from(schema.channelConnections)
      .where(and(eq(schema.channelConnections.kind, "sms"), eq(schema.channelConnections.externalId, phone)))
      .limit(1);
    if (takenByAgent || (conn && (conn.orgId !== orgId || (conn.agentId && conn.agentId !== agentId)))) {
      throw new ChannelError("conflict", "That number is already connected to another agent.");
    }
    // One SMS number per agent: release any previous one.
    const prev = await tx
      .select({ id: schema.channelConnections.id })
      .from(schema.channelConnections)
      .where(and(eq(schema.channelConnections.orgId, orgId), eq(schema.channelConnections.agentId, agentId), eq(schema.channelConnections.kind, "sms"), ne(schema.channelConnections.externalId, phone)));
    if (prev.length) await tx.delete(schema.channelConnections).where(inArray(schema.channelConnections.id, prev.map((p) => p.id)));
    await tx.update(schema.agents).set({ phoneNumber: phone }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)));
    if (conn) {
      await tx.update(schema.channelConnections).set({ agentId, status: "connected", lastError: null }).where(eq(schema.channelConnections.id, conn.id));
      return conn.id;
    }
    const [row] = await tx
      .insert(schema.channelConnections)
      .values({ orgId, agentId, kind: "sms", externalId: phone, status: "connected", config: {} })
      .returning({ id: schema.channelConnections.id });
    return row!.id;
  });
  await audit({
    orgId,
    actorType: actor?.userId ? "user" : "system",
    actorId: actor?.userId ?? null,
    action: "channel.sms.connected",
    targetType: "channel_connection",
    targetId: connectionId,
    metadata: { agentId, phone },
    ip: actor?.ip ?? null,
  });
  return { connectionId, phone };
}

/** Remove a channel connection (Slack: also deletes the stored bot token; SMS: frees the number). */
export async function disconnectChannel(orgId: string, connectionId: string, actor?: { userId?: string | null; ip?: string | null }): Promise<void> {
  const database = db();
  const [conn] = await database
    .select()
    .from(schema.channelConnections)
    .where(and(eq(schema.channelConnections.id, connectionId), eq(schema.channelConnections.orgId, orgId)))
    .limit(1);
  if (!conn) throw new ChannelError("not_found", "Connection not found.");
  await database.transaction(async (tx) => {
    if (conn.secretId) {
      await tx.delete(schema.secrets).where(and(eq(schema.secrets.id, conn.secretId), eq(schema.secrets.orgId, orgId)));
    }
    if (conn.kind === "sms" && conn.agentId && conn.externalId) {
      await tx
        .update(schema.agents)
        .set({ phoneNumber: null })
        .where(and(eq(schema.agents.id, conn.agentId), eq(schema.agents.orgId, orgId), eq(schema.agents.phoneNumber, conn.externalId)));
    }
    await tx.delete(schema.channelConnections).where(and(eq(schema.channelConnections.id, conn.id), eq(schema.channelConnections.orgId, orgId)));
  });
  await audit({
    orgId,
    actorType: actor?.userId ? "user" : "system",
    actorId: actor?.userId ?? null,
    action: `channel.${conn.kind}.disconnected`,
    targetType: "channel_connection",
    targetId: conn.id,
    metadata: { externalId: conn.externalId },
    ip: actor?.ip ?? null,
  });
}

/** Choose which agent answers in Slack (null = the org's first active agent). */
export async function setSlackAgent(orgId: string, connectionId: string, agentId: string | null): Promise<void> {
  const database = db();
  if (agentId) {
    const [a] = await database.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId))).limit(1);
    if (!a) throw new ChannelError("not_found", "Agent not found.");
  }
  const res = await database
    .update(schema.channelConnections)
    .set({ agentId })
    .where(and(eq(schema.channelConnections.id, connectionId), eq(schema.channelConnections.orgId, orgId), eq(schema.channelConnections.kind, "slack")))
    .returning({ id: schema.channelConnections.id });
  if (!res.length) throw new ChannelError("not_found", "Connection not found.");
}
