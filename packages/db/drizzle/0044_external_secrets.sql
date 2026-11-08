CREATE TYPE "public"."secret_provider_kind" AS ENUM('vault', 'infisical', 'onepassword');--> statement-breakpoint
CREATE TABLE "secret_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" "secret_provider_kind" NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"config_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_provider_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "external_fingerprint" text;--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "external_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "external_error" text;--> statement-breakpoint
ALTER TABLE "secret_provider" ADD CONSTRAINT "secret_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_provider_id_secret_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."secret_provider"("id") ON DELETE restrict ON UPDATE no action;