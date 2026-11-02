import "server-only";
import { providerStatus } from "@/server/channels/service";
import type { ChannelKind } from "@/server/db/schema";

/**
 * Channels whose outbound sends are simulated in this environment (no provider configured), so the portal
 * says "Email (test mode)" instead of claiming something was emailed. Mirrors the channel senders, which
 * simulate exactly when their provider credentials are missing.
 */
export function testModeChannels(): ChannelKind[] {
  const p = providerStatus();
  const out: ChannelKind[] = [];
  if (!p.email) out.push("email");
  if (!p.sms) out.push("sms");
  if (!p.slack) out.push("slack");
  return out;
}
