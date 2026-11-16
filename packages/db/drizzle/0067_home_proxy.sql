CREATE TABLE "home_proxy" (
	"id" text PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"zone" text NOT NULL,
	"tls" text NOT NULL,
	"ca_root_pem" text,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_proxy_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "home_proxy_singleton_true" CHECK ("home_proxy"."singleton")
);
--> statement-breakpoint
CREATE TABLE "home_proxy_route" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"upstream" text NOT NULL,
	"insecure" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_proxy_route_name_unique" UNIQUE("name")
);
