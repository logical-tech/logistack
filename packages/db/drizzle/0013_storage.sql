CREATE TYPE "public"."storage_key_access" AS ENUM('read', 'readwrite');--> statement-breakpoint
ALTER TYPE "public"."service_kind" ADD VALUE 'storage';--> statement-breakpoint
CREATE TABLE "storage_access_key" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"access_key_id" text NOT NULL,
	"buckets" text[] NOT NULL,
	"access" "storage_key_access" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_access_key_unique" UNIQUE("service_id","access_key_id")
);
--> statement-breakpoint
ALTER TABLE "s3_destination" ADD COLUMN "storage_service_id" text;--> statement-breakpoint
ALTER TABLE "storage_access_key" ADD CONSTRAINT "storage_access_key_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_access_key" ADD CONSTRAINT "storage_access_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD CONSTRAINT "s3_destination_storage_service_id_service_id_fk" FOREIGN KEY ("storage_service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;