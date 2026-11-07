ALTER TABLE "s3_destination" ADD COLUMN "kind" text DEFAULT 's3' NOT NULL;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD COLUMN "node_id" text;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD CONSTRAINT "s3_destination_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE set null ON UPDATE no action;