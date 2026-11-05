CREATE TYPE "public"."migration_item_status" AS ENUM('planned', 'imported', 'cut_over', 'failed', 'rolled_back', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."migration_source" AS ENUM('dokploy');--> statement-breakpoint
CREATE TYPE "public"."migration_status" AS ENUM('planned', 'importing', 'imported');--> statement-breakpoint
CREATE TABLE "migration" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" "migration_source" NOT NULL,
	"status" "migration_status" DEFAULT 'planned' NOT NULL,
	"archive_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_item" (
	"id" text PRIMARY KEY NOT NULL,
	"migration_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"status" "migration_item_status" NOT NULL,
	"plan_encrypted" text NOT NULL,
	"targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "migration" ADD CONSTRAINT "migration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_item" ADD CONSTRAINT "migration_item_migration_id_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_item_source" ON "migration_item" USING btree ("migration_id","kind","source_id");--> statement-breakpoint
CREATE INDEX "migration_item_order" ON "migration_item" USING btree ("migration_id","position");