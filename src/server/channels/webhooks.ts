/**
 * Idempotent webhook intake: one row per (provider, external id) and exactly one inbound.process job,
 * written in the same transaction so a crash can never record an event without queueing its processing.
 */
import "server-only";
import { eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { db, schema } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";

export type Provider = "resend" | "twilio" | "slack";

export async function recordWebhookEvent(
  provider: Provider,
  externalId: string,
  payload: Record<string, unknown>,
  opts: { enqueue?: boolean } = {},
): Promise<{ id: string | null; duplicate: boolean }> {
  return db().transaction(async (tx) => {
    const rows = await tx
      .insert(schema.webhookEvents)
      .values({ provider, externalId: externalId.slice(0, 300), payload })
      .onConflictDoNothing()
      .returning({ id: schema.webhookEvents.id });
    const id = rows[0]?.id ?? null;
    if (!id) return { id: null, duplicate: true };
    if (opts.enqueue !== false) {
      await enqueue(
        tx as unknown as DB,
        "inbound.process",
        { provider, webhookEventId: id },
        { idempotencyKey: `inbound:${provider}:${id}`, priority: 5, maxAttempts: 8 },
      );
    } else {
      await tx
        .update(schema.webhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(schema.webhookEvents.id, id));
    }
    return { id, duplicate: false };
  });
}
