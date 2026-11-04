CREATE TABLE "service_basic_auth" (
	"service_id" text PRIMARY KEY NOT NULL,
	"users" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_basic_auth" ADD CONSTRAINT "service_basic_auth_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;