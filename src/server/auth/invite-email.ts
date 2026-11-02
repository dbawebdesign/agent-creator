/**
 * Invitation email, shared by the Studio (agency → client owner) and the Portal (client → teammate/customer).
 * Sent in the inviting org's brand. The link alone grants nothing: accepting needs a verified account.
 */
import "server-only";
import { env } from "@/server/env";
import { randomToken, sha256 } from "@/server/security/crypto";

export type InviteEmailResult = { sent: boolean; simulated: boolean };

/**
 * Email an invite link to `to`. Returns `{ sent: false, simulated: true }` when no email provider is configured
 * (dev/test), and throws on a provider error so callers can decide how to surface it.
 */
export async function emailInvite(orgId: string, to: string, url: string, opts: { expiresInDays?: number } = {}): Promise<InviteEmailResult> {
  const e = env();
  if (!e.RESEND_API_KEY) return { sent: false, simulated: true };
  const [{ orgChain }, { resolveBrand }, { formatFrom, sendEmail }] = await Promise.all([
    import("@/server/auth/access"),
    import("@/server/queries/portal"),
    import("@/server/channels/email"),
  ]);
  const chain = await orgChain(orgId);
  const org = chain[0];
  if (!org) return { sent: false, simulated: false };
  const brand = resolveBrand(chain);
  const days = opts.expiresInDays ?? 14;
  const res = await sendEmail({
    from: formatFrom(brand.name, `team@${e.EMAIL_DOMAIN}`),
    to: [to],
    subject: `You're invited to ${org.name}`,
    text: `You've been invited to join ${org.name} on ${brand.name}.\n\nAccept the invitation:\n${url}\n\nThe link works once and expires in ${days} days. If you weren't expecting this, you can ignore it.`,
    messageId: `<invite-${randomToken(12)}@${e.EMAIL_DOMAIN}>`,
    idempotencyKey: `invite:${sha256(url)}`,
  });
  return { sent: !res.simulated, simulated: res.simulated };
}
