CREATE TABLE "instance_update" (
	"id" text PRIMARY KEY NOT NULL,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_check_updates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_update_one_active" ON "instance_update" USING btree ((true)) WHERE "instance_update"."state" in ('queued', 'running');