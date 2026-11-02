DROP INDEX "email_domains_domain_uq";--> statement-breakpoint
ALTER TABLE "email_domains" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "email_domains" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_domains" ADD COLUMN "note" text;--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_verified_domain_uq" ON "email_domains" USING btree ("domain") WHERE status = 'verified';--> statement-breakpoint
CREATE INDEX "email_domains_domain_idx" ON "email_domains" USING btree ("domain");