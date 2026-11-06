CREATE TABLE "service_autoscale" (
	"service_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_replicas" integer NOT NULL,
	"max_replicas" integer NOT NULL,
	"behavior" text NOT NULL,
	"target_cpu" integer NOT NULL,
	"target_memory" integer,
	"replicas" integer,
	"last_scaled_at" timestamp with time zone,
	"last_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_autoscale_range_check" CHECK ("service_autoscale"."min_replicas" >= 1 and "service_autoscale"."min_replicas" <= "service_autoscale"."max_replicas")
);
--> statement-breakpoint
ALTER TABLE "service_autoscale" ADD CONSTRAINT "service_autoscale_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;