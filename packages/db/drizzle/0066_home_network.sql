CREATE TABLE "home_network" (
	"id" text PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"node_id" text NOT NULL,
	"lan_address" text NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"status_message" text,
	"settings" jsonb NOT NULL,
	"admin_password_encrypted" text NOT NULL,
	"token_encrypted" text,
	"applied_hash" text,
	"service_id" text,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_network_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "home_network_singleton_true" CHECK ("home_network"."singleton")
);
--> statement-breakpoint
ALTER TABLE "home_network" ADD CONSTRAINT "home_network_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;