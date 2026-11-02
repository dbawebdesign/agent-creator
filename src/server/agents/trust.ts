/**
 * Sender trust for agent runs.
 *
 * A run started by a message is trusted only when the sender is verifiably part of the business: a platform user
 * who is a member of the run's org or one of its ancestors (the client's agency), an API key / system actor, or —
 * on email, SMS and Slack — a contact linked to such a user *and* the channel vouched for the sender
 * (meta.senderAuth === "pass"). Everyone else is untrusted: their text is fenced as external input, the agent
 * gets read-only tools, memories stay out of the prompt, and the reply is held for approval (see runtime.ts).
 *
 * Also resolves the conversation's participant, so sends can be classified as "back to the person in this
 * conversation" versus "somewhere else" (which needs approval; see tools/core.ts send_message).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import type { RunRow } from "./tools/types";

export type Participant = {
  channel: string;
  userId: string | null;
  email: string | null;
  phone: string | null;
  slackChannel: string | null;
  /** True when the participant is a verified member of the org (or an ancestor org). */
  internal: boolean;
};

export type RunTrust = {
  /** False only for message-triggered runs whose sender could not be verified as part of the business. */
  trusted: boolean;
  /** Short reason, for traces and approval cards. */
  reason: string;
  /** Display label for the sender (email, phone, Slack user or user id). */
  sender: string | null;
  /** The platform or channel vouched for who sent it (portal session, API key, senderAuth "pass"). */
  authenticated: boolean;
  /** The person on the other side of the run's conversation (null for runs without one). */
  participant: Participant | null;
};

const EXTERNAL_CHANNELS = new Set(["email", "sms", "slack"]);

export const normalizePhone = (p: string) => p.replace(/[^\d+]/g, "").replace(/^\+?1?(\d{10})$/, "+1$1");

/** Is `userId` a member of `orgId` or of any org above it (parent chain)? */
export async function isMemberOfOrgOrAncestor(database: DB, orgId: string, userId: string): Promise<boolean> {
  const r = await database.execute(sql`
    with recursive chain(id, depth) as (
      select id, 0 from organizations where id = ${orgId}::uuid
      union all
      select o.parent_id, c.depth + 1 from organizations o join chain c on o.id = c.id
      where o.parent_id is not null and c.depth < 8
    )
    select 1 from memberships m where m.user_id = ${userId}::uuid and m.org_id in (select id from chain) limit 1`);
  return r.rows.length > 0;
}

/** A member (of the org or an ancestor) whose account email is `email`. */
async function memberByEmail(database: DB, orgId: string, email: string): Promise<string | null> {
  const r = await database.execute(sql`
    with recursive chain(id, depth) as (
      select id, 0 from organizations where id = ${orgId}::uuid
      union all
      select o.parent_id, c.depth + 1 from organizations o join chain c on o.id = c.id
      where o.parent_id is not null and c.depth < 8
    )
    select u.id from users u join memberships m on m.user_id = u.id
    where lower(u.email) = lower(${email}) and m.org_id in (select id from chain) limit 1`);
  return ((r.rows[0] as { id: string } | undefined)?.id as string | undefined) ?? null;
}

async function contactIsMember(database: DB, orgId: string, contactId: string | null | undefined): Promise<boolean> {
  if (!contactId) return false;
  const c = (
    await database
      .select({ userId: schema.contacts.userId, email: schema.contacts.email })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)))
      .limit(1)
  )[0];
  if (!c) return false;
  if (c.userId && (await isMemberOfOrgOrAncestor(database, orgId, c.userId))) return true;
  return c.email ? (await memberByEmail(database, orgId, c.email)) !== null : false;
}

export async function conversationParticipant(database: DB, orgId: string, conversationId: string): Promise<Participant | null> {
  const conv = (
    await database
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, orgId)))
      .limit(1)
  )[0];
  if (!conv) return null;
  let email: string | null = null;
  let phone: string | null = null;
  let userId = conv.userId ?? null;
  let internal = false;
  if (conv.contactId) {
    const c = (
      await database
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, conv.contactId), eq(schema.contacts.orgId, orgId)))
        .limit(1)
    )[0];
    email = c?.email ?? null;
    phone = c?.phone ? normalizePhone(c.phone) : null;
    userId ??= c?.userId ?? null;
    internal = await contactIsMember(database, orgId, conv.contactId);
  }
  if (userId) {
    if (!email) {
      const u = (await database.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
      email = u?.email ?? null;
    }
    internal ||= await isMemberOfOrgOrAncestor(database, orgId, userId);
  }
  let slackChannel: string | null = null;
  if (conv.channel === "slack") {
    const last = (
      await database
        .select({ meta: schema.messages.meta })
        .from(schema.messages)
        .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.orgId, orgId), eq(schema.messages.direction, "inbound")))
        .orderBy(desc(schema.messages.createdAt))
        .limit(1)
    )[0];
    const slack = (last?.meta as { slack?: { channel?: unknown } } | undefined)?.slack;
    slackChannel = typeof slack?.channel === "string" ? slack.channel : null;
  }
  return { channel: conv.channel, userId, email: email?.toLowerCase() ?? null, phone, slackChannel, internal };
}

/** Classify the run's triggering sender. Non-message runs (schedules, manual, setup) are trusted. */
export async function runTrust(database: DB, run: RunRow): Promise<RunTrust> {
  const participant = run.conversationId ? await conversationParticipant(database, run.orgId, run.conversationId) : null;
  if (run.input?.kind !== "message") return { trusted: true, reason: "not message-triggered", sender: null, authenticated: true, participant };

  const messageId = typeof run.input.messageId === "string" ? run.input.messageId : null;
  const msg = messageId
    ? (
        await database
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.id, messageId), eq(schema.messages.orgId, run.orgId)))
          .limit(1)
      )[0]
    : undefined;
  if (!msg) return { trusted: false, reason: "triggering message not found", sender: null, authenticated: false, participant };
  const meta = (msg.meta ?? {}) as Record<string, unknown>;
  const conv = run.conversationId
    ? (await database.select().from(schema.conversations).where(and(eq(schema.conversations.id, run.conversationId), eq(schema.conversations.orgId, run.orgId))).limit(1))[0]
    : undefined;
  const channel = typeof meta.channel === "string" ? meta.channel : (conv?.channel ?? "portal");

  // Portal / API / MCP: the platform authenticated the caller.
  if (!EXTERNAL_CHANNELS.has(channel)) {
    if (msg.author === "system") return { trusted: true, reason: "system", sender: "system", authenticated: true, participant };
    if (typeof meta.apiKeyId === "string") return { trusted: true, reason: "org API key", sender: `api key ${meta.apiKeyId}`, authenticated: true, participant };
    const userId = typeof meta.userId === "string" ? meta.userId : (conv?.userId ?? null);
    if (userId && (await isMemberOfOrgOrAncestor(database, run.orgId, userId))) return { trusted: true, reason: "org member", sender: userId, authenticated: true, participant };
    return { trusted: false, reason: "sender is not a member of this business", sender: userId, authenticated: Boolean(userId), participant };
  }

  // Email / SMS / Slack: the channel must vouch for the sender, and the sender must be linked to a member.
  const sender =
    (typeof meta.from === "string" && meta.from) ||
    participant?.email ||
    participant?.phone ||
    ((meta.slack as { user?: unknown } | undefined)?.user as string | undefined) ||
    null;
  const auth = meta.senderAuthFailed === true ? "fail" : typeof meta.senderAuth === "string" ? meta.senderAuth : "none";
  if (auth !== "pass") return { trusted: false, reason: auth === "fail" ? "sender authentication failed" : "sender not authenticated by the channel", sender, authenticated: false, participant };
  // channels sets meta.senderUserId only when senderAuth is "pass" and the contact is linked to a platform user.
  if (typeof meta.senderUserId === "string" && (await isMemberOfOrgOrAncestor(database, run.orgId, meta.senderUserId))) {
    return { trusted: true, reason: "verified member", sender, authenticated: true, participant };
  }
  const contactId = typeof meta.contactId === "string" ? meta.contactId : (conv?.contactId ?? null);
  if (await contactIsMember(database, run.orgId, contactId)) return { trusted: true, reason: "verified member", sender, authenticated: true, participant };
  return { trusted: false, reason: "sender is not a member of this business", sender, authenticated: true, participant };
}
