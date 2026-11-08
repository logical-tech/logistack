CREATE TYPE "public"."work_activity_kind" AS ENUM('created', 'status', 'assignee_added', 'assignee_removed', 'dates', 'priority', 'list_moved', 'project_moved', 'field', 'tag_added', 'tag_removed', 'dependency_added', 'dependency_removed', 'attachment_added', 'attachment_removed', 'archived', 'restored', 'checklist', 'git_linked', 'git_closed', 'imported', 'recurred', 'edited');--> statement-breakpoint
CREATE TYPE "public"."work_attachment_driver" AS ENUM('db', 's3');--> statement-breakpoint
CREATE TYPE "public"."work_attachment_inline" AS ENUM('description', 'comment', 'none');--> statement-breakpoint
CREATE TYPE "public"."work_email_mode" AS ENUM('off', 'instant', 'daily');--> statement-breakpoint
CREATE TYPE "public"."work_field_kind" AS ENUM('text', 'long_text', 'number', 'currency', 'percent', 'date', 'checkbox', 'select', 'multi_select', 'user', 'url', 'email', 'phone', 'rating');--> statement-breakpoint
CREATE TYPE "public"."work_git_link_kind" AS ENUM('commit', 'branch', 'pull_request');--> statement-breakpoint
CREATE TYPE "public"."work_git_link_state" AS ENUM('open', 'merged', 'closed', 'pushed');--> statement-breakpoint
CREATE TYPE "public"."work_import_kind" AS ENUM('clickup', 'csv');--> statement-breakpoint
CREATE TYPE "public"."work_import_status" AS ENUM('draft', 'ready', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_notification_kind" AS ENUM('assigned', 'unassigned', 'mentioned', 'commented', 'replied', 'status_changed', 'due_soon', 'overdue', 'checklist_assigned', 'timer_running_long');--> statement-breakpoint
CREATE TYPE "public"."work_priority" AS ENUM('urgent', 'high', 'normal', 'low', 'none');--> statement-breakpoint
CREATE TYPE "public"."work_status_category" AS ENUM('backlog', 'active', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_template_kind" AS ENUM('task', 'list', 'project');--> statement-breakpoint
CREATE TYPE "public"."work_time_entry_source" AS ENUM('timer', 'manual', 'import');--> statement-breakpoint
CREATE TYPE "public"."work_view_kind" AS ENUM('table', 'board', 'timeline', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."work_watch_reason" AS ENUM('creator', 'assignee', 'mention', 'comment', 'manual');--> statement-breakpoint
CREATE TABLE "invitation_grant" (
	"invitation_id" text NOT NULL,
	"role" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_grant_invitation_id_scope_kind_scope_id_pk" PRIMARY KEY("invitation_id","scope_kind","scope_id"),
	CONSTRAINT "invitation_grant_scope_kind_check" CHECK ("invitation_grant"."scope_kind" in ('organization', 'folder', 'project', 'environment', 'service'))
);
--> statement-breakpoint
CREATE TABLE "work_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"actor_id" text,
	"kind" "work_activity_kind" NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"comment_id" text,
	"inline_in" "work_attachment_inline" DEFAULT 'none' NOT NULL,
	"uploader_id" text,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"driver" "work_attachment_driver" DEFAULT 'db' NOT NULL,
	"object_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"thumb_key" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_attachment_owner_check" CHECK ("work_attachment"."task_id" is not null or "work_attachment"."comment_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "work_blob" (
	"sha256" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" bigint NOT NULL,
	"ref_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_checklist_item" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_by" text,
	"done_at" timestamp with time zone,
	"assignee_id" text,
	"position" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_checklist_text_check" CHECK (length("work_checklist_item"."text") <= 500)
);
--> statement-breakpoint
CREATE TABLE "work_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"author_id" text,
	"parent_id" text,
	"body" jsonb,
	"body_text" text,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("work_comment"."body_text", ''))) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_dependency" (
	"task_id" text NOT NULL,
	"blocked_by_id" text NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_dependency_task_id_blocked_by_id_pk" PRIMARY KEY("task_id","blocked_by_id"),
	CONSTRAINT "work_dependency_self_check" CHECK ("work_dependency"."task_id" <> "work_dependency"."blocked_by_id")
);
--> statement-breakpoint
CREATE TABLE "work_field" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"list_id" text,
	"name" text NOT NULL,
	"kind" "work_field_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"description" text,
	"position" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_field_value" (
	"task_id" text NOT NULL,
	"field_id" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_field_value_task_id_field_id_pk" PRIMARY KEY("task_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "work_git_link" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"repo" text NOT NULL,
	"kind" "work_git_link_kind" NOT NULL,
	"ref" text NOT NULL,
	"title" text,
	"url" text,
	"state" "work_git_link_state" NOT NULL,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_git_link_unique" UNIQUE("task_id","provider_id","repo","kind","ref")
);
--> statement-breakpoint
CREATE TABLE "work_import" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" "work_import_kind" NOT NULL,
	"created_by" text,
	"status" "work_import_status" DEFAULT 'draft' NOT NULL,
	"config_encrypted" text,
	"plan" jsonb,
	"progress" jsonb,
	"report" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_import_map" (
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"external_type" text NOT NULL,
	"external_id" text NOT NULL,
	"local_id" text NOT NULL,
	"local_type" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_import_map_organization_id_source_external_type_external_id_pk" PRIMARY KEY("organization_id","source","external_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "work_key_alias" (
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_key_alias_organization_id_key_pk" PRIMARY KEY("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "work_list" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" jsonb,
	"color" text,
	"icon" text,
	"position" text COLLATE "C" NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_notification" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"comment_id" text,
	"actor_id" text,
	"kind" "work_notification_kind" NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_date" date,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_project" (
	"project_id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"organization_id" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"default_list_id" text,
	"hidden_service_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"working_days" smallint DEFAULT 31 NOT NULL,
	"closing_status_id" text,
	"repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guests_assignable" boolean DEFAULT false NOT NULL,
	"guests_can_create" boolean DEFAULT false NOT NULL,
	"allow_share_links" boolean DEFAULT false NOT NULL,
	"time_tracking" boolean DEFAULT true NOT NULL,
	"time_locked_before" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_project_key_unique" UNIQUE("organization_id","key"),
	CONSTRAINT "work_project_key_check" CHECK ("work_project"."key" ~ '^[A-Z][A-Z0-9]{1,9}$')
);
--> statement-breakpoint
CREATE TABLE "work_reaction" (
	"comment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_reaction_comment_id_user_id_emoji_pk" PRIMARY KEY("comment_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "work_share" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"list_id" text,
	"view_id" text,
	"token_hash" text NOT NULL,
	"created_by" text,
	"name" text NOT NULL,
	"show_comments" boolean DEFAULT false NOT NULL,
	"show_assignees" boolean DEFAULT true NOT NULL,
	"field_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_share_target_check" CHECK (("work_share"."list_id" is null) <> ("work_share"."view_id" is null))
);
--> statement-breakpoint
CREATE TABLE "work_status" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"category" "work_status_category" NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"wip_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_tag" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_task" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"list_id" text NOT NULL,
	"parent_id" text,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" jsonb,
	"description_text" text,
	"status_id" text NOT NULL,
	"priority" "work_priority" DEFAULT 'none' NOT NULL,
	"start_date" date,
	"due_date" date,
	"due_time" time,
	"is_milestone" boolean DEFAULT false NOT NULL,
	"estimate_minutes" integer,
	"position" text COLLATE "C" NOT NULL,
	"recurrence" jsonb,
	"recurrence_series_id" text,
	"source" jsonb,
	"created_by" text,
	"completed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', "work_task"."title"), 'A') || setweight(to_tsvector('simple', coalesce("work_task"."description_text", '')), 'B')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_task_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "work_task_dates_check" CHECK ("work_task"."start_date" is null or "work_task"."due_date" is null or "work_task"."start_date" <= "work_task"."due_date"),
	CONSTRAINT "work_task_due_time_check" CHECK ("work_task"."due_time" is null or "work_task"."due_date" is not null)
);
--> statement-breakpoint
CREATE TABLE "work_task_alias" (
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"task_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_task_alias_project_id_number_pk" PRIMARY KEY("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "work_task_assignee" (
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_task_assignee_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "work_task_tag" (
	"task_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "work_task_tag_task_id_tag_id_pk" PRIMARY KEY("task_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "work_task_watcher" (
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" "work_watch_reason" NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_task_watcher_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "work_template" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"project_id" text,
	"kind" "work_template_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"payload" jsonb NOT NULL,
	"created_by" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_time_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"note" text,
	"billable" boolean DEFAULT true NOT NULL,
	"source" "work_time_entry_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_time_entry_note_check" CHECK ("work_time_entry"."note" is null or length("work_time_entry"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "work_user_prefs" (
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"email" "work_email_mode" DEFAULT 'off' NOT NULL,
	"email_kinds" text[] DEFAULT '{assigned,mentioned,due_soon,overdue}'::text[] NOT NULL,
	"daily_hour" smallint DEFAULT 8 NOT NULL,
	"timezone" text,
	"ical_token_hash" text,
	"capacity_hours_per_week" smallint DEFAULT 32 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_user_prefs_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "work_view" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"list_id" text,
	"owner_id" text,
	"name" text NOT NULL,
	"kind" "work_view_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitation_grant" ADD CONSTRAINT "invitation_grant_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activity" ADD CONSTRAINT "work_activity_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activity" ADD CONSTRAINT "work_activity_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_attachment" ADD CONSTRAINT "work_attachment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_attachment" ADD CONSTRAINT "work_attachment_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_attachment" ADD CONSTRAINT "work_attachment_comment_id_work_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."work_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_attachment" ADD CONSTRAINT "work_attachment_uploader_id_user_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_checklist_item" ADD CONSTRAINT "work_checklist_item_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_checklist_item" ADD CONSTRAINT "work_checklist_item_done_by_user_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_checklist_item" ADD CONSTRAINT "work_checklist_item_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_comment" ADD CONSTRAINT "work_comment_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_comment" ADD CONSTRAINT "work_comment_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_comment" ADD CONSTRAINT "work_comment_parent_id_work_comment_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."work_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_comment" ADD CONSTRAINT "work_comment_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_dependency" ADD CONSTRAINT "work_dependency_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_dependency" ADD CONSTRAINT "work_dependency_blocked_by_id_work_task_id_fk" FOREIGN KEY ("blocked_by_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_dependency" ADD CONSTRAINT "work_dependency_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_field" ADD CONSTRAINT "work_field_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_field" ADD CONSTRAINT "work_field_list_id_work_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."work_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_field_value" ADD CONSTRAINT "work_field_value_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_field_value" ADD CONSTRAINT "work_field_value_field_id_work_field_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."work_field"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_field_value" ADD CONSTRAINT "work_field_value_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_git_link" ADD CONSTRAINT "work_git_link_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_git_link" ADD CONSTRAINT "work_git_link_provider_id_git_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."git_provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_import" ADD CONSTRAINT "work_import_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_import" ADD CONSTRAINT "work_import_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_import_map" ADD CONSTRAINT "work_import_map_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_key_alias" ADD CONSTRAINT "work_key_alias_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_key_alias" ADD CONSTRAINT "work_key_alias_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_list" ADD CONSTRAINT "work_list_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_notification" ADD CONSTRAINT "work_notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_notification" ADD CONSTRAINT "work_notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_notification" ADD CONSTRAINT "work_notification_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_notification" ADD CONSTRAINT "work_notification_comment_id_work_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."work_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_notification" ADD CONSTRAINT "work_notification_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_project" ADD CONSTRAINT "work_project_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_project" ADD CONSTRAINT "work_project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_reaction" ADD CONSTRAINT "work_reaction_comment_id_work_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."work_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_reaction" ADD CONSTRAINT "work_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_share" ADD CONSTRAINT "work_share_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_share" ADD CONSTRAINT "work_share_list_id_work_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."work_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_share" ADD CONSTRAINT "work_share_view_id_work_view_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."work_view"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_share" ADD CONSTRAINT "work_share_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_status" ADD CONSTRAINT "work_status_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_tag" ADD CONSTRAINT "work_tag_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task" ADD CONSTRAINT "work_task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task" ADD CONSTRAINT "work_task_list_id_work_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."work_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task" ADD CONSTRAINT "work_task_parent_id_work_task_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task" ADD CONSTRAINT "work_task_status_id_work_status_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."work_status"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task" ADD CONSTRAINT "work_task_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_alias" ADD CONSTRAINT "work_task_alias_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_alias" ADD CONSTRAINT "work_task_alias_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_assignee" ADD CONSTRAINT "work_task_assignee_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_assignee" ADD CONSTRAINT "work_task_assignee_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_assignee" ADD CONSTRAINT "work_task_assignee_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_tag" ADD CONSTRAINT "work_task_tag_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_tag" ADD CONSTRAINT "work_task_tag_tag_id_work_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."work_tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_watcher" ADD CONSTRAINT "work_task_watcher_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_task_watcher" ADD CONSTRAINT "work_task_watcher_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_template" ADD CONSTRAINT "work_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_template" ADD CONSTRAINT "work_template_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_template" ADD CONSTRAINT "work_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_time_entry" ADD CONSTRAINT "work_time_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_time_entry" ADD CONSTRAINT "work_time_entry_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_time_entry" ADD CONSTRAINT "work_time_entry_task_id_work_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."work_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_time_entry" ADD CONSTRAINT "work_time_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_user_prefs" ADD CONSTRAINT "work_user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_user_prefs" ADD CONSTRAINT "work_user_prefs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_view" ADD CONSTRAINT "work_view_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_view" ADD CONSTRAINT "work_view_list_id_work_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."work_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_view" ADD CONSTRAINT "work_view_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_activity_task_idx" ON "work_activity" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "work_attachment_task_idx" ON "work_attachment" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "work_attachment_comment_idx" ON "work_attachment" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "work_attachment_project_idx" ON "work_attachment" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "work_attachment_sha_idx" ON "work_attachment" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "work_attachment_deleted_idx" ON "work_attachment" USING btree ("deleted_at") WHERE "work_attachment"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "work_checklist_task_idx" ON "work_checklist_item" USING btree ("task_id","position");--> statement-breakpoint
CREATE INDEX "work_comment_task_idx" ON "work_comment" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "work_comment_search_idx" ON "work_comment" USING gin ("search");--> statement-breakpoint
CREATE INDEX "work_dependency_blocked_by_idx" ON "work_dependency" USING btree ("blocked_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_field_name_idx" ON "work_field" USING btree ("project_id",coalesce("list_id", ''),lower("name"));--> statement-breakpoint
CREATE INDEX "work_field_value_field_idx" ON "work_field_value" USING btree ("field_id");--> statement-breakpoint
CREATE INDEX "work_import_org_idx" ON "work_import" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_list_name_idx" ON "work_list" USING btree ("project_id",lower("name")) WHERE "work_list"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "work_list_project_idx" ON "work_list" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "work_notification_inbox_idx" ON "work_notification" USING btree ("user_id","read_at","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "work_notification_created_idx" ON "work_notification" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_notification_due_idx" ON "work_notification" USING btree ("user_id","task_id","kind","due_date") WHERE "work_notification"."due_date" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "work_share_token_idx" ON "work_share" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "work_share_project_idx" ON "work_share" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_status_name_idx" ON "work_status" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "work_status_project_idx" ON "work_status" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "work_tag_name_idx" ON "work_tag" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "work_task_search_idx" ON "work_task" USING gin ("search");--> statement-breakpoint
CREATE INDEX "work_task_list_idx" ON "work_task" USING btree ("list_id","status_id","position");--> statement-breakpoint
CREATE INDEX "work_task_due_idx" ON "work_task" USING btree ("project_id","due_date") WHERE "work_task"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "work_task_parent_idx" ON "work_task" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_task_recurrence_idx" ON "work_task" USING btree ("recurrence_series_id","due_date") WHERE "work_task"."recurrence_series_id" is not null;--> statement-breakpoint
CREATE INDEX "work_task_assignee_user_idx" ON "work_task_assignee" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "work_task_tag_tag_idx" ON "work_task_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "work_task_watcher_user_idx" ON "work_task_watcher" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "work_template_org_idx" ON "work_template" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_time_entry_running_idx" ON "work_time_entry" USING btree ("user_id") WHERE "work_time_entry"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "work_time_entry_project_idx" ON "work_time_entry" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "work_time_entry_user_idx" ON "work_time_entry" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "work_time_entry_task_idx" ON "work_time_entry" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_user_prefs_ical_idx" ON "work_user_prefs" USING btree ("ical_token_hash") WHERE "work_user_prefs"."ical_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "work_view_project_idx" ON "work_view" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "work_view_default_idx" ON "work_view" USING btree ("project_id",coalesce("list_id", '')) WHERE "work_view"."is_default" and "work_view"."owner_id" is null;