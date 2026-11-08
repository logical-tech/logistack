ALTER TYPE "public"."dns_provider_kind" ADD VALUE 'plugin';--> statement-breakpoint
ALTER TYPE "public"."notification_channel_kind" ADD VALUE 'plugin';--> statement-breakpoint
ALTER TYPE "public"."secret_provider_kind" ADD VALUE 'plugin';--> statement-breakpoint
ALTER TABLE "dns_provider" ADD COLUMN "plugin_install_id" text;--> statement-breakpoint
ALTER TABLE "dns_provider" ADD COLUMN "plugin_provider" text;--> statement-breakpoint
ALTER TABLE "dns_provider" ADD COLUMN "acme_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "plugin_install_id" text;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "plugin_provider" text;--> statement-breakpoint
ALTER TABLE "secret_provider" ADD COLUMN "plugin_install_id" text;--> statement-breakpoint
ALTER TABLE "secret_provider" ADD COLUMN "plugin_provider" text;--> statement-breakpoint
ALTER TABLE "dns_provider" ADD CONSTRAINT "dns_provider_plugin_install_id_plugin_install_id_fk" FOREIGN KEY ("plugin_install_id") REFERENCES "public"."plugin_install"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_plugin_install_id_plugin_install_id_fk" FOREIGN KEY ("plugin_install_id") REFERENCES "public"."plugin_install"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_provider" ADD CONSTRAINT "secret_provider_plugin_install_id_plugin_install_id_fk" FOREIGN KEY ("plugin_install_id") REFERENCES "public"."plugin_install"("id") ON DELETE no action ON UPDATE no action;