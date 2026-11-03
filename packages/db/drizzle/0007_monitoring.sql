CREATE TABLE "metric_alert" (
	"threshold_id" text NOT NULL,
	"swarm_node_id" text NOT NULL,
	"firing" boolean NOT NULL,
	"value" real NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_alert_threshold_id_swarm_node_id_pk" PRIMARY KEY("threshold_id","swarm_node_id")
);
--> statement-breakpoint
CREATE TABLE "metric_rollup_state" (
	"name" text PRIMARY KEY NOT NULL,
	"through" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_threshold" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric" text NOT NULL,
	"node_id" text,
	"percent" real NOT NULL,
	"for_sec" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitoring_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"raw_retention_hours" integer DEFAULT 24 NOT NULL,
	"minute_retention_days" integer DEFAULT 7 NOT NULL,
	"hour_retention_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_settings_singleton_check" CHECK ("monitoring_settings"."id" = 'singleton')
);
--> statement-breakpoint
CREATE TABLE "node_join" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text NOT NULL,
	"ssh_key_id" text NOT NULL,
	"role" "node_role" DEFAULT 'worker' NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"step" text DEFAULT 'test' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"swarm_node_id" text,
	"node_id" text,
	"host_key" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "desired" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "facts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_alert" ADD CONSTRAINT "metric_alert_threshold_id_metric_threshold_id_fk" FOREIGN KEY ("threshold_id") REFERENCES "public"."metric_threshold"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_threshold" ADD CONSTRAINT "metric_threshold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_join" ADD CONSTRAINT "node_join_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_join" ADD CONSTRAINT "node_join_ssh_key_id_ssh_key_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_key"("id") ON DELETE cascade ON UPDATE no action;