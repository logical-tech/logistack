import { z } from "zod";
import type { PermissionAction } from "./enums.ts";
import { ServiceIcon } from "./service-icon.ts";

/**
 * Work: project management on top of existing projects (docs/plans/project-management.md).
 * Timestamps in DTOs are ISO strings (JSON as sent), dates are `YYYY-MM-DD`.
 */

const IsoDate = z.iso.date();
const Timestamp = z.string();
const Id = z.string().min(1);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const workStatusCategories = [
	"backlog",
	"active",
	"done",
	"cancelled",
] as const;
export const WorkStatusCategory = z.enum(workStatusCategories);
export type WorkStatusCategory = z.infer<typeof WorkStatusCategory>;

export const workPriorities = [
	"urgent",
	"high",
	"normal",
	"low",
	"none",
] as const;
export const WorkPriority = z.enum(workPriorities);
export type WorkPriority = z.infer<typeof WorkPriority>;

export const workFieldKinds = [
	"text",
	"long_text",
	"number",
	"currency",
	"percent",
	"date",
	"checkbox",
	"select",
	"multi_select",
	"user",
	"url",
	"email",
	"phone",
	"rating",
] as const;
export const WorkFieldKind = z.enum(workFieldKinds);
export type WorkFieldKind = z.infer<typeof WorkFieldKind>;

export const workViewKinds = [
	"table",
	"board",
	"timeline",
	"calendar",
] as const;
export const WorkViewKind = z.enum(workViewKinds);
export type WorkViewKind = z.infer<typeof WorkViewKind>;

export const workNotificationKinds = [
	"assigned",
	"unassigned",
	"mentioned",
	"commented",
	"replied",
	"status_changed",
	"due_soon",
	"overdue",
	"checklist_assigned",
	"timer_running_long",
] as const;
export const WorkNotificationKind = z.enum(workNotificationKinds);
export type WorkNotificationKind = z.infer<typeof WorkNotificationKind>;

export const workActivityKinds = [
	"created",
	"status",
	"assignee_added",
	"assignee_removed",
	"dates",
	"priority",
	"list_moved",
	"project_moved",
	"field",
	"tag_added",
	"tag_removed",
	"dependency_added",
	"dependency_removed",
	"attachment_added",
	"attachment_removed",
	"archived",
	"restored",
	"checklist",
	"git_linked",
	"git_closed",
	"imported",
	"recurred",
	/** Title, description, estimate or milestone edits ("description edited", never the text). */
	"edited",
] as const;
export const WorkActivityKind = z.enum(workActivityKinds);
export type WorkActivityKind = z.infer<typeof WorkActivityKind>;

/** The six-word health vocabulary a project manager sees (section 6). */
export const workHealthStates = [
	"operational",
	"degraded",
	"down",
	"maintenance",
	"paused",
	"unknown",
] as const;
export const WorkHealth = z.enum(workHealthStates);
export type WorkHealth = z.infer<typeof WorkHealth>;

export const workGitLinkKinds = ["commit", "branch", "pull_request"] as const;
export const WorkGitLinkKind = z.enum(workGitLinkKinds);
export type WorkGitLinkKind = z.infer<typeof WorkGitLinkKind>;

export const workGitLinkStates = [
	"open",
	"merged",
	"closed",
	"pushed",
] as const;
export const WorkGitLinkState = z.enum(workGitLinkStates);
export type WorkGitLinkState = z.infer<typeof WorkGitLinkState>;

export const workImportKinds = ["clickup", "csv"] as const;
export const WorkImportKind = z.enum(workImportKinds);
export type WorkImportKind = z.infer<typeof WorkImportKind>;

export const workImportStatuses = [
	"draft",
	"ready",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export const WorkImportStatus = z.enum(workImportStatuses);
export type WorkImportStatus = z.infer<typeof WorkImportStatus>;

export const workTimeEntrySources = ["timer", "manual", "import"] as const;
export const WorkTimeEntrySource = z.enum(workTimeEntrySources);
export type WorkTimeEntrySource = z.infer<typeof WorkTimeEntrySource>;

export const workAttachmentDrivers = ["db", "s3"] as const;
export const WorkAttachmentDriver = z.enum(workAttachmentDrivers);
export type WorkAttachmentDriver = z.infer<typeof WorkAttachmentDriver>;

export const workAttachmentInline = ["description", "comment", "none"] as const;
export const WorkAttachmentInline = z.enum(workAttachmentInline);
export type WorkAttachmentInline = z.infer<typeof WorkAttachmentInline>;

export const workWatchReasons = [
	"creator",
	"assignee",
	"mention",
	"comment",
	"manual",
] as const;
export const WorkWatchReason = z.enum(workWatchReasons);
export type WorkWatchReason = z.infer<typeof WorkWatchReason>;

export const workEmailModes = ["off", "instant", "daily"] as const;
export const WorkEmailMode = z.enum(workEmailModes);
export type WorkEmailMode = z.infer<typeof WorkEmailMode>;

export const workTemplateKinds = ["task", "list", "project"] as const;
export const WorkTemplateKind = z.enum(workTemplateKinds);
export type WorkTemplateKind = z.infer<typeof WorkTemplateKind>;

/** Palette tokens; never raw hex, so both themes stay coherent. */
export const workColors = [
	"gray",
	"blue",
	"amber",
	"green",
	"red",
	"violet",
	"pink",
	"teal",
] as const;
export const WorkColor = z.enum(workColors);
export type WorkColor = z.infer<typeof WorkColor>;

/** The fixed reaction set: no emoji picker in v1. */
export const workReactions = [
	"👍",
	"👎",
	"🎉",
	"❤️",
	"😄",
	"😕",
	"👀",
	"🚀",
] as const;
export const WorkReaction = z.enum(workReactions);
export type WorkReaction = z.infer<typeof WorkReaction>;

export const dueBuckets = [
	"overdue",
	"today",
	"tomorrow",
	"this_week",
	"next_week",
	"later",
	"none",
] as const;
export const DueBucket = z.enum(dueBuckets);
export type DueBucket = z.infer<typeof DueBucket>;

/** Mon=1 … Sun=64; Mon–Fri = 31. */
export const WorkingDays = z.number().int().min(1).max(127);

export const WorkKey = z
	.string()
	.regex(
		/^[A-Z][A-Z0-9]{1,9}$/,
		"2–10 letters or digits, starting with a letter",
	);

// ---------------------------------------------------------------------------
// Rich text (ProseMirror JSON, loose shape; core `sanitizeDoc` enforces the allow-list)
// ---------------------------------------------------------------------------

export type PmMark = { type: string; attrs?: Record<string, unknown> };
export type PmNode = {
	type: string;
	attrs?: Record<string, unknown>;
	content?: PmNode[];
	marks?: PmMark[];
	text?: string;
};
export type PmDoc = PmNode & { type: "doc" };

export const PmMark: z.ZodType<PmMark> = z.object({
	type: z.string(),
	attrs: z.record(z.string(), z.unknown()).optional(),
});
export const PmNode: z.ZodType<PmNode> = z
	.lazy(
		() =>
			z.object({
				type: z.string(),
				attrs: z.record(z.string(), z.unknown()).optional(),
				content: z.array(PmNode).optional(),
				marks: z.array(PmMark).optional(),
				text: z.string().optional(),
			}),
		// A named schema: OpenAPI generators emit a `$ref` instead of recursing forever.
	)
	.meta({ id: "PmNode" });

const sizedDoc = (maxBytes: number) =>
	z
		.object({
			type: z.literal("doc"),
			content: z.array(PmNode).optional(),
			attrs: z.record(z.string(), z.unknown()).optional(),
		})
		.refine(
			(d) => new TextEncoder().encode(JSON.stringify(d)).length <= maxBytes,
			`document larger than ${Math.round(maxBytes / 1000)} KB`,
		) as unknown as z.ZodType<PmDoc>;

export const WORK_DESCRIPTION_MAX_BYTES = 200_000;
export const WORK_COMMENT_MAX_BYTES = 50_000;
/** A task or list description. */
export const RichDoc = sizedDoc(WORK_DESCRIPTION_MAX_BYTES);
/** A comment body. */
export const CommentDoc = sizedDoc(WORK_COMMENT_MAX_BYTES);

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export const WorkSelectOption = z.object({
	id: z.string().min(1).max(64),
	label: z.string().trim().min(1).max(100),
	color: WorkColor,
});
export type WorkSelectOption = z.infer<typeof WorkSelectOption>;

const SelectOptions = z
	.array(WorkSelectOption)
	.max(200)
	.refine(
		(o) => new Set(o.map((x) => x.id)).size === o.length,
		"option ids must be unique",
	);

export const WorkFieldConfig = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("text"),
		maxLength: z.number().int().min(1).max(2000).optional(),
	}),
	z.object({ kind: z.literal("long_text") }),
	z.object({
		kind: z.literal("number"),
		decimals: z.number().int().min(0).max(6).default(0),
		min: z.number().optional(),
		max: z.number().optional(),
		unit: z.string().max(16).optional(),
	}),
	z.object({
		kind: z.literal("currency"),
		currency: z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code"),
		decimals: z.number().int().min(0).max(6).default(2),
	}),
	z.object({
		kind: z.literal("percent"),
		decimals: z.number().int().min(0).max(6).default(0),
	}),
	z.object({ kind: z.literal("date"), withTime: z.boolean().default(false) }),
	z.object({ kind: z.literal("checkbox") }),
	z.object({ kind: z.literal("select"), options: SelectOptions }),
	z.object({ kind: z.literal("multi_select"), options: SelectOptions }),
	z.object({ kind: z.literal("user"), multiple: z.boolean().default(false) }),
	z.object({ kind: z.literal("url") }),
	z.object({ kind: z.literal("email") }),
	z.object({ kind: z.literal("phone") }),
	z.object({
		kind: z.literal("rating"),
		max: z.number().int().min(3).max(10).default(5),
		icon: z.enum(["star", "flame", "heart"]).default("star"),
	}),
]);
export type WorkFieldConfig = z.infer<typeof WorkFieldConfig>;

/** Stored value shape per kind (bounds that depend on config are checked by core `parseFieldValue`). */
export const workFieldValueSchemas = {
	text: z.string().max(2000),
	long_text: z.string().max(20_000),
	number: z.number(),
	/** Decimal as a string, so precision survives ("1234.50"). */
	currency: z.string().regex(/^-?\d+(\.\d+)?$/),
	percent: z.number().min(0).max(100),
	date: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
	checkbox: z.boolean(),
	select: z.string(),
	multi_select: z.array(z.string()),
	user: z.union([z.string(), z.array(z.string())]),
	url: z.url({ protocol: /^https?$/ }).max(2048),
	email: z.email().max(320),
	phone: z.string().max(40),
	rating: z.number().int().min(0).max(10),
} as const satisfies Record<WorkFieldKind, z.ZodType>;
export type WorkFieldValueOf<K extends WorkFieldKind> = z.infer<
	(typeof workFieldValueSchemas)[K]
>;
export type WorkFieldValue = WorkFieldValueOf<WorkFieldKind>;

export const WorkField = z.object({
	id: Id,
	projectId: Id,
	/** Null: every list of the project. */
	listId: z.string().nullable(),
	name: z.string(),
	kind: WorkFieldKind,
	config: WorkFieldConfig,
	required: z.boolean(),
	description: z.string().nullable(),
	position: z.string(),
});
export type WorkField = z.infer<typeof WorkField>;

/** The kind comes from `config.kind` and can't change afterwards. */
export const WorkFieldCreate = z.object({
	name: z.string().trim().min(1).max(100),
	listId: z.string().nullable().optional(),
	config: WorkFieldConfig,
	required: z.boolean().optional(),
	description: z.string().max(500).nullable().optional(),
});
export type WorkFieldCreate = z.infer<typeof WorkFieldCreate>;
export const WorkFieldPatch = WorkFieldCreate.partial().omit({ listId: true });
export type WorkFieldPatch = z.infer<typeof WorkFieldPatch>;

// ---------------------------------------------------------------------------
// Filter language (section 7)
// ---------------------------------------------------------------------------

export const filterBuiltinKeys = [
	"status",
	"statusCategory",
	"assignee",
	"priority",
	"list",
	"tag",
	"startDate",
	"dueDate",
	"createdAt",
	"updatedAt",
	"completedAt",
	"createdBy",
	"text",
	"parent",
	"isMilestone",
	"blocked",
] as const;
export type FieldRef = `field:${string}`;
export const FieldRef = z.templateLiteral(["field:", z.string().min(1)]);
export const FilterKey = z.union([z.enum(filterBuiltinKeys), FieldRef]);
export type FilterKey = z.infer<typeof FilterKey>;

export const filterOps = [
	"is",
	"is_not",
	"any_of",
	"none_of",
	"all_of",
	"empty",
	"not_empty",
	"contains",
	"eq",
	"neq",
	"lt",
	"lte",
	"gt",
	"gte",
	"between",
	"before",
	"after",
	"on",
	"relative",
] as const;
export const FilterOp = z.enum(filterOps);
export type FilterOp = z.infer<typeof FilterOp>;

export const relativeDates = [
	"today",
	"yesterday",
	"tomorrow",
	"this_week",
	"last_week",
	"next_week",
	"this_month",
	"next_7_days",
	"last_7_days",
	"next_30_days",
	"overdue",
	"no_date",
] as const;
export const RelativeDate = z.enum(relativeDates);
export type RelativeDate = z.infer<typeof RelativeDate>;

export type FilterCondition = { key: FilterKey; op: FilterOp; value?: unknown };
export type FilterNode =
	| { and: FilterNode[] }
	| { or: FilterNode[] }
	| FilterCondition;

export const FilterCondition = z.object({
	key: FilterKey,
	op: FilterOp,
	value: z.unknown().optional(),
});
/** Shape only; core `validateFilter` checks keys/ops/values against fields, depth ≤ 4 and ≤ 30 conditions. */
export const FilterNode: z.ZodType<FilterNode> = z.lazy(() =>
	z.union([
		z.object({ and: z.array(FilterNode).max(30) }),
		z.object({ or: z.array(FilterNode).max(30) }),
		FilterCondition,
	]),
);
export const FILTER_MAX_DEPTH = 4;
export const FILTER_MAX_CONDITIONS = 30;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const workSortKeys = [
	"position",
	"number",
	"title",
	"status",
	"priority",
	"startDate",
	"dueDate",
	"createdAt",
	"updatedAt",
	"completedAt",
	"estimate",
] as const;
export const SortKey = z.union([z.enum(workSortKeys), FieldRef]);
export type SortKey = z.infer<typeof SortKey>;

export const workGroupKeys = [
	"status",
	"priority",
	"assignee",
	"list",
	"tag",
	"dueBucket",
] as const;
export const GroupKey = z.union([z.enum(workGroupKeys), FieldRef]);
export type GroupKey = z.infer<typeof GroupKey>;

export const workColumnKeys = [
	"key",
	"title",
	"status",
	"assignees",
	"priority",
	"startDate",
	"dueDate",
	"tags",
	"list",
	"estimate",
	"tracked",
	"createdAt",
	"updatedAt",
] as const;
export const ColumnKey = z.union([z.enum(workColumnKeys), FieldRef]);
export type ColumnKey = z.infer<typeof ColumnKey>;

export const WorkSort = z.object({
	by: SortKey,
	dir: z.enum(["asc", "desc"]),
});
export type WorkSort = z.infer<typeof WorkSort>;

export const WorkViewConfig = z.object({
	filter: FilterNode.nullable().default(null),
	sort: z.array(WorkSort).max(3).default([]),
	groupBy: GroupKey.nullable().default(null),
	subGroupBy: GroupKey.nullable().default(null),
	columns: z
		.array(
			z.object({
				key: ColumnKey,
				width: z.number().int().min(40).max(1200).optional(),
				hidden: z.boolean().optional(),
			}),
		)
		.max(150)
		.default([]),
	cardFields: z.array(ColumnKey).max(6).default([]),
	showSubtasks: z.enum(["nested", "flat", "hidden"]).default("nested"),
	showClosed: z.boolean().default(false),
	timeline: z
		.object({
			zoom: z.enum(["day", "week", "month", "quarter"]),
			rowsBy: z.enum(["list", "assignee", "none"]),
			showDependencies: z.boolean(),
			showWeekends: z.boolean(),
		})
		.default({
			zoom: "week",
			rowsBy: "list",
			showDependencies: true,
			showWeekends: true,
		}),
	calendar: z
		.object({
			mode: z.enum(["month", "week"]),
			dateField: z.union([z.enum(["due", "span"]), FieldRef]),
		})
		.default({ mode: "month", dateField: "due" }),
	collapsedGroups: z.array(z.string()).max(500).default([]),
});
export type WorkViewConfig = z.infer<typeof WorkViewConfig>;
export type WorkViewConfigInput = z.input<typeof WorkViewConfig>;

export const WorkView = z.object({
	id: Id,
	projectId: Id,
	listId: z.string().nullable(),
	/** Null: shared with the project. */
	ownerId: z.string().nullable(),
	name: z.string(),
	kind: WorkViewKind,
	config: WorkViewConfig,
	position: z.string(),
	isDefault: z.boolean(),
});
export type WorkView = z.infer<typeof WorkView>;

export const WorkViewCreate = z.object({
	name: z.string().trim().min(1).max(100),
	kind: WorkViewKind,
	listId: z.string().nullable().optional(),
	/** Personal views need only `work`; shared ones `work:admin`. */
	shared: z.boolean().default(false),
	config: WorkViewConfig.partial().optional(),
	isDefault: z.boolean().optional(),
});
export type WorkViewCreate = z.input<typeof WorkViewCreate>;
export const WorkViewPatch = z.object({
	name: z.string().trim().min(1).max(100).optional(),
	config: WorkViewConfig.partial().optional(),
	isDefault: z.boolean().optional(),
});
export type WorkViewPatch = z.input<typeof WorkViewPatch>;

/** Any reorder: the full id list in the new order. */
export const WorkOrder = z.object({ ids: z.array(Id).min(1).max(500) });
export type WorkOrder = z.infer<typeof WorkOrder>;

// ---------------------------------------------------------------------------
// Recurrence and templates (phase 4)
// ---------------------------------------------------------------------------

const Weekday = z.number().int().min(0).max(6);
export const RecurrenceRule = z.object({
	freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
	interval: z.number().int().min(1).max(365),
	/** 0 = Sunday … 6 = Saturday (JS `getUTCDay`). */
	byWeekday: z.array(Weekday).max(7).optional(),
	monthly: z
		.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("dayOfMonth"),
				day: z.union([z.number().int().min(1).max(31), z.literal(-1)]),
			}),
			z.object({
				kind: z.literal("nthWeekday"),
				n: z.union([z.number().int().min(1).max(4), z.literal(-1)]),
				weekday: Weekday,
			}),
		])
		.optional(),
	mode: z.enum(["on_complete", "on_schedule"]),
	createDaysBefore: z.number().int().min(0).max(365).optional(),
	ends: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("never") }),
		z.object({ kind: z.literal("on"), date: IsoDate }),
		z.object({
			kind: z.literal("after"),
			count: z.number().int().min(1).max(1000),
		}),
	]),
	/** With `ends.kind = "after"`: occurrences still to create. */
	remaining: z.number().int().min(0).optional(),
	copy: z.object({
		subtasks: z.boolean(),
		checklist: z.boolean(),
		fields: z.boolean(),
		assignees: z.boolean(),
		description: z.boolean(),
	}),
	skipWeekends: z.boolean().optional(),
});
export type RecurrenceRule = z.infer<typeof RecurrenceRule>;

export const TemplateAssigneeRef = z.union([
	z.literal("creator"),
	z.object({ userId: Id }),
	z.object({ placeholder: z.string().min(1).max(60) }),
]);
export type TemplateAssigneeRef = z.infer<typeof TemplateAssigneeRef>;

export type TaskTemplate = {
	title: string;
	description: PmDoc | null;
	priority: WorkPriority;
	/** Working days from the anchor. */
	startOffset?: number;
	dueOffset?: number;
	isMilestone: boolean;
	estimateMinutes: number | null;
	/** Template-local status id (project templates) or a status name. */
	statusRef: string | null;
	tagRefs: string[];
	fieldValues: { fieldRef: string; value: unknown }[];
	assigneeRefs: TemplateAssigneeRef[];
	checklist: { text: string; assigneeRef?: TemplateAssigneeRef }[];
	subtasks: TaskTemplate[];
	attachmentShas: string[];
	/** Indexes into the same `tasks` array. */
	dependsOn: number[];
};
export const TaskTemplate: z.ZodType<TaskTemplate> = z.lazy(() =>
	z.object({
		title: z.string().min(1).max(500),
		description: RichDoc.nullable(),
		priority: WorkPriority,
		startOffset: z.number().int().optional(),
		dueOffset: z.number().int().optional(),
		isMilestone: z.boolean(),
		estimateMinutes: z.number().int().min(0).nullable(),
		statusRef: z.string().nullable(),
		tagRefs: z.array(z.string()),
		fieldValues: z.array(
			z.object({ fieldRef: z.string(), value: z.unknown() }),
		),
		assigneeRefs: z.array(TemplateAssigneeRef),
		checklist: z.array(
			z.object({
				text: z.string().max(500),
				assigneeRef: TemplateAssigneeRef.optional(),
			}),
		),
		subtasks: z.array(TaskTemplate).max(200),
		attachmentShas: z.array(z.string()),
		dependsOn: z.array(z.number().int().min(0)),
	}),
);

export const TemplatePayload = z.object({
	statuses: z
		.array(
			z.object({
				ref: z.string(),
				name: z.string(),
				color: WorkColor,
				category: WorkStatusCategory,
				wipLimit: z.number().int().nullable().optional(),
			}),
		)
		.optional(),
	fields: z
		.array(
			z.object({
				ref: z.string(),
				name: z.string(),
				config: WorkFieldConfig,
				required: z.boolean().optional(),
				description: z.string().nullable().optional(),
			}),
		)
		.optional(),
	tags: z
		.array(z.object({ ref: z.string(), name: z.string(), color: WorkColor }))
		.optional(),
	views: z
		.array(
			z.object({
				name: z.string(),
				kind: WorkViewKind,
				config: WorkViewConfig.partial(),
			}),
		)
		.optional(),
	lists: z
		.array(
			z.object({
				name: z.string(),
				color: WorkColor.nullable().optional(),
				icon: z.string().nullable().optional(),
				tasks: z.array(TaskTemplate),
			}),
		)
		.optional(),
	tasks: z.array(TaskTemplate).optional(),
});
export type TemplatePayload = z.infer<typeof TemplatePayload>;

// ---------------------------------------------------------------------------
// Projects, settings, health
// ---------------------------------------------------------------------------

export const WorkProjectListItem = z.object({
	id: Id,
	name: z.string(),
	/** Folder names, outermost first. */
	folderPath: z.array(z.string()),
	key: WorkKey,
	health: WorkHealth,
	since: Timestamp.nullable(),
	/** False when the project has no environments ("No services"). */
	hasServices: z.boolean(),
	counts: z.object({
		open: z.number().int(),
		overdue: z.number().int(),
		mine: z.number().int(),
		doneThisWeek: z.number().int(),
	}),
	archived: z.boolean(),
});
export type WorkProjectListItem = z.infer<typeof WorkProjectListItem>;

export const WorkRepo = z.object({ providerId: Id, repo: z.string().min(1) });
export type WorkRepo = z.infer<typeof WorkRepo>;

export const WorkProject = z.object({
	projectId: Id,
	name: z.string(),
	key: WorkKey,
	workingDays: WorkingDays,
	timeTracking: z.boolean(),
	allowShareLinks: z.boolean(),
	guestsAssignable: z.boolean(),
	guestsCanCreate: z.boolean(),
	defaultListId: z.string().nullable(),
	closingStatusId: z.string().nullable(),
	timeLockedBefore: IsoDate.nullable(),
	archived: z.boolean(),
	/** Present only for `work:admin`. */
	hiddenServiceIds: z.array(z.string()).optional(),
	/** Present only for `work:admin`. */
	repos: z.array(WorkRepo).optional(),
});
export type WorkProject = z.infer<typeof WorkProject>;

export const WorkProjectSettingsPatch = z.object({
	key: WorkKey.optional(),
	hiddenServiceIds: z.array(Id).max(500).optional(),
	workingDays: WorkingDays.optional(),
	defaultListId: Id.nullable().optional(),
	closingStatusId: Id.nullable().optional(),
	repos: z.array(WorkRepo).max(50).optional(),
	guestsAssignable: z.boolean().optional(),
	guestsCanCreate: z.boolean().optional(),
	allowShareLinks: z.boolean().optional(),
	timeTracking: z.boolean().optional(),
	timeLockedBefore: IsoDate.nullable().optional(),
});
export type WorkProjectSettingsPatch = z.infer<typeof WorkProjectSettingsPatch>;

/** Section 6.3. The route test asserts this exact key set: add keys deliberately. */
export const WorkServiceHealth = z.object({
	id: Id,
	name: z.string(),
	icon: ServiceIcon.nullable(),
	health: WorkHealth,
	since: Timestamp.nullable(),
	uptime30d: z.number().nullable(),
	days: z.array(z.object({ date: IsoDate, health: WorkHealth })).nullable(),
	url: z.string().nullable(),
});
export type WorkServiceHealth = z.infer<typeof WorkServiceHealth>;
export const ProjectHealth = z.object({
	health: WorkHealth,
	since: Timestamp.nullable(),
	services: z.array(WorkServiceHealth),
});
export type ProjectHealth = z.infer<typeof ProjectHealth>;

export const WorkProjectSummary = z.object({
	total: z.number().int(),
	byStatus: z.array(z.object({ statusId: Id, count: z.number().int() })),
	byCategory: z.record(WorkStatusCategory, z.number().int()),
	byAssignee: z.array(
		z.object({
			/** Null: unassigned. */
			userId: z.string().nullable(),
			open: z.number().int(),
			done: z.number().int(),
		}),
	),
	overdue: z.number().int(),
	/** Last 12 weeks, oldest first; `weekStart` is a Monday. */
	completedPerWeek: z.array(
		z.object({ weekStart: IsoDate, count: z.number().int() }),
	),
	lists: z.number().int(),
	attachments: z.number().int(),
});
export type WorkProjectSummary = z.infer<typeof WorkProjectSummary>;

export const WorkPerson = z.object({
	userId: Id,
	name: z.string(),
	email: z.string().optional(),
	avatar: z.string().nullable(),
	/** Holds `work` (or is a guest on a project with `guestsAssignable`). */
	assignable: z.boolean(),
	guest: z.boolean(),
});
export type WorkPerson = z.infer<typeof WorkPerson>;

/** For the hidden-services picker: names only. */
export const WorkServiceName = z.object({ id: Id, name: z.string() });
export type WorkServiceName = z.infer<typeof WorkServiceName>;

// ---------------------------------------------------------------------------
// Structure: statuses, lists, tags
// ---------------------------------------------------------------------------

export const WorkStatus = z.object({
	id: Id,
	projectId: Id,
	name: z.string(),
	color: WorkColor,
	category: WorkStatusCategory,
	position: z.string(),
	wipLimit: z.number().int().nullable(),
});
export type WorkStatus = z.infer<typeof WorkStatus>;
export const WorkStatusCreate = z.object({
	name: z.string().trim().min(1).max(60),
	color: WorkColor,
	category: WorkStatusCategory,
	wipLimit: z.number().int().min(1).max(1000).nullable().optional(),
});
export type WorkStatusCreate = z.infer<typeof WorkStatusCreate>;
export const WorkStatusPatch = WorkStatusCreate.partial();
export type WorkStatusPatch = z.infer<typeof WorkStatusPatch>;

export const WorkList = z.object({
	id: Id,
	projectId: Id,
	name: z.string(),
	description: RichDoc.nullable(),
	color: WorkColor.nullable(),
	icon: z.string().nullable(),
	position: z.string(),
	archivedAt: Timestamp.nullable(),
	/** Open (not done/cancelled, not archived) top-level tasks. */
	openCount: z.number().int().optional(),
});
export type WorkList = z.infer<typeof WorkList>;
export const WorkListCreate = z.object({
	name: z.string().trim().min(1).max(100),
	description: RichDoc.nullable().optional(),
	color: WorkColor.nullable().optional(),
	icon: z.string().max(64).nullable().optional(),
});
export type WorkListCreate = z.infer<typeof WorkListCreate>;
export const WorkListPatch = WorkListCreate.partial();
export type WorkListPatch = z.infer<typeof WorkListPatch>;

export const WorkTag = z.object({
	id: Id,
	projectId: Id,
	name: z.string(),
	color: WorkColor,
});
export type WorkTag = z.infer<typeof WorkTag>;
export const WorkTagCreate = z.object({
	name: z.string().trim().min(1).max(60),
	color: WorkColor.default("gray"),
});
export type WorkTagCreate = z.input<typeof WorkTagCreate>;
export const WorkTagPatch = z.object({
	name: z.string().trim().min(1).max(60).optional(),
	color: WorkColor.optional(),
});
export type WorkTagPatch = z.infer<typeof WorkTagPatch>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const WorkTaskSource = z.object({
	kind: z.enum(["clickup", "csv", "template"]),
	externalId: z.string().optional(),
	url: z.string().optional(),
});
export type WorkTaskSource = z.infer<typeof WorkTaskSource>;

export const WorkTaskCounts = z.object({
	subtasks: z.number().int(),
	subtasksDone: z.number().int(),
	checklist: z.number().int(),
	checklistDone: z.number().int(),
	comments: z.number().int(),
	attachments: z.number().int(),
});
export type WorkTaskCounts = z.infer<typeof WorkTaskCounts>;

/** A row in lists, boards, timelines. Optional parts depend on `include`. */
export const WorkTaskListItem = z.object({
	id: Id,
	projectId: Id,
	listId: Id,
	parentId: z.string().nullable(),
	number: z.number().int(),
	/** `SHOP-42`. */
	key: z.string(),
	title: z.string(),
	statusId: Id,
	priority: WorkPriority,
	startDate: IsoDate.nullable(),
	dueDate: IsoDate.nullable(),
	/** `HH:MM`, only with dueDate, in the org timezone. */
	dueTime: z.string().nullable(),
	isMilestone: z.boolean(),
	estimateMinutes: z.number().int().nullable(),
	position: z.string(),
	recurring: z.boolean(),
	createdBy: z.string().nullable(),
	completedAt: Timestamp.nullable(),
	archivedAt: Timestamp.nullable(),
	createdAt: Timestamp,
	updatedAt: Timestamp,
	assigneeIds: z.array(z.string()).optional(),
	tagIds: z.array(z.string()).optional(),
	/** fieldId → value. */
	fields: z.record(z.string(), z.unknown()).optional(),
	counts: WorkTaskCounts.optional(),
	blocked: z.boolean().optional(),
	/** Seconds tracked (phase 4), with `include=counts`. */
	trackedSec: z.number().int().optional(),
});
export type WorkTaskListItem = z.infer<typeof WorkTaskListItem>;

export const WorkTaskRef = z.object({
	id: Id,
	key: z.string(),
	title: z.string(),
	statusId: Id,
	projectId: Id,
});
export type WorkTaskRef = z.infer<typeof WorkTaskRef>;

export const WorkChecklistItem = z.object({
	id: Id,
	taskId: Id,
	text: z.string(),
	done: z.boolean(),
	doneBy: z.string().nullable(),
	doneAt: Timestamp.nullable(),
	assigneeId: z.string().nullable(),
	position: z.string(),
});
export type WorkChecklistItem = z.infer<typeof WorkChecklistItem>;
export const WorkChecklistCreate = z.object({
	text: z.string().trim().min(1).max(500),
	assigneeId: Id.nullable().optional(),
	after: Id.optional(),
});
export type WorkChecklistCreate = z.infer<typeof WorkChecklistCreate>;
export const WorkChecklistPatch = z.object({
	text: z.string().trim().min(1).max(500).optional(),
	done: z.boolean().optional(),
	assigneeId: Id.nullable().optional(),
	before: Id.optional(),
	after: Id.optional(),
});
export type WorkChecklistPatch = z.infer<typeof WorkChecklistPatch>;

export const WorkDependencyEdge = WorkTaskRef.extend({
	lagDays: z.number().int(),
	/** The blocker's status is `done` or `cancelled`. */
	done: z.boolean(),
});
export type WorkDependencyEdge = z.infer<typeof WorkDependencyEdge>;
export const WorkDependencyCreate = z.object({
	blockedById: Id,
	lagDays: z.number().int().min(-365).max(365).default(0),
});
export type WorkDependencyCreate = z.input<typeof WorkDependencyCreate>;

export const WorkAttachment = z.object({
	id: Id,
	projectId: Id,
	taskId: z.string().nullable(),
	commentId: z.string().nullable(),
	inlineIn: WorkAttachmentInline,
	uploaderId: z.string().nullable(),
	name: z.string(),
	contentType: z.string(),
	size: z.number().int(),
	width: z.number().int().nullable(),
	height: z.number().int().nullable(),
	/** `/api/work/attachments/<id>`. */
	url: z.string(),
	thumbUrl: z.string().nullable(),
	createdAt: Timestamp,
});
export type WorkAttachment = z.infer<typeof WorkAttachment>;

export const WorkGitLink = z.object({
	id: Id,
	taskId: Id,
	providerId: Id,
	repo: z.string(),
	kind: WorkGitLinkKind,
	ref: z.string(),
	title: z.string().nullable(),
	url: z.string().nullable(),
	state: WorkGitLinkState,
	author: z.string().nullable(),
	createdAt: Timestamp,
	updatedAt: Timestamp,
});
export type WorkGitLink = z.infer<typeof WorkGitLink>;
export const WorkGitSummary = z.object({
	pullRequests: z.object({ open: z.number().int(), merged: z.number().int() }),
	commits: z.number().int(),
});
export type WorkGitSummary = z.infer<typeof WorkGitSummary>;
/** Full links only for actors that also hold `read` on the project (12.4). */
export const WorkTaskGit = z.union([
	z.object({ links: z.array(WorkGitLink) }),
	z.object({ summary: WorkGitSummary }),
]);
export type WorkTaskGit = z.infer<typeof WorkTaskGit>;

export const WorkWatcher = z.object({
	userId: Id,
	reason: WorkWatchReason,
	muted: z.boolean(),
});
export type WorkWatcher = z.infer<typeof WorkWatcher>;

export const WorkTask = WorkTaskListItem.extend({
	description: RichDoc.nullable(),
	descriptionText: z.string().nullable(),
	assigneeIds: z.array(z.string()),
	tagIds: z.array(z.string()),
	fields: z.record(z.string(), z.unknown()),
	counts: WorkTaskCounts,
	blocked: z.boolean(),
	watchers: z.array(WorkWatcher),
	/** The current actor watches (and hasn't muted). */
	watching: z.boolean(),
	parent: WorkTaskRef.nullable(),
	subtasks: z.array(WorkTaskListItem),
	checklist: z.array(WorkChecklistItem),
	dependencies: z.object({
		blockedBy: z.array(WorkDependencyEdge),
		blocking: z.array(WorkDependencyEdge),
	}),
	attachments: z.array(WorkAttachment),
	recurrence: RecurrenceRule.nullable(),
	recurrenceSeriesId: z.string().nullable(),
	source: WorkTaskSource.nullable(),
	git: WorkTaskGit.nullable(),
});
export type WorkTask = z.infer<typeof WorkTask>;

export const workTaskIncludes = [
	"fields",
	"assignees",
	"tags",
	"counts",
] as const;

/** Query of `GET /api/work/tasks`. Arrays and the filter arrive as JSON strings. */
export const WorkTaskListQuery = z.object({
	projectId: Id.optional(),
	assignee: z.literal("me").optional(),
	listId: Id.optional(),
	viewId: Id.optional(),
	/** JSON FilterNode, ANDed with the view's. */
	filter: z.string().optional(),
	/** JSON `WorkSort[]`. */
	sort: z.string().optional(),
	groupBy: GroupKey.optional(),
	/** One group's page (board columns). */
	group: z.string().optional(),
	parentId: Id.optional(),
	topLevel: z.enum(["true", "false"]).optional(),
	/** Comma-separated `workTaskIncludes`. */
	include: z.string().optional(),
	includeClosed: z.enum(["true", "false"]).optional(),
	includeArchived: z.enum(["true", "false"]).optional(),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).optional(),
	format: z.enum(["json", "csv"]).optional(),
});
export type WorkTaskListQuery = z.input<typeof WorkTaskListQuery>;

export const WorkTaskPage = z.object({
	items: z.array(WorkTaskListItem),
	nextCursor: z.string().nullable(),
	/** Only when cheap (no free text). */
	total: z.number().int().optional(),
});
export type WorkTaskPage = z.infer<typeof WorkTaskPage>;

const Position = z.object({ before: Id.optional(), after: Id.optional() });
const DueTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const WorkTaskCreate = Position.extend({
	listId: Id,
	title: z.string().trim().min(1).max(500),
	parentId: Id.nullable().optional(),
	statusId: Id.optional(),
	assignees: z.array(Id).max(20).optional(),
	priority: WorkPriority.optional(),
	startDate: IsoDate.nullable().optional(),
	dueDate: IsoDate.nullable().optional(),
	dueTime: DueTime.nullable().optional(),
	isMilestone: z.boolean().optional(),
	estimateMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
	description: RichDoc.nullable().optional(),
	/** fieldId → raw value (parsed per kind). */
	fields: z.record(z.string(), z.unknown()).optional(),
	tags: z.array(Id).max(50).optional(),
});
export type WorkTaskCreate = z.infer<typeof WorkTaskCreate>;

export const WorkTaskPatch = z.object({
	title: z.string().trim().min(1).max(500).optional(),
	description: RichDoc.nullable().optional(),
	statusId: Id.optional(),
	priority: WorkPriority.optional(),
	startDate: IsoDate.nullable().optional(),
	dueDate: IsoDate.nullable().optional(),
	dueTime: DueTime.nullable().optional(),
	isMilestone: z.boolean().optional(),
	estimateMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
	recurrence: RecurrenceRule.nullable().optional(),
	/** Optimistic concurrency (or header `If-Unmodified-Since`); mismatch → 409 with the current task. */
	expectedUpdatedAt: Timestamp.optional(),
});
export type WorkTaskPatch = z.infer<typeof WorkTaskPatch>;

/** One call for any drag. */
export const WorkTaskMove = Position.extend({
	listId: Id.optional(),
	statusId: Id.optional(),
	parentId: Id.nullable().optional(),
});
export type WorkTaskMove = z.infer<typeof WorkTaskMove>;

export const WorkTaskMoveProject = z.object({
	projectId: Id,
	listId: Id,
	/** Source status id → target status id; unmapped → same name, else first of the same category. */
	statusMap: z.record(z.string(), z.string()).optional(),
	/** Source field id → target field id. */
	fieldMap: z.record(z.string(), z.string()).optional(),
});
export type WorkTaskMoveProject = z.infer<typeof WorkTaskMoveProject>;
export const WorkTaskMoveProjectResult = z.object({
	taskId: Id,
	number: z.number().int(),
	key: z.string(),
	dropped: z.array(
		z.object({ fieldId: Id, name: z.string(), reason: z.string() }),
	),
	dryRun: z.boolean(),
});
export type WorkTaskMoveProjectResult = z.infer<
	typeof WorkTaskMoveProjectResult
>;

export const WorkTaskDuplicate = z.object({
	title: z.string().trim().min(1).max(500).optional(),
	subtasks: z.boolean().default(true),
	checklist: z.boolean().default(true),
	fields: z.boolean().default(true),
	assignees: z.boolean().default(false),
	attachments: z.boolean().default(false),
});
export type WorkTaskDuplicate = z.input<typeof WorkTaskDuplicate>;

export const WORK_BULK_MAX = 500;
export const WorkTaskBulk = z.object({
	taskIds: z.array(Id).min(1).max(WORK_BULK_MAX),
	set: z
		.object({
			statusId: Id.optional(),
			listId: Id.optional(),
			priority: WorkPriority.optional(),
			addAssignees: z.array(Id).max(20).optional(),
			removeAssignees: z.array(Id).max(20).optional(),
			addTags: z.array(Id).max(50).optional(),
			removeTags: z.array(Id).max(50).optional(),
			startDate: IsoDate.nullable().optional(),
			dueDate: IsoDate.nullable().optional(),
			/** Working days, keeps duration. */
			shiftDays: z.number().int().min(-3650).max(3650).optional(),
			fields: z.record(z.string(), z.unknown()).optional(),
		})
		.optional(),
	archive: z.boolean().optional(),
	delete: z.boolean().optional(),
});
export type WorkTaskBulk = z.infer<typeof WorkTaskBulk>;
export const WorkTaskBulkResult = z.object({
	updated: z.array(Id),
	errors: z.array(
		z.object({ taskId: Id, code: z.string(), message: z.string() }),
	),
});
export type WorkTaskBulkResult = z.infer<typeof WorkTaskBulkResult>;

export const WorkShiftPreviewRequest = z.object({
	deltaDays: z.number().int().min(-3650).max(3650),
	/** Shift only the due date (resize) instead of both. */
	dueOnly: z.boolean().optional(),
});
export type WorkShiftPreviewRequest = z.infer<typeof WorkShiftPreviewRequest>;
export const WorkDateChange = z.object({
	id: Id,
	startDate: IsoDate.nullable(),
	dueDate: IsoDate.nullable(),
});
export type WorkDateChange = z.infer<typeof WorkDateChange>;
export const WorkShiftPreview = z.object({ changes: z.array(WorkDateChange) });
export type WorkShiftPreview = z.infer<typeof WorkShiftPreview>;

export const WorkTaskByKey = z.object({
	taskId: Id,
	projectId: Id,
	key: z.string(),
});
export type WorkTaskByKey = z.infer<typeof WorkTaskByKey>;

// ---------------------------------------------------------------------------
// Comments, activity
// ---------------------------------------------------------------------------

export const WorkComment = z.object({
	id: Id,
	taskId: Id,
	/** Null: "Former member". */
	authorId: z.string().nullable(),
	parentId: z.string().nullable(),
	/** Null once deleted. */
	body: CommentDoc.nullable(),
	bodyText: z.string().nullable(),
	editedAt: Timestamp.nullable(),
	deletedAt: Timestamp.nullable(),
	resolvedAt: Timestamp.nullable(),
	resolvedBy: z.string().nullable(),
	createdAt: Timestamp,
	reactions: z.array(
		z.object({ emoji: WorkReaction, userIds: z.array(z.string()) }),
	),
	attachments: z.array(WorkAttachment),
});
export type WorkComment = z.infer<typeof WorkComment>;
export const WorkCommentCreate = z.object({
	body: CommentDoc,
	parentId: Id.optional(),
	/** Already-uploaded attachments to bind to the comment. */
	attachmentIds: z.array(Id).max(20).optional(),
});
export type WorkCommentCreate = z.infer<typeof WorkCommentCreate>;
export const WorkCommentPatch = z.object({ body: CommentDoc });
export type WorkCommentPatch = z.infer<typeof WorkCommentPatch>;

/** Per-kind data (before/after for scalars; never rich-text bodies). */
export const WorkActivityData = z.record(z.string(), z.unknown());
export const WorkActivity = z.object({
	id: Id,
	taskId: Id,
	actorId: z.string().nullable(),
	kind: WorkActivityKind,
	data: WorkActivityData,
	createdAt: Timestamp,
});
export type WorkActivity = z.infer<typeof WorkActivity>;

/** `GET /tasks/:id/activity`: comments and activity merged, newest last. */
export const WorkFeedItem = z.discriminatedUnion("type", [
	z.object({ type: z.literal("activity"), activity: WorkActivity }),
	z.object({ type: z.literal("comment"), comment: WorkComment }),
]);
export type WorkFeedItem = z.infer<typeof WorkFeedItem>;
export const WorkFeedPage = z.object({
	items: z.array(WorkFeedItem),
	/** Cursor for older items. */
	nextCursor: z.string().nullable(),
});
export type WorkFeedPage = z.infer<typeof WorkFeedPage>;

// ---------------------------------------------------------------------------
// Me: tasks, inbox, prefs, search
// ---------------------------------------------------------------------------

export const WorkMyTask = WorkTaskListItem.extend({
	projectName: z.string(),
	watching: z.boolean(),
});
export type WorkMyTask = z.infer<typeof WorkMyTask>;
export const WorkMyTasks = z.object({
	buckets: z.array(z.object({ bucket: DueBucket, items: z.array(WorkMyTask) })),
});
export type WorkMyTasks = z.infer<typeof WorkMyTasks>;

export const WorkNotification = z.object({
	id: Id,
	kind: WorkNotificationKind,
	organizationId: Id,
	projectId: Id,
	projectName: z.string(),
	taskId: Id,
	taskKey: z.string(),
	taskTitle: z.string(),
	commentId: z.string().nullable(),
	actorId: z.string().nullable(),
	/** Bundled changes count etc. */
	data: z.record(z.string(), z.unknown()),
	readAt: Timestamp.nullable(),
	createdAt: Timestamp,
});
export type WorkNotification = z.infer<typeof WorkNotification>;
export const WorkInboxPage = z.object({
	items: z.array(WorkNotification),
	nextCursor: z.string().nullable(),
	unread: z.number().int(),
});
export type WorkInboxPage = z.infer<typeof WorkInboxPage>;
export const WorkInboxRead = z.union([
	z.object({ ids: z.array(Id).min(1).max(500) }),
	z.object({ all: z.literal(true) }),
]);
export type WorkInboxRead = z.infer<typeof WorkInboxRead>;

export const WorkPrefs = z.object({
	email: WorkEmailMode,
	emailKinds: z.array(WorkNotificationKind),
	dailyHour: z.number().int().min(0).max(23),
	timezone: z.string().nullable(),
	capacityHoursPerWeek: z.number().int().min(0).max(168),
	icalEnabled: z.boolean(),
	/** Instance mail is configured; email modes are disabled without it. */
	mailAvailable: z.boolean(),
});
export type WorkPrefs = z.infer<typeof WorkPrefs>;
export const WorkPrefsUpdate = z.object({
	email: WorkEmailMode.optional(),
	emailKinds: z.array(WorkNotificationKind).optional(),
	dailyHour: z.number().int().min(0).max(23).optional(),
	timezone: z.string().max(64).nullable().optional(),
});
export type WorkPrefsUpdate = z.infer<typeof WorkPrefsUpdate>;
export const WorkIcalToken = z.object({ url: z.string() });
export type WorkIcalToken = z.infer<typeof WorkIcalToken>;

export const WorkSearchHit = WorkTaskRef.extend({
	projectName: z.string(),
	/** Where it matched. */
	match: z.enum(["key", "title", "text", "comment"]),
});
export type WorkSearchHit = z.infer<typeof WorkSearchHit>;
export const WorkSearchResult = z.object({
	items: z.array(WorkSearchHit).max(20),
});
export type WorkSearchResult = z.infer<typeof WorkSearchResult>;

// ---------------------------------------------------------------------------
// Time tracking (12.3)
// ---------------------------------------------------------------------------

export const WorkTimeEntry = z.object({
	id: Id,
	projectId: Id,
	taskId: Id,
	taskKey: z.string(),
	taskTitle: z.string(),
	userId: Id,
	startedAt: Timestamp,
	/** Null: running. */
	endedAt: Timestamp.nullable(),
	durationSec: z.number().int().nullable(),
	note: z.string().nullable(),
	billable: z.boolean(),
	source: WorkTimeEntrySource,
	/** Before the project's lock date. */
	locked: z.boolean(),
	createdAt: Timestamp,
});
export type WorkTimeEntry = z.infer<typeof WorkTimeEntry>;
export const WorkTimeEntryCreate = z.object({
	startedAt: z.iso.datetime({ offset: true }),
	durationSec: z
		.number()
		.int()
		.min(60)
		.max(24 * 3600),
	note: z.string().max(500).nullable().optional(),
	billable: z.boolean().optional(),
});
export type WorkTimeEntryCreate = z.infer<typeof WorkTimeEntryCreate>;
export const WorkTimeEntryPatch = WorkTimeEntryCreate.partial();
export type WorkTimeEntryPatch = z.infer<typeof WorkTimeEntryPatch>;
export const WorkTimer = z.object({ running: WorkTimeEntry.nullable() });
export type WorkTimer = z.infer<typeof WorkTimer>;
export const WorkTimerStart = z.object({
	started: WorkTimeEntry,
	/** The timer this one replaced. */
	stopped: WorkTimeEntry.nullable(),
});
export type WorkTimerStart = z.infer<typeof WorkTimerStart>;

export const workTimeGroups = [
	"project",
	"user",
	"task",
	"day",
	"week",
] as const;
export const WorkTimeGroup = z.enum(workTimeGroups);
export type WorkTimeGroup = z.infer<typeof WorkTimeGroup>;
export const WorkTimeReportQuery = z.object({
	projectId: Id.optional(),
	userId: Id.optional(),
	from: IsoDate,
	to: IsoDate,
	groupBy: WorkTimeGroup.default("day"),
	billable: z.enum(["true", "false"]).optional(),
	format: z.enum(["json", "csv"]).optional(),
});
export type WorkTimeReportQuery = z.input<typeof WorkTimeReportQuery>;
export const WorkTimeReport = z.object({
	groupBy: WorkTimeGroup,
	rows: z.array(
		z.object({
			key: z.string(),
			label: z.string(),
			seconds: z.number().int(),
			billableSeconds: z.number().int(),
			entries: z.number().int(),
		}),
	),
	totals: z.object({
		seconds: z.number().int(),
		billableSeconds: z.number().int(),
		entries: z.number().int(),
	}),
});
export type WorkTimeReport = z.infer<typeof WorkTimeReport>;

// ---------------------------------------------------------------------------
// Templates (12.1)
// ---------------------------------------------------------------------------

export const WorkTemplate = z.object({
	id: Id,
	/** Null: built-in, seeded per instance. */
	organizationId: z.string().nullable(),
	/** Null: organization-wide. */
	projectId: z.string().nullable(),
	kind: WorkTemplateKind,
	name: z.string(),
	description: z.string().nullable(),
	payload: TemplatePayload,
	createdBy: z.string().nullable(),
	usageCount: z.number().int(),
	/** Seeded per instance, read-only (duplicable). */
	builtin: z.boolean(),
	createdAt: Timestamp,
	updatedAt: Timestamp,
});
export type WorkTemplate = z.infer<typeof WorkTemplate>;
export const WorkTemplateListItem = WorkTemplate.omit({ payload: true }).extend(
	{
		taskCount: z.number().int(),
	},
);
export type WorkTemplateListItem = z.infer<typeof WorkTemplateListItem>;
export const WorkTemplateCreate = z.object({
	name: z.string().trim().min(1).max(100),
	description: z.string().max(1000).nullable().optional(),
	/** Null/absent: organization-wide (needs org-level `work:admin`). */
	projectId: Id.nullable().optional(),
	source: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("task"), taskId: Id }),
		z.object({ kind: z.literal("list"), listId: Id }),
		z.object({ kind: z.literal("project"), projectId: Id }),
	]),
	include: z.object({
		subtasks: z.boolean(),
		checklist: z.boolean(),
		fieldValues: z.boolean(),
		assignees: z.enum(["none", "placeholders", "fixed"]),
		attachments: z.boolean(),
		descriptions: z.boolean(),
	}),
});
export type WorkTemplateCreate = z.infer<typeof WorkTemplateCreate>;
export const WorkTemplatePatch = z.object({
	name: z.string().trim().min(1).max(100).optional(),
	description: z.string().max(1000).nullable().optional(),
});
export type WorkTemplatePatch = z.infer<typeof WorkTemplatePatch>;
export const WorkTemplateInstantiate = z.object({
	target: z.union([
		z.object({ listId: Id }),
		/** A project template applied to a project (statuses, fields, lists…). */
		z.object({ projectId: Id }),
	]),
	anchor: z.object({ date: IsoDate, mode: z.enum(["start", "finish"]) }),
	/** Placeholder name → user id. */
	placeholders: z.record(z.string(), Id).default({}),
	/** Fields the target lacks: create them (work:admin) or drop. */
	missingFields: z.enum(["create", "drop"]).default("drop"),
	dryRun: z.boolean().optional(),
});
export type WorkTemplateInstantiate = z.input<typeof WorkTemplateInstantiate>;
export const WorkTemplateInstantiateResult = z.object({
	dryRun: z.boolean(),
	created: z.object({
		tasks: z.number().int(),
		lists: z.number().int(),
		fields: z.number().int(),
		statuses: z.number().int(),
	}),
	taskIds: z.array(Id),
	warnings: z.array(z.string()),
});
export type WorkTemplateInstantiateResult = z.infer<
	typeof WorkTemplateInstantiateResult
>;

// ---------------------------------------------------------------------------
// Imports (12.5, 12.6)
// ---------------------------------------------------------------------------

export const WorkImportProgress = z.record(
	z.string(),
	z.object({
		phase: z.string(),
		done: z.number().int(),
		total: z.number().int(),
	}),
);
export const WorkImportReport = z.object({
	created: z.record(z.string(), z.number().int()),
	updated: z.record(z.string(), z.number().int()),
	skipped: z.array(
		z.object({ entity: z.string(), name: z.string(), reason: z.string() }),
	),
	warnings: z.array(z.string()),
});
export type WorkImportReport = z.infer<typeof WorkImportReport>;
export const WorkImportPlan = z.object({
	counts: z.record(z.string(), z.number().int()),
	perProject: z.array(
		z.object({
			target: z.string(),
			counts: z.record(z.string(), z.number().int()),
		}),
	),
	warnings: z.array(z.string()),
	attachmentBytes: z.number().int(),
	quotaBytes: z.number().int().nullable(),
});
export type WorkImportPlan = z.infer<typeof WorkImportPlan>;
export const WorkImport = z.object({
	id: Id,
	kind: WorkImportKind,
	status: WorkImportStatus,
	createdBy: z.string().nullable(),
	plan: WorkImportPlan.nullable(),
	progress: WorkImportProgress.nullable(),
	report: WorkImportReport.nullable(),
	startedAt: Timestamp.nullable(),
	finishedAt: Timestamp.nullable(),
	createdAt: Timestamp,
});
export type WorkImport = z.infer<typeof WorkImport>;

export const ClickUpToken = z.object({
	token: z.string().trim().min(10).max(200),
});
export type ClickUpToken = z.infer<typeof ClickUpToken>;
export const ClickUpConnection = z.object({
	user: z.object({ id: z.string(), username: z.string(), email: z.string() }),
	teams: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ClickUpConnection = z.infer<typeof ClickUpConnection>;
export type ClickUpTreeNode = {
	id: string;
	type: "space" | "folder" | "list";
	name: string;
	taskCount: number | null;
	archived: boolean;
	children: ClickUpTreeNode[];
};
export const ClickUpTreeNode: z.ZodType<ClickUpTreeNode> = z.lazy(() =>
	z.object({
		id: z.string(),
		type: z.enum(["space", "folder", "list"]),
		name: z.string(),
		taskCount: z.number().int().nullable(),
		archived: z.boolean(),
		children: z.array(ClickUpTreeNode),
	}),
);
export const ClickUpTreeRequest = ClickUpToken.extend({ teamId: z.string() });
export type ClickUpTreeRequest = z.infer<typeof ClickUpTreeRequest>;

/** Everything the wizard collects; stored encrypted, the token is wiped when the run ends. */
export const ClickUpImportConfig = z.object({
	token: z.string().min(10).max(200),
	teamId: z.string(),
	targets: z
		.array(
			z.object({
				/** ClickUp space or folder id. */
				sourceId: z.string(),
				sourceType: z.enum(["space", "folder"]),
				listIds: z.array(z.string()),
				target: z.union([
					z.object({
						kind: z.literal("new"),
						name: z.string().min(1).max(100),
						folderId: Id.nullable(),
					}),
					z.object({ kind: z.literal("existing"), projectId: Id }),
				]),
			}),
		)
		.min(1),
	/** ClickUp status name (lowercase) → existing status id or a new status. */
	statuses: z.record(
		z.string(),
		z.union([
			z.object({ statusId: Id }),
			z.object({ create: WorkStatusCreate }),
		]),
	),
	fields: z.record(
		z.string(),
		z.union([
			z.object({ mode: z.literal("skip") }),
			z.object({ mode: z.literal("import"), config: WorkFieldConfig }),
			z.object({ mode: z.literal("map"), fieldId: Id }),
			z.object({ mode: z.literal("text_snapshot") }),
		]),
	),
	/** ClickUp user id → org user id, or "unassigned" / "invite". */
	people: z.record(
		z.string(),
		z.union([Id, z.literal("unassigned"), z.literal("invite")]),
	),
	options: z.object({
		closedTasks: z.boolean(),
		comments: z.boolean(),
		attachments: z.boolean(),
		timeEntries: z.boolean(),
		archivedLists: z.boolean(),
		keepUrls: z.boolean(),
	}),
});
export type ClickUpImportConfig = z.infer<typeof ClickUpImportConfig>;

export const CsvImportConfig = z.object({
	listId: Id,
	delimiter: z.string().length(1),
	encoding: z.string().default("utf-8"),
	/** CSV column index → target. */
	columns: z.record(
		z.string(),
		z.union([
			z.object({
				to: z.enum([
					"title",
					"description",
					"status",
					"assignee",
					"priority",
					"startDate",
					"dueDate",
					"tags",
					"parent",
					"externalId",
				]),
				/** status: CSV value → status id; dates: format string. */
				map: z.record(z.string(), z.string()).optional(),
				dateFormat: z.string().optional(),
			}),
			z.object({ to: z.literal("field"), fieldId: Id }),
			z.object({
				to: z.literal("new_field"),
				name: z.string(),
				config: WorkFieldConfig,
			}),
			z.object({ to: z.literal("skip") }),
		]),
	),
	/** Uploaded with `POST /imports/csv/upload`. */
	uploadId: Id,
});
export type CsvImportConfig = z.input<typeof CsvImportConfig>;
export const CsvUpload = z.object({
	uploadId: Id,
	delimiter: z.string(),
	encoding: z.string(),
	headers: z.array(z.string()),
	rows: z.array(z.array(z.string())).max(20),
	rowCount: z.number().int(),
});
export type CsvUpload = z.infer<typeof CsvUpload>;

export const WorkImportCreate = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("clickup"), config: ClickUpImportConfig }),
	z.object({ kind: z.literal("csv"), config: CsvImportConfig }),
]);
export type WorkImportCreate = z.input<typeof WorkImportCreate>;

// ---------------------------------------------------------------------------
// Share links (12.7) and guests (12.8)
// ---------------------------------------------------------------------------

export const WorkShare = z.object({
	id: Id,
	projectId: Id,
	listId: z.string().nullable(),
	viewId: z.string().nullable(),
	name: z.string(),
	showComments: z.boolean(),
	showAssignees: z.boolean(),
	fieldIds: z.array(z.string()),
	hasPassword: z.boolean(),
	expiresAt: Timestamp.nullable(),
	revokedAt: Timestamp.nullable(),
	lastViewedAt: Timestamp.nullable(),
	viewCount: z.number().int(),
	createdBy: z.string().nullable(),
	createdAt: Timestamp,
});
export type WorkShare = z.infer<typeof WorkShare>;
export const WorkShareCreate = z
	.object({
		name: z.string().trim().min(1).max(100),
		listId: Id.optional(),
		viewId: Id.optional(),
		showComments: z.boolean().default(false),
		showAssignees: z.boolean().default(true),
		fieldIds: z.array(Id).max(100).default([]),
		password: z.string().min(6).max(128).optional(),
		expiresAt: z.iso.datetime({ offset: true }).optional(),
	})
	.refine((s) => !!s.listId !== !!s.viewId, "either listId or viewId");
export type WorkShareCreate = z.input<typeof WorkShareCreate>;
/** The token is in `url` and shown once. */
export const WorkShareCreated = z.object({ share: WorkShare, url: z.string() });
export type WorkShareCreated = z.infer<typeof WorkShareCreated>;

export const WorkGuestInvite = z.object({
	email: z.email(),
	canCreate: z.boolean().default(false),
});
export type WorkGuestInvite = z.input<typeof WorkGuestInvite>;
export const WorkGuestInvited = z.object({
	invitationId: Id,
	/** Copy-by-hand link; also emailed when instance mail is set up. */
	url: z.string(),
	emailed: z.boolean(),
});
export type WorkGuestInvited = z.infer<typeof WorkGuestInvited>;

// ---------------------------------------------------------------------------
// Workload (12.11) and AI assist (12.10)
// ---------------------------------------------------------------------------

export const WorkWorkloadQuery = z.object({
	from: IsoDate.optional(),
	weeks: z.coerce.number().int().min(1).max(26).optional(),
	/** Comma-separated. */
	projectIds: z.string().optional(),
});
export type WorkWorkloadQuery = z.input<typeof WorkWorkloadQuery>;
export const WorkWorkload = z.object({
	/** Mondays, in order. */
	weeks: z.array(IsoDate),
	people: z.array(
		z.object({
			userId: Id,
			name: z.string(),
			avatar: z.string().nullable(),
			capacityMinutes: z.number().int(),
			cells: z.array(
				z.object({
					weekStart: IsoDate,
					minutes: z.number().int(),
					taskIds: z.array(Id),
				}),
			),
		}),
	),
});
export type WorkWorkload = z.infer<typeof WorkWorkload>;

export const WorkAiSummary = z.object({ draft: CommentDoc });
export type WorkAiSummary = z.infer<typeof WorkAiSummary>;
export const WorkAiSubtasks = z.object({
	subtasks: z.array(
		z.object({
			title: z.string(),
			estimateMinutes: z.number().int().nullable(),
		}),
	),
});
export type WorkAiSubtasks = z.infer<typeof WorkAiSubtasks>;
export const WorkAiDescription = z.object({ description: RichDoc });
export type WorkAiDescription = z.infer<typeof WorkAiDescription>;

// ---------------------------------------------------------------------------
// Attachment storage (10.2) and instance mail (14.3)
// ---------------------------------------------------------------------------

export const WorkAttachmentSettings = z.object({
	/** Null: the default (2 GB on the database driver, unlimited on S3). */
	quotaGb: z.number().int().nullable(),
	/** Effective quota in bytes; null when unlimited. */
	quotaBytes: z.number().nullable(),
	usedBytes: z.number(),
	/** S3 destination new attachments go to; null keeps them in Postgres. */
	destinationId: z.string().nullable(),
	/** Instance-wide upload cap. */
	maxMb: z.number().int(),
	/** Live attachments per driver; `db` > 0 with a destination means a migration is pending. */
	counts: z.object({ db: z.number().int(), s3: z.number().int() }),
});
export type WorkAttachmentSettings = z.infer<typeof WorkAttachmentSettings>;
export const WorkAttachmentSettingsUpdate = z.object({
	quotaGb: z.number().int().min(1).max(10_000).nullable().optional(),
	destinationId: Id.nullable().optional(),
});
export type WorkAttachmentSettingsUpdate = z.infer<
	typeof WorkAttachmentSettingsUpdate
>;
export const WorkBlobMigrationStarted = z.object({ jobId: z.string() });
export type WorkBlobMigrationStarted = z.infer<typeof WorkBlobMigrationStarted>;

const mailFrom = z.string().trim().min(3).max(320);
/** Secrets may be omitted on update to keep the stored ones. */
export const InstanceMailInput = z.discriminatedUnion("transport", [
	z.object({
		transport: z.literal("smtp"),
		host: z.string().trim().min(1),
		port: z.number().int().min(1).max(65535).default(587),
		secure: z.boolean().default(false),
		username: z.string().optional(),
		password: z.string().min(1).optional(),
		from: mailFrom,
	}),
	z.object({
		transport: z.literal("resend"),
		apiKey: z.string().min(1).optional(),
		from: mailFrom,
	}),
]);
export type InstanceMailInput = z.input<typeof InstanceMailInput>;
/** What the API shows: never the secret, only whether one is stored. */
export const InstanceMail = z.object({
	configured: z.boolean(),
	transport: z.enum(["smtp", "resend"]).nullable(),
	host: z.string().nullable(),
	port: z.number().int().nullable(),
	secure: z.boolean(),
	username: z.string().nullable(),
	from: z.string().nullable(),
	hasSecret: z.boolean(),
});
export type InstanceMail = z.infer<typeof InstanceMail>;
export const InstanceMailTest = z.object({
	to: z.email(),
	/** Unsaved settings from the wizard; omitted secrets fall back to the stored ones. */
	config: InstanceMailInput.optional(),
});
export type InstanceMailTest = z.input<typeof InstanceMailTest>;
export const instanceMailRoutes = {
	get: { method: "GET", path: "/api/instance/mail" },
	update: { method: "PUT", path: "/api/instance/mail" },
	remove: { method: "DELETE", path: "/api/instance/mail" },
	test: { method: "POST", path: "/api/instance/mail/test" },
} as const;

// ---------------------------------------------------------------------------
// Realtime (section 9)
// ---------------------------------------------------------------------------

export const WorkRealtimeMessage = z.object({
	type: z.literal("work"),
	organizationId: Id,
	projectId: Id,
	taskIds: z.array(Id).optional(),
	entity: z.enum([
		"task",
		"list",
		"status",
		"field",
		"view",
		"comment",
		"tag",
		"project",
		"health",
		"time",
		"notification",
	]),
	op: z.enum(["upsert", "delete"]),
	/** Notifications target one user only. */
	userId: z.string().optional(),
	actorId: z.string().nullable(),
});
export type WorkRealtimeMessage = z.infer<typeof WorkRealtimeMessage>;

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export type WorkAction = Extract<
	PermissionAction,
	"read:work" | "comment:work" | "work" | "work:admin" | "ai"
>;
export type WorkRoute = {
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	/** Full path; `:param` segments as Hono writes them. */
	path: string;
	/** The action checked on the route's project (or org for cross-project routes). */
	action: WorkAction;
	operationId: string;
	/** Extra rules beyond the action. */
	note?: string;
};

const r = (
	method: WorkRoute["method"],
	path: string,
	action: WorkAction,
	operationId: string,
	note?: string,
): WorkRoute => ({
	method,
	path: `/api/work${path}`,
	action,
	operationId,
	...(note ? { note } : {}),
});

/** Every Work route: path, method, required action. Server registers these; web calls them. */
export const workRoutes = {
	// 8.1 projects
	projectList: r(
		"GET",
		"/projects",
		"read:work",
		"work_project_list",
		"filtered per row",
	),
	projectGet: r("GET", "/projects/:id", "read:work", "work_project_get"),
	projectSettings: r(
		"PATCH",
		"/projects/:id/settings",
		"work:admin",
		"work_project_settings",
		"audited",
	),
	projectHealth: r(
		"GET",
		"/projects/:id/health",
		"read:work",
		"work_project_health",
	),
	projectSummary: r(
		"GET",
		"/projects/:id/summary",
		"read:work",
		"work_project_summary",
	),
	projectPeople: r(
		"GET",
		"/projects/:id/people",
		"read:work",
		"work_project_people",
	),
	projectServices: r(
		"GET",
		"/projects/:id/services",
		"work:admin",
		"work_project_services",
	),
	// 8.2 structure
	statusList: r(
		"GET",
		"/projects/:id/statuses",
		"read:work",
		"work_status_list",
	),
	statusCreate: r(
		"POST",
		"/projects/:id/statuses",
		"work:admin",
		"work_status_create",
	),
	statusUpdate: r("PATCH", "/statuses/:id", "work:admin", "work_status_update"),
	statusDelete: r(
		"DELETE",
		"/statuses/:id",
		"work:admin",
		"work_status_delete",
		"?moveTo=wst_x; audited",
	),
	statusOrder: r(
		"PATCH",
		"/projects/:id/statuses/order",
		"work:admin",
		"work_status_order",
	),
	listList: r("GET", "/projects/:id/lists", "read:work", "work_list_list"),
	listCreate: r(
		"POST",
		"/projects/:id/lists",
		"work:admin",
		"work_list_create",
	),
	listUpdate: r("PATCH", "/lists/:id", "work:admin", "work_list_update"),
	listDelete: r(
		"DELETE",
		"/lists/:id",
		"work:admin",
		"work_list_delete",
		"?moveTo or ?deleteTasks=true; audited",
	),
	listArchive: r(
		"POST",
		"/lists/:id/archive",
		"work:admin",
		"work_list_archive",
	),
	listRestore: r(
		"POST",
		"/lists/:id/restore",
		"work:admin",
		"work_list_restore",
	),
	listOrder: r(
		"PATCH",
		"/projects/:id/lists/order",
		"work:admin",
		"work_list_order",
	),
	fieldList: r("GET", "/projects/:id/fields", "read:work", "work_field_list"),
	fieldCreate: r(
		"POST",
		"/projects/:id/fields",
		"work:admin",
		"work_field_create",
	),
	fieldUpdate: r(
		"PATCH",
		"/fields/:id",
		"work:admin",
		"work_field_update",
		"kind can't change (conflict)",
	),
	fieldDelete: r(
		"DELETE",
		"/fields/:id",
		"work:admin",
		"work_field_delete",
		"audited",
	),
	fieldOrder: r(
		"PATCH",
		"/projects/:id/fields/order",
		"work:admin",
		"work_field_order",
	),
	tagList: r("GET", "/projects/:id/tags", "read:work", "work_tag_list"),
	tagCreate: r(
		"POST",
		"/projects/:id/tags",
		"work",
		"work_tag_create",
		"inline creation needs only work",
	),
	tagUpdate: r("PATCH", "/tags/:id", "work:admin", "work_tag_update"),
	tagDelete: r(
		"DELETE",
		"/tags/:id",
		"work:admin",
		"work_tag_delete",
		"audited",
	),
	viewList: r(
		"GET",
		"/projects/:id/views",
		"read:work",
		"work_view_list",
		"shared + own personal",
	),
	viewCreate: r(
		"POST",
		"/projects/:id/views",
		"work",
		"work_view_create",
		"shared: work:admin; personal: work",
	),
	viewUpdate: r(
		"PATCH",
		"/views/:id",
		"work",
		"work_view_update",
		"shared: work:admin; personal: owner",
	),
	viewDelete: r(
		"DELETE",
		"/views/:id",
		"work",
		"work_view_delete",
		"shared: work:admin; personal: owner",
	),
	viewOrder: r(
		"PATCH",
		"/projects/:id/views/order",
		"work:admin",
		"work_view_order",
	),
	// 8.3 tasks
	taskList: r(
		"GET",
		"/tasks",
		"read:work",
		"work_task_list",
		"projectId required unless assignee=me; format=csv",
	),
	taskByKey: r("GET", "/tasks/by-key/:key", "read:work", "work_task_by_key"),
	taskCreate: r("POST", "/tasks", "work", "work_task_create"),
	taskGet: r("GET", "/tasks/:id", "read:work", "work_task_get"),
	taskUpdate: r(
		"PATCH",
		"/tasks/:id",
		"work",
		"work_task_update",
		"409 on stale expectedUpdatedAt",
	),
	taskMove: r("POST", "/tasks/:id/move", "work", "work_task_move"),
	taskMoveProject: r(
		"POST",
		"/tasks/:id/move-project",
		"work",
		"work_task_move_project",
		"work on both projects; ?dryRun=true",
	),
	taskDuplicate: r(
		"POST",
		"/tasks/:id/duplicate",
		"work",
		"work_task_duplicate",
	),
	taskArchive: r("POST", "/tasks/:id/archive", "work", "work_task_archive"),
	taskRestore: r("POST", "/tasks/:id/restore", "work", "work_task_restore"),
	taskDelete: r(
		"DELETE",
		"/tasks/:id",
		"work:admin",
		"work_task_delete",
		"or the creator within 15 min; audited",
	),
	taskBulk: r(
		"POST",
		"/tasks/bulk",
		"work",
		"work_task_bulk",
		"each task checked",
	),
	taskAssigneeAdd: r(
		"PUT",
		"/tasks/:id/assignees/:userId",
		"work",
		"work_task_assignee_add",
		"assignable check",
	),
	taskAssigneeRemove: r(
		"DELETE",
		"/tasks/:id/assignees/:userId",
		"work",
		"work_task_assignee_remove",
	),
	taskWatcherAdd: r(
		"PUT",
		"/tasks/:id/watchers/:userId",
		"read:work",
		"work_task_watcher_add",
		"self with read:work, others with work",
	),
	taskWatcherRemove: r(
		"DELETE",
		"/tasks/:id/watchers/:userId",
		"read:work",
		"work_task_watcher_remove",
		"self with read:work, others with work",
	),
	taskTagAdd: r("PUT", "/tasks/:id/tags/:tagId", "work", "work_task_tag_add"),
	taskTagRemove: r(
		"DELETE",
		"/tasks/:id/tags/:tagId",
		"work",
		"work_task_tag_remove",
	),
	taskFieldSet: r(
		"PUT",
		"/tasks/:id/fields/:fieldId",
		"work",
		"work_task_field_set",
		"body {value}",
	),
	taskFieldClear: r(
		"DELETE",
		"/tasks/:id/fields/:fieldId",
		"work",
		"work_task_field_clear",
	),
	taskDependencyAdd: r(
		"POST",
		"/tasks/:id/dependencies",
		"work",
		"work_task_dependency_add",
		"cycle → conflict",
	),
	taskDependencyRemove: r(
		"DELETE",
		"/tasks/:id/dependencies/:blockedById",
		"work",
		"work_task_dependency_remove",
	),
	taskShiftPreview: r(
		"POST",
		"/tasks/:id/shift-preview",
		"read:work",
		"work_task_shift_preview",
	),
	checklistList: r(
		"GET",
		"/tasks/:id/checklist",
		"read:work",
		"work_checklist_list",
	),
	checklistCreate: r(
		"POST",
		"/tasks/:id/checklist",
		"work",
		"work_checklist_create",
	),
	checklistUpdate: r(
		"PATCH",
		"/checklist/:id",
		"comment:work",
		"work_checklist_update",
		"comment:work may only tick items assigned to them; else work",
	),
	checklistDelete: r(
		"DELETE",
		"/checklist/:id",
		"work",
		"work_checklist_delete",
	),
	checklistConvert: r(
		"POST",
		"/checklist/:id/convert",
		"work",
		"work_checklist_convert",
	),
	taskActivity: r(
		"GET",
		"/tasks/:id/activity",
		"read:work",
		"work_task_activity",
	),
	// 8.4 comments and attachments
	commentList: r(
		"GET",
		"/tasks/:id/comments",
		"read:work",
		"work_comment_list",
	),
	commentCreate: r(
		"POST",
		"/tasks/:id/comments",
		"comment:work",
		"work_comment_create",
	),
	commentUpdate: r(
		"PATCH",
		"/comments/:id",
		"comment:work",
		"work_comment_update",
		"author only",
	),
	commentDelete: r(
		"DELETE",
		"/comments/:id",
		"comment:work",
		"work_comment_delete",
		"author, or work:admin",
	),
	commentResolve: r(
		"POST",
		"/comments/:id/resolve",
		"work",
		"work_comment_resolve",
	),
	commentUnresolve: r(
		"POST",
		"/comments/:id/unresolve",
		"work",
		"work_comment_unresolve",
	),
	reactionAdd: r(
		"PUT",
		"/comments/:id/reactions/:emoji",
		"comment:work",
		"work_reaction_add",
	),
	reactionRemove: r(
		"DELETE",
		"/comments/:id/reactions/:emoji",
		"comment:work",
		"work_reaction_remove",
	),
	attachmentUpload: r(
		"POST",
		"/attachments",
		"comment:work",
		"work_attachment_upload",
		"multipart; task attachments need work",
	),
	attachmentGet: r(
		"GET",
		"/attachments/:id",
		"read:work",
		"work_attachment_get",
		"?thumb=1",
	),
	attachmentDelete: r(
		"DELETE",
		"/attachments/:id",
		"comment:work",
		"work_attachment_delete",
		"uploader, or work:admin",
	),
	attachmentSettingsGet: r(
		"GET",
		"/attachment-settings",
		"work:admin",
		"work_attachment_settings_get",
		"organization scope",
	),
	attachmentSettingsUpdate: r(
		"PUT",
		"/attachment-settings",
		"work:admin",
		"work_attachment_settings_update",
		"organization scope; audited",
	),
	attachmentMigrate: r(
		"POST",
		"/attachment-settings/migrate",
		"work:admin",
		"work_attachment_migrate",
		"organization scope; moves database blobs to the destination; audited",
	),
	// 8.5 me
	myTasks: r(
		"GET",
		"/me/tasks",
		"read:work",
		"work_me_tasks",
		"?include=watching",
	),
	inbox: r(
		"GET",
		"/me/inbox",
		"read:work",
		"work_me_inbox",
		"?unread=1&cursor",
	),
	inboxRead: r("POST", "/me/inbox/read", "read:work", "work_me_inbox_read"),
	prefsGet: r("GET", "/me/prefs", "read:work", "work_me_prefs_get"),
	prefsUpdate: r("PUT", "/me/prefs", "read:work", "work_me_prefs_update"),
	icalToken: r("POST", "/me/ical-token", "read:work", "work_me_ical_token"),
	// 8.6 search
	search: r("GET", "/search", "read:work", "work_search", "?q&projectId"),
	// 12.3 time
	timerStart: r("POST", "/tasks/:id/timer/start", "work", "work_timer_start"),
	timerStop: r("POST", "/me/timer/stop", "work", "work_timer_stop"),
	timerGet: r("GET", "/me/timer", "read:work", "work_timer_get"),
	timeList: r("GET", "/tasks/:id/time", "read:work", "work_time_list"),
	timeCreate: r("POST", "/tasks/:id/time", "work", "work_time_create"),
	timeUpdate: r(
		"PATCH",
		"/time/:id",
		"work",
		"work_time_update",
		"own; others' need work:admin; locked before timeLockedBefore",
	),
	timeDelete: r(
		"DELETE",
		"/time/:id",
		"work",
		"work_time_delete",
		"own; others' need work:admin",
	),
	timeReport: r(
		"GET",
		"/time/report",
		"read:work",
		"work_time_report",
		"format=csv",
	),
	// 12.1 templates
	templateList: r(
		"GET",
		"/templates",
		"read:work",
		"work_template_list",
		"?projectId",
	),
	templateCreate: r("POST", "/templates", "work:admin", "work_template_create"),
	templateGet: r("GET", "/templates/:id", "read:work", "work_template_get"),
	templateUpdate: r(
		"PATCH",
		"/templates/:id",
		"work:admin",
		"work_template_update",
	),
	templateDelete: r(
		"DELETE",
		"/templates/:id",
		"work:admin",
		"work_template_delete",
	),
	templateInstantiate: r(
		"POST",
		"/templates/:id/instantiate",
		"work",
		"work_template_instantiate",
		"project targets need work:admin",
	),
	// 12.5 / 12.6 imports
	importList: r("GET", "/imports", "work:admin", "work_import_list"),
	importGet: r("GET", "/imports/:id", "work:admin", "work_import_get"),
	importCreate: r(
		"POST",
		"/imports",
		"work:admin",
		"work_import_create",
		"draft; work:admin on every target",
	),
	importDryRun: r(
		"POST",
		"/imports/:id/dry-run",
		"work:admin",
		"work_import_dry_run",
	),
	importRun: r(
		"POST",
		"/imports/:id/run",
		"work:admin",
		"work_import_run",
		"audited",
	),
	importCancel: r(
		"POST",
		"/imports/:id/cancel",
		"work:admin",
		"work_import_cancel",
	),
	clickupTest: r(
		"POST",
		"/imports/clickup/test",
		"work:admin",
		"work_import_clickup_test",
	),
	clickupTree: r(
		"POST",
		"/imports/clickup/tree",
		"work:admin",
		"work_import_clickup_tree",
	),
	csvUpload: r(
		"POST",
		"/imports/csv/upload",
		"work:admin",
		"work_import_csv_upload",
		"multipart, ≤ 10 MB",
	),
	// 12.7 shares, 12.8 guests
	shareList: r("GET", "/projects/:id/shares", "work", "work_share_list"),
	shareCreate: r(
		"POST",
		"/projects/:id/shares",
		"work",
		"work_share_create",
		"needs allowShareLinks; audited",
	),
	shareRevoke: r(
		"DELETE",
		"/shares/:id",
		"work",
		"work_share_revoke",
		"creator or work:admin; audited",
	),
	guestInvite: r(
		"POST",
		"/projects/:id/guests",
		"work:admin",
		"work_guest_invite",
		"audited",
	),
	// 12.11 workload, 12.10 AI
	workload: r("GET", "/workload", "read:work", "work_workload"),
	aiSummarise: r(
		"POST",
		"/tasks/:id/ai/summarise",
		"ai",
		"work_ai_summarise",
		"also read:work",
	),
	aiSubtasks: r(
		"POST",
		"/tasks/:id/ai/subtasks",
		"ai",
		"work_ai_subtasks",
		"also work",
	),
	aiDescription: r(
		"POST",
		"/tasks/:id/ai/description",
		"ai",
		"work_ai_description",
		"also work",
	),
} as const satisfies Record<string, WorkRoute>;
export type WorkRouteName = keyof typeof workRoutes;

/** Fill `:params` of a Work route path. */
export function workPath(
	name: WorkRouteName,
	params: Record<string, string> = {},
): string {
	return workRoutes[name].path.replace(/:(\w+)/g, (_, k: string) => {
		const v = params[k];
		if (v === undefined) throw new Error(`missing route param ${k}`);
		return encodeURIComponent(v);
	});
}
