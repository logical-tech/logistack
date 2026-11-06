ALTER TYPE "public"."service_kind" ADD VALUE 'game';--> statement-breakpoint
CREATE TABLE "game_endpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"hostname" text NOT NULL,
	"dns_provider_id" text,
	"address_record_id" text,
	"srv_record_id" text,
	"synced_target" text,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_endpoint_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "public_address" text;--> statement-breakpoint
ALTER TABLE "game_endpoint" ADD CONSTRAINT "game_endpoint_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_endpoint" ADD CONSTRAINT "game_endpoint_dns_provider_id_dns_provider_id_fk" FOREIGN KEY ("dns_provider_id") REFERENCES "public"."dns_provider"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_endpoint_service_id_idx" ON "game_endpoint" USING btree ("service_id");