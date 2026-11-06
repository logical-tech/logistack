ALTER TYPE "public"."deployment_status" ADD VALUE 'releasing' BEFORE 'deploying';--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "warning" text;