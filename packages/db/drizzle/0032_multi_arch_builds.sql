ALTER TABLE "deployment" ADD COLUMN "platforms" text[];--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "buildkit" jsonb;