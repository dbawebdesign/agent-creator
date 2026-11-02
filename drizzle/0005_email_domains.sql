CREATE TABLE "email_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_id" text,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_org_uq" ON "email_domains" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_domain_uq" ON "email_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "email_domains_status_idx" ON "email_domains" USING btree ("status");