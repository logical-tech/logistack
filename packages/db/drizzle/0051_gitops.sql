ALTER TABLE "env_var" ADD COLUMN "as_file" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "caddy_storage_key_encrypted" text;--> statement-breakpoint
CREATE TABLE "project_gitops" (
	"project_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"git_provider_id" text NOT NULL,
	"repository" text NOT NULL,
	"branch" text NOT NULL,
	"path" text NOT NULL,
	"auto_apply" boolean DEFAULT true NOT NULL,
	"prune" boolean DEFAULT false NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"last_commit_sha" text,
	"last_synced_at" timestamp with time zone,
	"last_status" text,
	"last_changes" integer,
	"last_error" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_gitops" ADD CONSTRAINT "project_gitops_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_gitops" ADD CONSTRAINT "project_gitops_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_gitops" ADD CONSTRAINT "project_gitops_git_provider_id_git_provider_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_gitops" ADD CONSTRAINT "project_gitops_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
