CREATE TABLE "node_patch_status" (
	"node_id" text PRIMARY KEY NOT NULL,
	"package_manager" text,
	"os" text,
	"kernel" text,
	"reboot_required" boolean DEFAULT false NOT NULL,
	"updates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"security_count" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_policy" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cron" text DEFAULT '0 4 * * 0' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"security_only" boolean DEFAULT true NOT NULL,
	"reboot" text DEFAULT 'if_needed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"security_only" boolean DEFAULT false NOT NULL,
	"reboot" text DEFAULT 'if_needed' NOT NULL,
	"nodes" jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_patch_status" ADD CONSTRAINT "node_patch_status_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_policy" ADD CONSTRAINT "patch_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_run" ADD CONSTRAINT "patch_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patch_run_org_created_idx" ON "patch_run" USING btree ("organization_id","created_at");