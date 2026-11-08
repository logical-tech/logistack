CREATE TABLE "incident" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"impact" text DEFAULT 'major' NOT NULL,
	"monitor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_by_monitor_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_update" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_window" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"monitor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"repeat" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"service_id" text,
	"domain_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"interval_sec" integer DEFAULT 60 NOT NULL,
	"retry_interval_sec" integer DEFAULT 20 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"down_after" integer DEFAULT 3 NOT NULL,
	"up_after" integer DEFAULT 1 NOT NULL,
	"resend_minutes" integer DEFAULT 0 NOT NULL,
	"auto_incident" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"push_token_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_ping_at" timestamp with time zone,
	"last_latency_ms" integer,
	"last_error" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"cert_expires_at" timestamp with time zone,
	"cert_warned_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_push_token_hash_unique" UNIQUE("push_token_hash"),
	CONSTRAINT "monitor_confirm_check" CHECK ("monitor"."down_after" >= 1 and "monitor"."up_after" >= 1 and "monitor"."interval_sec" >= 20)
);
--> statement-breakpoint
CREATE TABLE "monitor_check" (
	"monitor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"maintenance" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"error" text,
	"region" text DEFAULT 'worker' NOT NULL,
	CONSTRAINT "monitor_check_monitor_id_at_pk" PRIMARY KEY("monitor_id","at")
);
--> statement-breakpoint
CREATE TABLE "monitor_daily" (
	"monitor_id" text NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"maintenance" integer DEFAULT 0 NOT NULL,
	"latency_sum" bigint DEFAULT 0 NOT NULL,
	"latency_max" integer DEFAULT 0 NOT NULL,
	"day" date NOT NULL,
	CONSTRAINT "monitor_daily_monitor_id_day_pk" PRIMARY KEY("monitor_id","day")
);
--> statement-breakpoint
CREATE TABLE "monitor_hourly" (
	"monitor_id" text NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"maintenance" integer DEFAULT 0 NOT NULL,
	"latency_sum" bigint DEFAULT 0 NOT NULL,
	"latency_max" integer DEFAULT 0 NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	CONSTRAINT "monitor_hourly_monitor_id_hour_pk" PRIMARY KEY("monitor_id","hour")
);
--> statement-breakpoint
CREATE TABLE "status_page" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"hostname" text,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"theme" jsonb NOT NULL,
	"history_days" integer DEFAULT 90 NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_slug_unique" UNIQUE("slug"),
	CONSTRAINT "status_page_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_opened_by_monitor_id_monitor_id_fk" FOREIGN KEY ("opened_by_monitor_id") REFERENCES "public"."monitor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_update" ADD CONSTRAINT "incident_update_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_update" ADD CONSTRAINT "incident_update_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window" ADD CONSTRAINT "maintenance_window_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_domain_id_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_check" ADD CONSTRAINT "monitor_check_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_daily" ADD CONSTRAINT "monitor_daily_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_hourly" ADD CONSTRAINT "monitor_hourly_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_organization_idx" ON "incident" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_open_monitor_idx" ON "incident" USING btree ("opened_by_monitor_id") WHERE "incident"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "incident_update_incident_idx" ON "incident_update" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "monitor_organization_idx" ON "monitor" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "monitor_due_idx" ON "monitor" USING btree ("next_check_at") WHERE "monitor"."enabled";--> statement-breakpoint
CREATE INDEX "monitor_check_at_idx" ON "monitor_check" USING btree ("at");