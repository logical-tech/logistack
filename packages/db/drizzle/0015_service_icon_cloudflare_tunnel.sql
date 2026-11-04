CREATE TABLE "cloudflare_tunnel" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dns_provider_id" text NOT NULL,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"tunnel_id" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloudflare_tunnel_dns_provider_id_unique" UNIQUE("dns_provider_id")
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "tunnel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_dns_provider_id_dns_provider_id_fk" FOREIGN KEY ("dns_provider_id") REFERENCES "public"."dns_provider"("id") ON DELETE cascade ON UPDATE no action;