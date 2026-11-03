ALTER TYPE "public"."run_status" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "backup_policy" ADD COLUMN "pause_service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN "source_run_id" text;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN "target_service_id" text;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN "pruned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "notify_on_failure" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD COLUMN "trigger" text DEFAULT 'cron' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD COLUMN "output_bytes" bigint;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_source_run_id_backup_run_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."backup_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_target_service_id_service_id_fk" FOREIGN KEY ("target_service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;