-- Nothing issued node tokens before this migration, so no row could be backfilled with an organization.
DELETE FROM "node_token";--> statement-breakpoint
ALTER TABLE "node_token" ALTER COLUMN "node_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "node_token" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "node_token" ADD CONSTRAINT "node_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;