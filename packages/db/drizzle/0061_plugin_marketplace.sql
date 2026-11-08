CREATE TABLE "plugin_index" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"public_keys" jsonb NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_index_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "plugin_install_ping" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "index_id" text;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "yanked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "previous_image" text;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "previous_version" text;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "previous_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD CONSTRAINT "plugin_install_index_id_plugin_index_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."plugin_index"("id") ON DELETE set null ON UPDATE no action;