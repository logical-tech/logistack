CREATE TABLE "adopted_volume" (
	"volume_name" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"service_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adopted_volume_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
ALTER TABLE "adopted_volume" ADD CONSTRAINT "adopted_volume_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;