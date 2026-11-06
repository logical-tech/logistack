ALTER TYPE "public"."stack_source" ADD VALUE 'git';--> statement-breakpoint
ALTER TABLE "stack" ADD COLUMN "git" jsonb;