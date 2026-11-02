-- ops/scale round 1 (prod-r1 C2, H1, H2, H4, H7, M2). Runs inside the migrator's transaction.
-- Indexes on the large tables (deliverables, runs, jobs, webhook_events) and the deliverables.agency_id backfill
-- are NOT here: they run afterwards, outside any transaction, from drizzle/online/0004_ops_scale.sql
-- (CREATE INDEX CONCURRENTLY + batched backfill; see src/server/db/migrate.ts).
ALTER TABLE "agents" ADD COLUMN "last_delivered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "delivered_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "agency_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_tokens_expires_idx" ON "auth_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_custom_domain_lower_idx" ON "organizations" USING btree (lower("custom_domain")) WHERE "organizations"."custom_domain" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_blueprint_idx" ON "agents" USING btree ("blueprint_id") WHERE "agents"."blueprint_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_run_idx" ON "approvals" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_agent_idx" ON "approvals" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_org_idx" ON "workflows" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_idx" ON "conversations" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_contact_idx" ON "conversations" USING btree ("contact_id") WHERE "conversations"."contact_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_org_kind_idx" ON "notifications" USING btree ("org_id","kind");
--> statement-breakpoint
-- C2: deliverables.agency_id is set from organizations.agency_id on insert (callers never pass it).
CREATE OR REPLACE FUNCTION roster_deliverables_set_agency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agency_id IS NULL THEN
    SELECT o.agency_id INTO NEW.agency_id FROM organizations o WHERE o.id = NEW.org_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS deliverables_before_insert ON deliverables;
--> statement-breakpoint
CREATE TRIGGER deliverables_before_insert BEFORE INSERT ON deliverables
  FOR EACH ROW EXECUTE FUNCTION roster_deliverables_set_agency();
--> statement-breakpoint
-- C2: agents.delivered_count / last_delivered_at, maintained per INSERT statement (one UPDATE per agent touched,
-- so bulk inserts stay cheap). Lifetime counters: deleting a deliverable does not decrement them.
CREATE OR REPLACE FUNCTION roster_deliverables_bump_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agents a
     SET delivered_count = a.delivered_count + s.n,
         last_delivered_at = GREATEST(a.last_delivered_at, s.last_at)
    FROM (SELECT agent_id, count(*)::int AS n, max(created_at) AS last_at FROM new_rows GROUP BY agent_id) s
   WHERE a.id = s.agent_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS deliverables_after_insert ON deliverables;
--> statement-breakpoint
CREATE TRIGGER deliverables_after_insert AFTER INSERT ON deliverables
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION roster_deliverables_bump_agent();
--> statement-breakpoint
-- Backfill the agent counters (one grouped scan; the trigger above blocks concurrent inserts until commit).
UPDATE agents a SET delivered_count = s.n, last_delivered_at = s.last_at
  FROM (SELECT agent_id, count(*)::int AS n, max(created_at) AS last_at FROM deliverables GROUP BY agent_id) s
 WHERE a.id = s.agent_id;
--> statement-breakpoint
-- H7: rate_limits moves from runtime DDL into a migration (UNLOGGED: losing counters on a crash is fine).
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);
