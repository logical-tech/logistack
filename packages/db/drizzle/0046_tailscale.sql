CREATE TABLE "tailscale_network" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"auth_key_encrypted" text NOT NULL,
	"node_service_id" text,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tailscale_network_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "tailscale_publication" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text NOT NULL,
	"hostname" text NOT NULL,
	"port" integer NOT NULL,
	"https" boolean DEFAULT true NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tailscale_publication_hostname" UNIQUE("organization_id","hostname")
);
--> statement-breakpoint
ALTER TABLE "tailscale_network" ADD CONSTRAINT "tailscale_network_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailscale_publication" ADD CONSTRAINT "tailscale_publication_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailscale_publication" ADD CONSTRAINT "tailscale_publication_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;