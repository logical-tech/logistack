CREATE TABLE "plugin_install" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"version" text NOT NULL,
	"image" text,
	"dev_url" text,
	"manifest" jsonb NOT NULL,
	"registry_id" text,
	"config_encrypted" text NOT NULL,
	"service_account_id" text,
	"token_encrypted" text,
	"signing_secret_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_install_org_plugin" UNIQUE("organization_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_ui_storage" (
	"install_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_ui_storage_install_id_user_id_key_pk" PRIMARY KEY("install_id","user_id","key")
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "plugin_policy" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD CONSTRAINT "plugin_install_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD CONSTRAINT "plugin_install_service_account_id_user_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_ui_storage" ADD CONSTRAINT "plugin_ui_storage_install_id_plugin_install_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."plugin_install"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_ui_storage" ADD CONSTRAINT "plugin_ui_storage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;