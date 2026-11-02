DROP INDEX "jobs_ready_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "delivered_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "agency_id" uuid;--> statement-breakpoint
CREATE INDEX "auth_tokens_expires_idx" ON "auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "organizations_custom_domain_lower_idx" ON "organizations" USING btree (lower("custom_domain")) WHERE "organizations"."custom_domain" is not null;--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agents_blueprint_idx" ON "agents" USING btree ("blueprint_id") WHERE "agents"."blueprint_id" is not null;--> statement-breakpoint
CREATE INDEX "approvals_run_idx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approvals_agent_idx" ON "approvals" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "deliverables_org_created_id_idx" ON "deliverables" USING btree ("org_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deliverables_agency_created_idx" ON "deliverables" USING btree ("agency_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deliverables_agency_changes_idx" ON "deliverables" USING btree ("agency_id","created_at" DESC NULLS LAST) WHERE "deliverables"."status" = 'changes_requested';--> statement-breakpoint
CREATE INDEX "deliverables_review_idx" ON "deliverables" USING btree ("org_id") WHERE "deliverables"."needs_review" and "deliverables"."status" in ('new','seen');--> statement-breakpoint
CREATE INDEX "deliverables_workflow_idx" ON "deliverables" USING btree ("workflow_id") WHERE "deliverables"."workflow_id" is not null;--> statement-breakpoint
CREATE INDEX "runs_workflow_idx" ON "runs" USING btree ("workflow_id") WHERE "runs"."workflow_id" is not null;--> statement-breakpoint
CREATE INDEX "workflows_org_idx" ON "workflows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "conversations_org_idx" ON "conversations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id") WHERE "conversations"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_events_created_idx" ON "webhook_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("queue","priority" DESC NULLS LAST,"run_at") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_finished_idx" ON "jobs" USING btree ("finished_at") WHERE "jobs"."status" in ('succeeded','failed','dead');--> statement-breakpoint
CREATE INDEX "notifications_org_kind_idx" ON "notifications" USING btree ("org_id","kind");