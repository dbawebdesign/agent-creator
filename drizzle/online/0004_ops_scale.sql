-- Online steps for 0004_ops_scale. src/server/db/migrate.ts runs each statement on its own, in autocommit
-- (no transaction), after the transactional migrations, and records the file in drizzle.__roster_online_steps.
-- Every statement must be idempotent: a deploy that dies halfway reruns the whole file (invalid indexes left by an
-- interrupted CONCURRENTLY build are dropped first).
--
-- C2 backfill: deliverables.agency_id, one org per transaction (COMMIT inside a top-level DO), so row locks are short.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id, agency_id FROM organizations WHERE agency_id IS NOT NULL ORDER BY id LOOP
    UPDATE deliverables SET agency_id = o.agency_id WHERE org_id = o.id AND agency_id IS NULL;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "deliverables_org_created_id_idx" ON "deliverables" USING btree ("org_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "deliverables_agency_created_idx" ON "deliverables" USING btree ("agency_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "deliverables_agency_changes_idx" ON "deliverables" USING btree ("agency_id","created_at" DESC NULLS LAST) WHERE "deliverables"."status" = 'changes_requested';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "deliverables_review_idx" ON "deliverables" USING btree ("org_id") WHERE "deliverables"."needs_review" and "deliverables"."status" in ('new','seen');
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "deliverables_workflow_idx" ON "deliverables" USING btree ("workflow_id") WHERE "deliverables"."workflow_id" is not null;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "runs_workflow_idx" ON "runs" USING btree ("workflow_id") WHERE "runs"."workflow_id" is not null;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_created_idx" ON "webhook_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_claim_idx" ON "jobs" USING btree ("queue","priority" DESC NULLS LAST,"run_at") WHERE "jobs"."status" = 'queued';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_finished_idx" ON "jobs" USING btree ("finished_at") WHERE "jobs"."status" in ('succeeded','failed','dead');
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "jobs_ready_idx";
