import {
	type ClickUpImportConfig,
	type PmDoc,
	type RecurrenceRule,
	type TemplatePayload,
	type WorkColor,
	type WorkFieldConfig,
	type WorkImportPlan,
	type WorkImportReport,
	type WorkRepo,
	type WorkTaskSource,
	type WorkViewConfig,
	workActivityKinds,
	workAttachmentDrivers,
	workAttachmentInline,
	workEmailModes,
	workFieldKinds,
	workGitLinkKinds,
	workGitLinkStates,
	workImportKinds,
	workImportStatuses,
	workNotificationKinds,
	workPriorities,
	workStatusCategories,
	workTemplateKinds,
	workTimeEntrySources,
	workViewKinds,
	workWatchReasons,
} from "@logistack/contracts";
import type { ScopeKind } from "@logistack/core";
import { type SQL, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	customType,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	smallint,
	text,
	time,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { invitation, organization, user } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import { project } from "./hierarchy.ts";
import { gitProvider } from "./integrations.ts";

/** Work: project management on existing projects (docs/plans/project-management.md, section 4). */

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
	dataType: () => "bytea",
});
/** Fractional rank: byte order so `rankBetween` keys sort as written. */
const rank = customType<{ data: string }>({
	dataType: () => 'text COLLATE "C"',
});

export const workStatusCategory = pgEnum(
	"work_status_category",
	workStatusCategories,
);
export const workPriority = pgEnum("work_priority", workPriorities);
export const workFieldKind = pgEnum("work_field_kind", workFieldKinds);
export const workViewKind = pgEnum("work_view_kind", workViewKinds);
export const workNotificationKind = pgEnum(
	"work_notification_kind",
	workNotificationKinds,
);
export const workActivityKind = pgEnum("work_activity_kind", workActivityKinds);
export const workWatchReason = pgEnum("work_watch_reason", workWatchReasons);
export const workAttachmentDriver = pgEnum(
	"work_attachment_driver",
	workAttachmentDrivers,
);
export const workAttachmentInlineIn = pgEnum(
	"work_attachment_inline",
	workAttachmentInline,
);
export const workEmailMode = pgEnum("work_email_mode", workEmailModes);
export const workTemplateKind = pgEnum("work_template_kind", workTemplateKinds);
export const workTimeEntrySource = pgEnum(
	"work_time_entry_source",
	workTimeEntrySources,
);
export const workGitLinkKind = pgEnum("work_git_link_kind", workGitLinkKinds);
export const workGitLinkState = pgEnum(
	"work_git_link_state",
	workGitLinkStates,
);
export const workImportKind = pgEnum("work_import_kind", workImportKinds);
export const workImportStatus = pgEnum(
	"work_import_status",
	workImportStatuses,
);

const projectRef = () =>
	text("project_id")
		.notNull()
		.references(() => project.id, { onDelete: "cascade" });
const userSetNull = (name: string) =>
	text(name).references(() => user.id, { onDelete: "set null" });

// 4.1 Project-level

/** Created lazily the first time anyone opens Work on a project. */
export const workProject = pgTable(
	"work_project",
	{
		projectId: text("project_id")
			.primaryKey()
			.references(() => project.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		nextNumber: integer("next_number").notNull().default(1),
		defaultListId: text("default_list_id"),
		hiddenServiceIds: text("hidden_service_ids")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		/** Mon=1 … Sun=64; default Mon–Fri. */
		workingDays: smallint("working_days").notNull().default(31),
		closingStatusId: text("closing_status_id"),
		repos: jsonb("repos")
			.$type<WorkRepo[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		guestsAssignable: boolean("guests_assignable").notNull().default(false),
		guestsCanCreate: boolean("guests_can_create").notNull().default(false),
		allowShareLinks: boolean("allow_share_links").notNull().default(false),
		timeTracking: boolean("time_tracking").notNull().default(true),
		timeLockedBefore: date("time_locked_before", { mode: "string" }),
		...timestamps,
	},
	(t) => [
		unique("work_project_key_unique").on(t.organizationId, t.key),
		check("work_project_key_check", sql`${t.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
	],
);

/** Old project keys, so `SHOP-42` links survive a rename or a move. */
export const workKeyAlias = pgTable(
	"work_key_alias",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		projectId: projectRef(),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.key] })],
);

export const workStatus = pgTable(
	"work_status",
	{
		id: id("wst"),
		projectId: projectRef(),
		name: text("name").notNull(),
		color: text("color").$type<WorkColor>().notNull(),
		category: workStatusCategory("category").notNull(),
		position: rank("position").notNull(),
		wipLimit: integer("wip_limit"),
		...timestamps,
	},
	(t) => [
		uniqueIndex("work_status_name_idx").on(t.projectId, sql`lower(${t.name})`),
		index("work_status_project_idx").on(t.projectId, t.position),
	],
);

export const workList = pgTable(
	"work_list",
	{
		id: id("wls"),
		projectId: projectRef(),
		name: text("name").notNull(),
		description: jsonb("description").$type<PmDoc>(),
		color: text("color").$type<WorkColor>(),
		icon: text("icon"),
		position: rank("position").notNull(),
		archivedAt: tstz("archived_at"),
		...timestamps,
	},
	(t) => [
		uniqueIndex("work_list_name_idx")
			.on(t.projectId, sql`lower(${t.name})`)
			.where(sql`${t.archivedAt} is null`),
		index("work_list_project_idx").on(t.projectId, t.position),
	],
);

export const workTag = pgTable(
	"work_tag",
	{
		id: id("wtg"),
		projectId: projectRef(),
		name: text("name").notNull(),
		color: text("color").$type<WorkColor>().notNull(),
		...timestamps,
	},
	(t) => [
		uniqueIndex("work_tag_name_idx").on(t.projectId, sql`lower(${t.name})`),
	],
);

// 4.2 Tasks

const searchVector = (title: SQL, body: SQL) =>
	sql`setweight(to_tsvector('simple', ${title}), 'A') || setweight(to_tsvector('simple', coalesce(${body}, '')), 'B')`;

export const workTask = pgTable(
	"work_task",
	{
		id: id("tsk"),
		projectId: projectRef(),
		listId: text("list_id")
			.notNull()
			.references(() => workList.id, { onDelete: "cascade" }),
		/** One level only; core rejects a parent that has a parent. */
		parentId: text("parent_id").references((): AnyPgColumn => workTask.id, {
			onDelete: "cascade",
		}),
		number: integer("number").notNull(),
		title: text("title").notNull(),
		description: jsonb("description").$type<PmDoc>(),
		descriptionText: text("description_text"),
		statusId: text("status_id")
			.notNull()
			.references(() => workStatus.id, { onDelete: "restrict" }),
		priority: workPriority("priority").notNull().default("none"),
		startDate: date("start_date", { mode: "string" }),
		dueDate: date("due_date", { mode: "string" }),
		dueTime: time("due_time"),
		isMilestone: boolean("is_milestone").notNull().default(false),
		estimateMinutes: integer("estimate_minutes"),
		position: rank("position").notNull(),
		recurrence: jsonb("recurrence").$type<RecurrenceRule>(),
		recurrenceSeriesId: text("recurrence_series_id"),
		source: jsonb("source").$type<WorkTaskSource>(),
		createdBy: userSetNull("created_by"),
		completedAt: tstz("completed_at"),
		archivedAt: tstz("archived_at"),
		search: tsvector("search")
			.notNull()
			.generatedAlwaysAs(
				(): SQL =>
					searchVector(
						sql`${workTask.title}`,
						sql`${workTask.descriptionText}`,
					),
			),
		...timestamps,
	},
	(t) => [
		unique("work_task_number_unique").on(t.projectId, t.number),
		check(
			"work_task_dates_check",
			sql`${t.startDate} is null or ${t.dueDate} is null or ${t.startDate} <= ${t.dueDate}`,
		),
		check(
			"work_task_due_time_check",
			sql`${t.dueTime} is null or ${t.dueDate} is not null`,
		),
		index("work_task_search_idx").using("gin", t.search),
		index("work_task_list_idx").on(t.listId, t.statusId, t.position),
		index("work_task_due_idx")
			.on(t.projectId, t.dueDate)
			.where(sql`${t.archivedAt} is null`),
		index("work_task_parent_idx").on(t.parentId),
		uniqueIndex("work_task_recurrence_idx")
			.on(t.recurrenceSeriesId, t.dueDate)
			.where(sql`${t.recurrenceSeriesId} is not null`),
	],
);

/** Tasks that moved to another project, so old keys still resolve. */
export const workTaskAlias = pgTable(
	"work_task_alias",
	{
		projectId: projectRef(),
		number: integer("number").notNull(),
		taskId: text("task_id")
			.notNull()
			.references(() => workTask.id, { onDelete: "cascade" }),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.projectId, t.number] })],
);

const taskRef = () =>
	text("task_id")
		.notNull()
		.references(() => workTask.id, { onDelete: "cascade" });
const userRef = () =>
	text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

export const workTaskAssignee = pgTable(
	"work_task_assignee",
	{
		taskId: taskRef(),
		userId: userRef(),
		assignedBy: userSetNull("assigned_by"),
		assignedAt: tstz("assigned_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.userId] }),
		index("work_task_assignee_user_idx").on(t.userId),
	],
);

/** Unwatching sets `muted` instead of deleting, so auto-watch doesn't re-add the user. */
export const workTaskWatcher = pgTable(
	"work_task_watcher",
	{
		taskId: taskRef(),
		userId: userRef(),
		reason: workWatchReason("reason").notNull(),
		muted: boolean("muted").notNull().default(false),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.userId] }),
		index("work_task_watcher_user_idx").on(t.userId),
	],
);

export const workTaskTag = pgTable(
	"work_task_tag",
	{
		taskId: taskRef(),
		tagId: text("tag_id")
			.notNull()
			.references(() => workTag.id, { onDelete: "cascade" }),
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.tagId] }),
		index("work_task_tag_tag_idx").on(t.tagId),
	],
);

export const workChecklistItem = pgTable(
	"work_checklist_item",
	{
		id: id("wci"),
		taskId: taskRef(),
		text: text("text").notNull(),
		done: boolean("done").notNull().default(false),
		doneBy: userSetNull("done_by"),
		doneAt: tstz("done_at"),
		assigneeId: userSetNull("assignee_id"),
		position: rank("position").notNull(),
		...timestamps,
	},
	(t) => [
		index("work_checklist_task_idx").on(t.taskId, t.position),
		check("work_checklist_text_check", sql`length(${t.text}) <= 500`),
	],
);

/** Finish-to-start; same project only (checked in the route). */
export const workDependency = pgTable(
	"work_dependency",
	{
		taskId: taskRef(),
		blockedById: text("blocked_by_id")
			.notNull()
			.references(() => workTask.id, { onDelete: "cascade" }),
		lagDays: integer("lag_days").notNull().default(0),
		createdBy: userSetNull("created_by"),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.blockedById] }),
		index("work_dependency_blocked_by_idx").on(t.blockedById),
		check("work_dependency_self_check", sql`${t.taskId} <> ${t.blockedById}`),
	],
);

// 4.3 Fields

export const workField = pgTable(
	"work_field",
	{
		id: id("wfd"),
		projectId: projectRef(),
		/** Null: every list of the project. */
		listId: text("list_id").references(() => workList.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		kind: workFieldKind("kind").notNull(),
		config: jsonb("config").$type<WorkFieldConfig>().notNull(),
		required: boolean("required").notNull().default(false),
		description: text("description"),
		position: rank("position").notNull(),
		...timestamps,
	},
	(t) => [
		uniqueIndex("work_field_name_idx").on(
			t.projectId,
			sql`coalesce(${t.listId}, '')`,
			sql`lower(${t.name})`,
		),
	],
);

/** Empty values are deleted, never stored. */
export const workFieldValue = pgTable(
	"work_field_value",
	{
		taskId: taskRef(),
		fieldId: text("field_id")
			.notNull()
			.references(() => workField.id, { onDelete: "cascade" }),
		value: jsonb("value").$type<unknown>().notNull(),
		updatedBy: userSetNull("updated_by"),
		updatedAt: tstz("updated_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.fieldId] }),
		index("work_field_value_field_idx").on(t.fieldId),
	],
);

// 4.4 Collaboration

export const workComment = pgTable(
	"work_comment",
	{
		id: id("wcm"),
		taskId: taskRef(),
		/** Null: "Former member". */
		authorId: userSetNull("author_id"),
		parentId: text("parent_id").references((): AnyPgColumn => workComment.id, {
			onDelete: "cascade",
		}),
		/** Cleared on delete; the row stays so threads keep their shape. */
		body: jsonb("body").$type<PmDoc>(),
		bodyText: text("body_text"),
		editedAt: tstz("edited_at"),
		deletedAt: tstz("deleted_at"),
		resolvedAt: tstz("resolved_at"),
		resolvedBy: userSetNull("resolved_by"),
		search: tsvector("search")
			.notNull()
			.generatedAlwaysAs(
				(): SQL =>
					sql`to_tsvector('simple', coalesce(${workComment.bodyText}, ''))`,
			),
		...timestamps,
	},
	(t) => [
		index("work_comment_task_idx").on(t.taskId, t.createdAt),
		index("work_comment_search_idx").using("gin", t.search),
	],
);

export const workReaction = pgTable(
	"work_reaction",
	{
		commentId: text("comment_id")
			.notNull()
			.references(() => workComment.id, { onDelete: "cascade" }),
		userId: userRef(),
		emoji: text("emoji").notNull(),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.commentId, t.userId, t.emoji] })],
);

/** User-facing history; never rich-text bodies. */
export const workActivity = pgTable(
	"work_activity",
	{
		id: id("wac"),
		taskId: taskRef(),
		actorId: userSetNull("actor_id"),
		kind: workActivityKind("kind").notNull(),
		data: jsonb("data")
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		createdAt: tstz("created_at").defaultNow().notNull(),
		/** Bumped when edits within 2 minutes collapse into this entry. */
		updatedAt: tstz("updated_at").defaultNow().notNull(),
	},
	(t) => [index("work_activity_task_idx").on(t.taskId, t.createdAt)],
);

export const workAttachment = pgTable(
	"work_attachment",
	{
		id: id("wat"),
		projectId: projectRef(),
		taskId: text("task_id").references(() => workTask.id, {
			onDelete: "cascade",
		}),
		commentId: text("comment_id").references(() => workComment.id, {
			onDelete: "cascade",
		}),
		inlineIn: workAttachmentInlineIn("inline_in").notNull().default("none"),
		uploaderId: userSetNull("uploader_id"),
		name: text("name").notNull(),
		contentType: text("content_type").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		sha256: text("sha256").notNull(),
		driver: workAttachmentDriver("driver").notNull().default("db"),
		/** `db`: the sha256; `s3`: `work/<orgId>/<sha256>`. */
		objectKey: text("object_key").notNull(),
		width: integer("width"),
		height: integer("height"),
		thumbKey: text("thumb_key"),
		deletedAt: tstz("deleted_at"),
		...timestamps,
	},
	(t) => [
		check(
			"work_attachment_owner_check",
			sql`${t.taskId} is not null or ${t.commentId} is not null`,
		),
		index("work_attachment_task_idx").on(t.taskId),
		index("work_attachment_comment_idx").on(t.commentId),
		index("work_attachment_project_idx").on(t.projectId),
		index("work_attachment_sha_idx").on(t.sha256),
		index("work_attachment_deleted_idx")
			.on(t.deletedAt)
			.where(sql`${t.deletedAt} is not null`),
	],
);

/** `db` driver blobs, deduplicated by content. */
export const workBlob = pgTable("work_blob", {
	sha256: text("sha256").primaryKey(),
	bytes: bytea("bytes").notNull(),
	size: bigint("size", { mode: "number" }).notNull(),
	refCount: integer("ref_count").notNull().default(1),
	createdAt: tstz("created_at").defaultNow().notNull(),
});

// 4.5 Views

export const workView = pgTable(
	"work_view",
	{
		id: id("wvw"),
		projectId: projectRef(),
		/** Null: the whole project. */
		listId: text("list_id").references(() => workList.id, {
			onDelete: "cascade",
		}),
		/** Null: shared. */
		ownerId: text("owner_id").references(() => user.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		kind: workViewKind("kind").notNull(),
		config: jsonb("config").$type<WorkViewConfig>().notNull(),
		position: rank("position").notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		...timestamps,
	},
	(t) => [
		index("work_view_project_idx").on(t.projectId, t.position),
		uniqueIndex("work_view_default_idx")
			.on(t.projectId, sql`coalesce(${t.listId}, '')`)
			.where(sql`${t.isDefault} and ${t.ownerId} is null`),
	],
);

// 4.6 Notifications

export const workNotification = pgTable(
	"work_notification",
	{
		id: id("wnt"),
		userId: userRef(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		taskId: taskRef(),
		commentId: text("comment_id").references(() => workComment.id, {
			onDelete: "cascade",
		}),
		actorId: userSetNull("actor_id"),
		kind: workNotificationKind("kind").notNull(),
		data: jsonb("data")
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** due_soon / overdue: the due date it fired for, so each fires once. */
		dueDate: date("due_date", { mode: "string" }),
		readAt: tstz("read_at"),
		emailedAt: tstz("emailed_at"),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("work_notification_inbox_idx").on(
			t.userId,
			t.readAt,
			t.createdAt.desc(),
		),
		index("work_notification_created_idx").on(t.createdAt),
		uniqueIndex("work_notification_due_idx")
			.on(t.userId, t.taskId, t.kind, t.dueDate)
			.where(sql`${t.dueDate} is not null`),
	],
);

export const workUserPrefs = pgTable(
	"work_user_prefs",
	{
		userId: userRef(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		email: workEmailMode("email").notNull().default("off"),
		emailKinds: text("email_kinds")
			.array()
			.notNull()
			.default(sql`'{assigned,mentioned,due_soon,overdue}'::text[]`),
		dailyHour: smallint("daily_hour").notNull().default(8),
		timezone: text("timezone"),
		icalTokenHash: text("ical_token_hash"),
		capacityHoursPerWeek: smallint("capacity_hours_per_week")
			.notNull()
			.default(32),
		...timestamps,
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.organizationId] }),
		uniqueIndex("work_user_prefs_ical_idx")
			.on(t.icalTokenHash)
			.where(sql`${t.icalTokenHash} is not null`),
	],
);

// 4.7 Phase 4

export const workTemplate = pgTable(
	"work_template",
	{
		id: id("wtp"),
		/** Null: a built-in template seeded per instance. */
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),
		/** Null: organization-wide. */
		projectId: text("project_id").references(() => project.id, {
			onDelete: "cascade",
		}),
		kind: workTemplateKind("kind").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		payload: jsonb("payload").$type<TemplatePayload>().notNull(),
		createdBy: userSetNull("created_by"),
		usageCount: integer("usage_count").notNull().default(0),
		...timestamps,
	},
	(t) => [index("work_template_org_idx").on(t.organizationId, t.projectId)],
);

export const workTimeEntry = pgTable(
	"work_time_entry",
	{
		id: id("wte"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: projectRef(),
		taskId: taskRef(),
		userId: userRef(),
		startedAt: tstz("started_at").notNull(),
		/** Null: running. */
		endedAt: tstz("ended_at"),
		durationSec: integer("duration_sec"),
		note: text("note"),
		billable: boolean("billable").notNull().default(true),
		source: workTimeEntrySource("source").notNull(),
		...timestamps,
	},
	(t) => [
		uniqueIndex("work_time_entry_running_idx")
			.on(t.userId)
			.where(sql`${t.endedAt} is null`),
		index("work_time_entry_project_idx").on(t.projectId, t.startedAt),
		index("work_time_entry_user_idx").on(t.userId, t.startedAt),
		index("work_time_entry_task_idx").on(t.taskId),
		check(
			"work_time_entry_note_check",
			sql`${t.note} is null or length(${t.note}) <= 500`,
		),
	],
);

export const workGitLink = pgTable(
	"work_git_link",
	{
		id: id("wgl"),
		taskId: taskRef(),
		providerId: text("provider_id")
			.notNull()
			.references(() => gitProvider.id, { onDelete: "cascade" }),
		repo: text("repo").notNull(),
		kind: workGitLinkKind("kind").notNull(),
		/** Sha, branch name or PR number. */
		ref: text("ref").notNull(),
		title: text("title"),
		url: text("url"),
		state: workGitLinkState("state").notNull(),
		/** Provider login or name, not a LogiStack user. */
		author: text("author"),
		...timestamps,
	},
	(t) => [
		unique("work_git_link_unique").on(
			t.taskId,
			t.providerId,
			t.repo,
			t.kind,
			t.ref,
		),
	],
);

export const workImport = pgTable(
	"work_import",
	{
		id: id("wim"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		kind: workImportKind("kind").notNull(),
		createdBy: userSetNull("created_by"),
		status: workImportStatus("status").notNull().default("draft"),
		/** `ClickUpImportConfig`/`CsvImportConfig` as JSON, envelope-encrypted; the token is wiped when the run ends. */
		configEncrypted: text("config_encrypted").$type<string>(),
		plan: jsonb("plan").$type<WorkImportPlan>(),
		progress:
			jsonb("progress").$type<
				Record<string, { phase: string; done: number; total: number }>
			>(),
		report: jsonb("report").$type<WorkImportReport>(),
		startedAt: tstz("started_at"),
		finishedAt: tstz("finished_at"),
		...timestamps,
	},
	(t) => [index("work_import_org_idx").on(t.organizationId, t.createdAt)],
);
/** Decrypted shape of `work_import.config_encrypted` for ClickUp runs. */
export type WorkImportClickUpConfig = ClickUpImportConfig;

/** Keyed by source, not by import, so a second import of the same workspace updates the same rows. */
export const workImportMap = pgTable(
	"work_import_map",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		source: text("source").notNull(),
		externalType: text("external_type").notNull(),
		externalId: text("external_id").notNull(),
		localId: text("local_id").notNull(),
		localType: text("local_type").notNull(),
		updatedAt: tstz("updated_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({
			columns: [t.organizationId, t.source, t.externalType, t.externalId],
		}),
	],
);

export const workShare = pgTable(
	"work_share",
	{
		id: id("wsh"),
		projectId: projectRef(),
		listId: text("list_id").references(() => workList.id, {
			onDelete: "cascade",
		}),
		viewId: text("view_id").references(() => workView.id, {
			onDelete: "cascade",
		}),
		/** sha256 of the 32-byte token; the token is shown once. */
		tokenHash: text("token_hash").notNull(),
		createdBy: userSetNull("created_by"),
		name: text("name").notNull(),
		showComments: boolean("show_comments").notNull().default(false),
		showAssignees: boolean("show_assignees").notNull().default(true),
		fieldIds: text("field_ids").array().notNull().default(sql`'{}'::text[]`),
		passwordHash: text("password_hash"),
		expiresAt: tstz("expires_at"),
		revokedAt: tstz("revoked_at"),
		lastViewedAt: tstz("last_viewed_at"),
		viewCount: integer("view_count").notNull().default(0),
		...timestamps,
	},
	(t) => [
		uniqueIndex("work_share_token_idx").on(t.tokenHash),
		index("work_share_project_idx").on(t.projectId),
		check(
			"work_share_target_check",
			sql`(${t.listId} is null) <> (${t.viewId} is null)`,
		),
	],
);

/** Scoped grants an invitation creates on acceptance (guests on one project, a developer on one folder…). */
export const invitationGrant = pgTable(
	"invitation_grant",
	{
		invitationId: text("invitation_id")
			.notNull()
			.references(() => invitation.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		scopeKind: text("scope_kind").$type<ScopeKind>().notNull(),
		scopeId: text("scope_id").notNull(),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.invitationId, t.scopeKind, t.scopeId] }),
		check(
			"invitation_grant_scope_kind_check",
			sql`${t.scopeKind} in ('organization', 'folder', 'project', 'environment', 'service')`,
		),
	],
);
