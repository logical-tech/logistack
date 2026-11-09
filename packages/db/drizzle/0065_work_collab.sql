CREATE TABLE "work_org_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"attachment_quota_gb" integer,
	"attachment_destination_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "work_attachment_max_mb" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "mail_encrypted" text;--> statement-breakpoint
ALTER TABLE "work_org_settings" ADD CONSTRAINT "work_org_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_org_settings" ADD CONSTRAINT "work_org_settings_attachment_destination_id_s3_destination_id_fk" FOREIGN KEY ("attachment_destination_id") REFERENCES "public"."s3_destination"("id") ON DELETE set null ON UPDATE no action;