CREATE INDEX "approvals_pending_created_idx" ON "approvals" USING btree ("created_at") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "deliverables_run_idx" ON "deliverables" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_tool_result_uq" ON "run_steps" USING btree ("run_id",("data"->>'toolUseId')) WHERE "run_steps"."kind" = 'tool_result';--> statement-breakpoint
CREATE INDEX "runs_conversation_idx" ON "runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_run_idx" ON "messages" USING btree ("run_id");