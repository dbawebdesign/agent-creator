"use server";

/**
 * Server actions for turning channels on from the UI (Studio settings, Portal connect page).
 * Each checks the caller's session and requires admin on the org; no access → "Not found".
 *
 *   import { connectSmsAction, disconnectChannelAction } from "@/server/channels/actions";
 */
import { headers } from "next/headers";
import { z } from "zod";
import { hasRole, resolveAccess } from "@/server/auth/access";
import { clientIp, getCurrentUser } from "@/server/auth/session";
import { logger } from "@/server/lib/logger";
import { ChannelError, connectSmsNumber, disconnectChannel } from "./service";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function adminActor(orgId: string): Promise<{ userId: string; ip: string | null } | null> {
  if (!z.uuid().safeParse(orgId).success) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  const access = await resolveAccess(user, orgId);
  if (!access || !hasRole(access, "admin")) return null;
  return { userId: user.id, ip: clientIp(await headers()) };
}

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof ChannelError) return { ok: false, error: err.message };
  logger.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, "channel action failed");
  return { ok: false, error: "Something went wrong. Try again." };
}

const smsInput = z.object({ orgId: z.uuid(), agentId: z.uuid(), phone: z.string().trim().min(1).max(40) });

/** Give an agent a text-message number (E.164). The number must be on the Twilio account; one agent per number. */
export async function connectSmsAction(input: { orgId: string; agentId: string; phone: string }): Promise<ActionResult<{ phone: string; connectionId: string }>> {
  const parsed = smsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter the number in international format, like +14155550123." };
  const actor = await adminActor(parsed.data.orgId);
  if (!actor) return { ok: false, error: "Not found" };
  try {
    const res = await connectSmsNumber(parsed.data.orgId, parsed.data.agentId, parsed.data.phone, actor);
    return { ok: true, ...res };
  } catch (err) {
    return fail(err);
  }
}

/** Remove a channel connection (SMS number, Slack workspace). */
export async function disconnectChannelAction(input: { orgId: string; connectionId: string }): Promise<ActionResult> {
  const parsed = z.object({ orgId: z.uuid(), connectionId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Not found" };
  const actor = await adminActor(parsed.data.orgId);
  if (!actor) return { ok: false, error: "Not found" };
  try {
    await disconnectChannel(parsed.data.orgId, parsed.data.connectionId, actor);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
