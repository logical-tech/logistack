CREATE TABLE "registry_retention" (
	"registry_id" text PRIMARY KEY NOT NULL,
	"keep_tags" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_watch_paths" (
	"service_id" text PRIMARY KEY NOT NULL,
	"paths" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_retention" ADD CONSTRAINT "registry_retention_registry_id_registry_id_fk" FOREIGN KEY ("registry_id") REFERENCES "public"."registry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_watch_paths" ADD CONSTRAINT "service_watch_paths_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;