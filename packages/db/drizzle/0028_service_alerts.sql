CREATE TABLE "service_threshold" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text NOT NULL,
	"metric" text NOT NULL,
	"above" real NOT NULL,
	"for_sec" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"firing" boolean,
	"value" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_status" ADD COLUMN "crash_loop" jsonb;--> statement-breakpoint
ALTER TABLE "service_threshold" ADD CONSTRAINT "service_threshold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_threshold" ADD CONSTRAINT "service_threshold_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_threshold_service_idx" ON "service_threshold" USING btree ("service_id");