CREATE TABLE "network_device" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"person_id" text,
	"blocking" jsonb DEFAULT '{"listUrls":[],"blocked":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_device_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "network_person" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"blocking" jsonb DEFAULT '{"listUrls":[],"blocked":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "network_device" ADD CONSTRAINT "network_device_person_id_network_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."network_person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_device_person_id_idx" ON "network_device" USING btree ("person_id");