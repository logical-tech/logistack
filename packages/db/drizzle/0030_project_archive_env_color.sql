ALTER TABLE "environment" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "stopped_by_archive" boolean DEFAULT false NOT NULL;