CREATE TABLE "database_access" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text NOT NULL,
	"kind" text NOT NULL,
	"hostname" text,
	"port" integer NOT NULL,
	"allowed_cidrs" jsonb NOT NULL,
	"tls_required" boolean NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"cert_not_after" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_access_port" UNIQUE("port")
);
--> statement-breakpoint
CREATE TABLE "database_upgrade" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text NOT NULL,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"step" text DEFAULT 'check' NOT NULL,
	"message" text,
	"previous_data_volume_id" text,
	"counts" jsonb,
	"created_by" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "data_volume_id" text;--> statement-breakpoint
ALTER TABLE "database_access" ADD CONSTRAINT "database_access_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_access" ADD CONSTRAINT "database_access_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_access" ADD CONSTRAINT "database_access_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_upgrade" ADD CONSTRAINT "database_upgrade_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_upgrade" ADD CONSTRAINT "database_upgrade_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_upgrade" ADD CONSTRAINT "database_upgrade_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_access_service_idx" ON "database_access" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "database_upgrade_service_idx" ON "database_upgrade" USING btree ("service_id");