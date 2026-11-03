CREATE TABLE "api_key_usage" (
	"key_id" text PRIMARY KEY NOT NULL,
	"last_ip" "inet",
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_grant_unique" UNIQUE("user_id","role","scope_kind","scope_id"),
	CONSTRAINT "role_grant_scope_kind_check" CHECK ("role_grant"."scope_kind" in ('organization', 'folder', 'project', 'environment', 'service'))
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "allow_private_hosts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_grant_org_user_idx" ON "role_grant" USING btree ("organization_id","user_id");