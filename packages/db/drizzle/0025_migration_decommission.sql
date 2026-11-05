ALTER TYPE "public"."migration_status" ADD VALUE 'decommissioned';--> statement-breakpoint
ALTER TABLE "migration" ADD COLUMN "decommission" jsonb;