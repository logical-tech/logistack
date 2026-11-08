CREATE TABLE "community_template_index" (
	"url" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"templates" jsonb NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
