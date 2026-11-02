import "server-only";
import { db, schema } from "@/server/db/client";
import { logger } from "@/server/lib/logger";

export type AuditInput = {
  orgId?: string | null;
  actorType: "user" | "agent" | "api_key" | "system";
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
};

/** Append-only audit trail. Never throws into the caller's path. */
export async function audit(input: AuditInput) {
  try {
    await db().insert(schema.auditLogs).values({
      orgId: input.orgId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, "audit write failed");
  }
}
