CREATE TYPE "public"."secret_scope" AS ENUM('organization', 'folder', 'project', 'environment', 'service');--> statement-breakpoint
CREATE TABLE "secret" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope" "secret_scope" NOT NULL,
	"scope_id" text NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"current_version" integer NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_key_unique" UNIQUE("scope","scope_id","key")
);
--> statement-breakpoint
CREATE TABLE "secret_key" (
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"wrapped_key" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_key_version_unique" UNIQUE("organization_id","version")
);
--> statement-breakpoint
CREATE TABLE "secret_version" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_id" text NOT NULL,
	"version" integer NOT NULL,
	"value_encrypted" text NOT NULL,
	"dek_version" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_version_unique" UNIQUE("secret_id","version")
);
--> statement-breakpoint
ALTER TABLE "env_var" ADD COLUMN "secret_id" text;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_key" ADD CONSTRAINT "secret_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_version" ADD CONSTRAINT "secret_version_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_version" ADD CONSTRAINT "secret_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_organization_idx" ON "secret" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_key_one_active_idx" ON "secret_key" USING btree ("organization_id") WHERE "secret_key"."status" = 'active';--> statement-breakpoint
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "env_var_secret_id_idx" ON "env_var" USING btree ("secret_id");