CREATE TABLE "plugin_gate_decision" (
	"deployment_id" text NOT NULL,
	"install_id" text NOT NULL,
	"allowed" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_gate_decision_deployment_id_install_id_pk" PRIMARY KEY("deployment_id","install_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "gate_timeout_seconds" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_install" ADD COLUMN "gate_fail_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_gate_decision" ADD CONSTRAINT "plugin_gate_decision_deployment_id_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_gate_decision" ADD CONSTRAINT "plugin_gate_decision_install_id_plugin_install_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."plugin_install"("id") ON DELETE cascade ON UPDATE no action;