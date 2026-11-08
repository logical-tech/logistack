ALTER TABLE "instance_settings" ADD COLUMN "update_channel" text DEFAULT 'stable' NOT NULL;--> statement-breakpoint
-- Instances that had beta updates on stay on the beta channel.
UPDATE "instance_settings" SET "update_channel" = 'beta' WHERE "beta_updates";
