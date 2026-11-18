CREATE TABLE "lsdc_instance" (
	"stack_id" text PRIMARY KEY NOT NULL,
	"customer" text,
	"price_cents" integer,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lsdc_instance" ADD CONSTRAINT "lsdc_instance_stack_id_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stack"("id") ON DELETE cascade ON UPDATE no action;