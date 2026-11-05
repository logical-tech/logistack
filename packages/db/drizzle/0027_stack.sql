CREATE TYPE "public"."stack_source" AS ENUM('template', 'compose');--> statement-breakpoint
CREATE TABLE "stack" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"source" "stack_source" NOT NULL,
	"template_id" text,
	"compose_yaml_encrypted" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_name_unique" UNIQUE("environment_id","name")
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "stack_id" text;--> statement-breakpoint
ALTER TABLE "stack" ADD CONSTRAINT "stack_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack" ADD CONSTRAINT "stack_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_stack_id_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_stack_id_idx" ON "service" USING btree ("stack_id");--> statement-breakpoint
-- Backfill: services a template deployed (`template:<templateId>:<name>/<service>`) become one stack per instance.
INSERT INTO "stack" ("id", "environment_id", "name", "source", "template_id", "created_by", "created_at")
SELECT 'stk_' || substr(md5(random()::text || g.environment_id || g.name), 1, 24), g.environment_id, g.name, 'template', g.template_id, g.created_by, g.created_at
FROM (
	SELECT "environment_id",
		substring("imported_from" from '^template:[^:]+:([^/]+)/') AS name,
		min(substring("imported_from" from '^template:([^:]+):')) AS template_id,
		min("created_by") AS created_by,
		min("created_at") AS created_at
	FROM "service"
	WHERE "imported_from" ~ '^template:[^:]+:[^/]+/'
	GROUP BY 1, 2
) g;--> statement-breakpoint
UPDATE "service" s SET "stack_id" = st."id"
FROM "stack" st
WHERE st."environment_id" = s."environment_id"
	AND s."imported_from" ~ '^template:[^:]+:[^/]+/'
	AND substring(s."imported_from" from '^template:[^:]+:([^/]+)/') = st."name";
