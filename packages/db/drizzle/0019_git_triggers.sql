CREATE TYPE "public"."git_ref_kind" AS ENUM('branch', 'tag', 'release');--> statement-breakpoint
ALTER TYPE "public"."deployment_status" ADD VALUE 'awaiting_checks' BEFORE 'queued';--> statement-breakpoint
ALTER TYPE "public"."deployment_status" ADD VALUE 'skipped';--> statement-breakpoint
CREATE TABLE "service_git_trigger" (
	"service_id" text PRIMARY KEY NOT NULL,
	"on" "git_ref_kind" NOT NULL,
	"tag_pattern" text NOT NULL,
	"wait_for_checks" boolean NOT NULL,
	"checks_timeout_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "git_ref" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "service_git_trigger" ADD CONSTRAINT "service_git_trigger_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;