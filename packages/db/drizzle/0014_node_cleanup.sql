ALTER TABLE "monitoring_settings" ADD COLUMN "cleanup_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_settings" ADD COLUMN "cleanup_cron" text DEFAULT '0 3 * * *' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_settings" ADD COLUMN "cleanup_timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_settings" ADD COLUMN "cleanup_targets" jsonb DEFAULT '["containers","images","buildCache"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_settings" ADD COLUMN "cleanup_until_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_settings" ADD COLUMN "last_cleanup" jsonb;