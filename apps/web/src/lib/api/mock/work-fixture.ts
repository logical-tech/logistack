/*
 * The Work mock world: org "Acme Studio" with Shop (healthy), Blog relaunch
 * (degraded) and Brand book (no services). Dates are relative to load time so
 * the timeline and "overdue" always look current. Grow it here.
 */
import type {
	PmDoc,
	RecurrenceRule,
	WorkActivity,
	WorkAttachment,
	WorkChecklistItem,
	WorkColor,
	WorkComment,
	WorkField,
	WorkHealth,
	WorkList,
	WorkNotification,
	WorkPrefs,
	WorkPriority,
	WorkProject,
	WorkServiceHealth,
	WorkShare,
	WorkStatus,
	WorkStatusCategory,
	WorkTag,
	WorkTaskSource,
	WorkTemplate,
	WorkTimeEntry,
	WorkView,
	WorkViewConfig,
	WorkWatcher,
} from "@logistack/contracts";
import { mockPeople } from "./access";

export const WORK_ORG = { id: "org_acme_studio", name: "Acme Studio" };
/** The signed-in mock user. */
export const WORK_ME = "usr_simone";

export const workUsers = mockPeople.map(([userId, name, email]) => ({
	userId,
	name,
	email,
	avatar: null as string | null,
}));
const U = workUsers.map((u) => u.userId);

const now = Date.now();
const DAY = 86_400_000;
/** `YYYY-MM-DD`, `offset` days from today. */
export const dayOf = (offset: number) =>
	new Date(now + offset * DAY).toISOString().slice(0, 10);
export const isoAgo = (minutes: number) =>
	new Date(now - minutes * 60_000).toISOString();

/** Fixed-width ranks; the mock renumbers a whole list after each move. */
export const rankAt = (i: number) => `p${String(i).padStart(5, "0")}`;

export const doc = (...paragraphs: string[]): PmDoc => ({
	type: "doc",
	content: paragraphs.map((text) => ({
		type: "paragraph",
		content: [{ type: "text", text }],
	})),
});

export type WorkProjectRow = WorkProject & {
	folderPath: string[];
	nextNumber: number;
	hiddenServiceIds: string[];
	repos: { providerId: string; repo: string }[];
	health: WorkHealth;
	since: string | null;
	services: WorkServiceHealth[];
};

export type WorkTaskRow = {
	id: string;
	projectId: string;
	listId: string;
	parentId: string | null;
	number: number;
	title: string;
	description: PmDoc | null;
	statusId: string;
	priority: WorkPriority;
	startDate: string | null;
	dueDate: string | null;
	dueTime: string | null;
	isMilestone: boolean;
	estimateMinutes: number | null;
	position: string;
	recurrence: RecurrenceRule | null;
	recurrenceSeriesId: string | null;
	source: WorkTaskSource | null;
	createdBy: string | null;
	completedAt: string | null;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
	assigneeIds: string[];
	tagIds: string[];
	fields: Record<string, unknown>;
	watchers: WorkWatcher[];
};

export type WorkDependencyRow = {
	taskId: string;
	blockedById: string;
	lagDays: number;
};

export type WorkFixture = ReturnType<typeof createWorkFixture>;

const statusSeed: [string, WorkColor, WorkStatusCategory][] = [
	["Backlog", "gray", "backlog"],
	["To do", "blue", "active"],
	["In progress", "amber", "active"],
	["Review", "violet", "active"],
	["Done", "green", "done"],
	["Cancelled", "red", "cancelled"],
];

const health30 = (bad: Record<number, WorkHealth> = {}) =>
	Array.from({ length: 30 }, (_, i) => ({
		date: dayOf(i - 29),
		health: bad[i] ?? ("operational" as WorkHealth),
	}));

const defaultViewConfig = (
	over: Partial<WorkViewConfig> = {},
): WorkViewConfig => ({
	filter: null,
	sort: [],
	groupBy: "status",
	subGroupBy: null,
	columns: [],
	cardFields: [],
	showSubtasks: "nested",
	showClosed: false,
	timeline: {
		zoom: "week",
		rowsBy: "list",
		showDependencies: true,
		showWeekends: true,
	},
	calendar: { mode: "month", dateField: "due" },
	collapsedGroups: [],
	...over,
});

export function defaultViews(projectId: string): WorkView[] {
	const base = { projectId, listId: null, ownerId: null, isDefault: false };
	return [
		{
			...base,
			id: `wvw_${projectId.slice(4)}_list`,
			name: "List",
			kind: "table",
			config: defaultViewConfig(),
			position: rankAt(0),
			isDefault: true,
		},
		{
			...base,
			id: `wvw_${projectId.slice(4)}_board`,
			name: "Board",
			kind: "board",
			config: defaultViewConfig(),
			position: rankAt(1),
		},
		{
			...base,
			id: `wvw_${projectId.slice(4)}_timeline`,
			name: "Timeline",
			kind: "timeline",
			config: defaultViewConfig({ groupBy: null }),
			position: rankAt(2),
		},
		{
			...base,
			id: `wvw_${projectId.slice(4)}_calendar`,
			name: "Calendar",
			kind: "calendar",
			config: defaultViewConfig({ groupBy: null }),
			position: rankAt(3),
		},
	];
}

export function seedStatuses(projectId: string): WorkStatus[] {
	return statusSeed.map(([name, color, category], i) => ({
		id: `wst_${projectId.slice(4)}_${i}`,
		projectId,
		name,
		color,
		category,
		position: rankAt(i),
		wipLimit: name === "In progress" ? 5 : null,
	}));
}

const S = { backlog: 0, todo: 1, doing: 2, review: 3, done: 4, cancelled: 5 };

/** [list suffix, title, status, priority, assignee indexes, start, due, extras]. */
type Seed = [
	string,
	string,
	keyof typeof S,
	WorkPriority,
	number[],
	number | null,
	number | null,
	{
		parent?: number;
		milestone?: boolean;
		estimate?: number;
		description?: string[];
		tags?: string[];
		fields?: Record<string, unknown>;
	}?,
];

const seeds: Record<string, Seed[]> = {
	prj_shop: [
		[
			"launch",
			"Define launch scope",
			"done",
			"high",
			[0],
			-60,
			-50,
			{ estimate: 240 },
		],
		[
			"launch",
			"Product catalogue import",
			"done",
			"normal",
			[2],
			-50,
			-35,
			{ tags: ["backend"] },
		],
		[
			"launch",
			"Checkout flow redesign",
			"doing",
			"urgent",
			[1, 2],
			-14,
			5,
			{
				estimate: 1200,
				tags: ["frontend", "payments"],
				description: [
					"One-page checkout with address autocomplete and guest checkout.",
					"Keep the current payment step until Stripe is live.",
				],
				fields: {
					client: "opt_retail",
					budget: "4800.00",
					reviewer: "usr_giulia",
				},
			},
		],
		[
			"launch",
			"Stripe payments integration",
			"review",
			"high",
			[2],
			-10,
			2,
			{
				estimate: 600,
				tags: ["payments", "backend"],
				fields: { budget: "2500.00", approved: false },
			},
		],
		[
			"launch",
			"Shipping rates by zone",
			"todo",
			"normal",
			[3],
			3,
			12,
			{ estimate: 360, fields: { client: "opt_wholesale" } },
		],
		[
			"launch",
			"Order confirmation emails",
			"todo",
			"normal",
			[1],
			5,
			14,
			{ estimate: 240 },
		],
		[
			"launch",
			"Launch day",
			"todo",
			"high",
			[0],
			30,
			30,
			{ milestone: true, fields: { launch: dayOf(30) } },
		],
		[
			"launch",
			"Load test storefront",
			"backlog",
			"normal",
			[2],
			18,
			24,
			{ tags: ["backend"] },
		],
		["backlog", "Wishlist feature", "backlog", "low", [], null, null],
		[
			"backlog",
			"Gift cards",
			"backlog",
			"none",
			[],
			null,
			null,
			{ tags: ["payments"] },
		],
		["backlog", "Product reviews", "backlog", "low", [3], null, 60],
		[
			"backlog",
			"Search with typo tolerance",
			"todo",
			"normal",
			[2],
			10,
			25,
			{ tags: ["frontend"] },
		],
		[
			"bugs",
			"Cart total rounds wrong with discounts",
			"doing",
			"urgent",
			[2],
			-3,
			-1,
			{
				tags: ["payments"],
				description: [
					"10% off a €19.99 item shows €17.98 in the cart and €17.99 at checkout.",
				],
			},
		],
		[
			"bugs",
			"Mobile menu does not close",
			"todo",
			"high",
			[1],
			null,
			-2,
			{ tags: ["frontend"] },
		],
		[
			"bugs",
			"Image zoom flickers on Safari",
			"review",
			"normal",
			[3],
			-5,
			1,
			{ tags: ["frontend"] },
		],
		["bugs", "404 on old category URLs", "done", "normal", [2], -20, -15],
		[
			"launch",
			"Address autocomplete",
			"done",
			"normal",
			[1],
			-14,
			-7,
			{ parent: 3 },
		],
		["launch", "Guest checkout", "doing", "high", [2], -6, 3, { parent: 3 }],
	],
	prj_blog: [
		["content", "Editorial calendar for Q1", "done", "normal", [0], -40, -30],
		[
			"content",
			"Rewrite About page",
			"review",
			"normal",
			[4],
			-8,
			0,
			{ tags: ["copy"] },
		],
		[
			"content",
			"Migrate 120 posts",
			"doing",
			"high",
			[3, 2],
			-20,
			10,
			{ estimate: 1800 },
		],
		["content", "Author bios", "todo", "low", [4], 2, 9, { tags: ["copy"] }],
		[
			"content",
			"SEO audit of top 50 posts",
			"todo",
			"normal",
			[3],
			5,
			20,
			{ tags: ["seo"] },
		],
		[
			"content",
			"Newsletter signup copy",
			"backlog",
			"none",
			[],
			null,
			null,
			{ tags: ["copy"] },
		],
		["design", "Homepage wireframes", "done", "high", [1], -45, -35],
		["design", "Visual design system", "done", "high", [1], -35, -20],
		[
			"design",
			"Article template build",
			"doing",
			"high",
			[2],
			-10,
			6,
			{ estimate: 900 },
		],
		["design", "Dark mode", "backlog", "low", [], null, 45],
		["design", "Relaunch", "todo", "urgent", [0], 40, 40, { milestone: true }],
		[
			"design",
			"Redirect map old → new URLs",
			"todo",
			"high",
			[2],
			14,
			28,
			{ tags: ["seo"] },
		],
		["content", "Posts 1–60", "done", "normal", [3], -20, -5, { parent: 3 }],
		["content", "Posts 61–120", "doing", "normal", [2], -4, 10, { parent: 3 }],
	],
	prj_brand: [
		["identity", "Logo refinements", "done", "high", [1], -30, -18],
		["identity", "Colour palette", "review", "normal", [1], -10, 1],
		["identity", "Typography pairing", "doing", "normal", [1], -6, 7],
		["identity", "Icon set", "todo", "low", [4], 8, 30],
		[
			"guide",
			"Brand book layout",
			"todo",
			"normal",
			[1],
			14,
			45,
			{ estimate: 1200 },
		],
		["guide", "Photography guidelines", "backlog", "low", [], null, null],
		[
			"guide",
			"Print the brand book",
			"backlog",
			"normal",
			[0],
			50,
			60,
			{ tags: ["print"] },
		],
		[
			"guide",
			"Client sign-off",
			"todo",
			"high",
			[0],
			62,
			62,
			{ milestone: true },
		],
	],
};

export function createWorkFixture() {
	const seed: Pick<
		WorkProjectRow,
		| "projectId"
		| "name"
		| "key"
		| "folderPath"
		| "health"
		| "since"
		| "services"
	>[] = [
		{
			projectId: "prj_shop",
			name: "Shop",
			key: "SHOP",
			folderPath: ["Clients"],
			health: "operational",
			since: isoAgo(6 * 24 * 60),
			services: [
				{
					id: "svc_shop_web",
					name: "Storefront",
					icon: "nextdotjs",
					health: "operational",
					since: isoAgo(6 * 24 * 60),
					uptime30d: 99.98,
					days: health30({ 12: "degraded" }),
					url: "https://shop.acme.studio",
				},
				{
					id: "svc_shop_db",
					name: "Database",
					icon: "postgresql",
					health: "operational",
					since: isoAgo(40 * 24 * 60),
					uptime30d: null,
					days: null,
					url: null,
				},
			],
		},
		{
			projectId: "prj_blog",
			name: "Blog relaunch",
			key: "BLOG",
			folderPath: ["Clients"],
			health: "degraded",
			since: isoAgo(48),
			services: [
				{
					id: "svc_blog_web",
					name: "Blog",
					icon: "wordpress",
					health: "degraded",
					since: isoAgo(48),
					uptime30d: 99.2,
					days: health30({ 3: "down", 4: "degraded", 29: "degraded" }),
					url: "https://blog.acme.studio",
				},
				{
					id: "svc_blog_db",
					name: "Database",
					icon: "mysql",
					health: "operational",
					since: isoAgo(20 * 24 * 60),
					uptime30d: null,
					days: null,
					url: null,
				},
			],
		},
		{
			projectId: "prj_brand",
			name: "Brand book",
			key: "BRAND",
			folderPath: [],
			health: "unknown",
			since: null,
			services: [],
		},
	];
	const projects: WorkProjectRow[] = seed.map((p) => ({
		...p,
		workingDays: 31,
		timeTracking: true,
		allowShareLinks: p.projectId === "prj_shop",
		guestsAssignable: false,
		guestsCanCreate: false,
		defaultListId: null,
		closingStatusId: null,
		timeLockedBefore: null,
		archived: false,
		nextNumber: 1,
		hiddenServiceIds: [],
		repos: [],
	}));

	const listSeed: Record<string, [string, string, WorkColor][]> = {
		prj_shop: [
			["launch", "Launch", "blue"],
			["backlog", "Product backlog", "gray"],
			["bugs", "Bugs", "red"],
		],
		prj_blog: [
			["content", "Content", "teal"],
			["design", "Design & build", "violet"],
		],
		prj_brand: [
			["identity", "Identity", "pink"],
			["guide", "Guidelines", "amber"],
		],
	};
	const lists: WorkList[] = Object.entries(listSeed).flatMap(
		([projectId, ls]) =>
			ls.map(([suffix, name, color], i) => ({
				id: `wls_${projectId.slice(4)}_${suffix}`,
				projectId,
				name,
				description: null,
				color,
				icon: null,
				position: rankAt(i),
				archivedAt: null,
			})),
	);
	for (const p of projects)
		p.defaultListId =
			lists.find((l) => l.projectId === p.projectId)?.id ?? null;

	const statuses = projects.flatMap((p) => seedStatuses(p.projectId));
	const views = projects.flatMap((p) => defaultViews(p.projectId));

	const fields: WorkField[] = [
		{
			id: "wfd_shop_client",
			projectId: "prj_shop",
			listId: null,
			name: "Client type",
			kind: "select",
			config: {
				kind: "select",
				options: [
					{ id: "opt_retail", label: "Retail", color: "blue" },
					{ id: "opt_wholesale", label: "Wholesale", color: "teal" },
					{ id: "opt_internal", label: "Internal", color: "gray" },
				],
			},
			required: false,
			description: "Which customers this change is for",
			position: rankAt(0),
		},
		{
			id: "wfd_shop_budget",
			projectId: "prj_shop",
			listId: null,
			name: "Budget",
			kind: "currency",
			config: { kind: "currency", currency: "EUR", decimals: 2 },
			required: false,
			description: null,
			position: rankAt(1),
		},
		{
			id: "wfd_shop_reviewer",
			projectId: "prj_shop",
			listId: null,
			name: "Reviewer",
			kind: "user",
			config: { kind: "user", multiple: false },
			required: false,
			description: null,
			position: rankAt(2),
		},
		{
			id: "wfd_shop_launch",
			projectId: "prj_shop",
			listId: "wls_shop_launch",
			name: "Go-live",
			kind: "date",
			config: { kind: "date", withTime: false },
			required: false,
			description: null,
			position: rankAt(3),
		},
		{
			id: "wfd_shop_approved",
			projectId: "prj_shop",
			listId: null,
			name: "Client approved",
			kind: "checkbox",
			config: { kind: "checkbox" },
			required: false,
			description: null,
			position: rankAt(4),
		},
		{
			id: "wfd_blog_type",
			projectId: "prj_blog",
			listId: null,
			name: "Content type",
			kind: "select",
			config: {
				kind: "select",
				options: [
					{ id: "opt_page", label: "Page", color: "violet" },
					{ id: "opt_post", label: "Post", color: "green" },
				],
			},
			required: false,
			description: null,
			position: rankAt(0),
		},
	];

	const tagSeed: Record<string, [string, WorkColor][]> = {
		prj_shop: [
			["frontend", "blue"],
			["backend", "violet"],
			["payments", "amber"],
		],
		prj_blog: [
			["seo", "green"],
			["copy", "pink"],
		],
		prj_brand: [["print", "teal"]],
	};
	const tags: WorkTag[] = Object.entries(tagSeed).flatMap(([projectId, ts]) =>
		ts.map(([name, color]) => ({
			id: `wtg_${projectId.slice(4)}_${name}`,
			projectId,
			name,
			color,
		})),
	);

	const fieldIds: Record<string, string> = {
		client: "wfd_shop_client",
		budget: "wfd_shop_budget",
		reviewer: "wfd_shop_reviewer",
		launch: "wfd_shop_launch",
		approved: "wfd_shop_approved",
	};

	const tasks: WorkTaskRow[] = [];
	for (const p of projects) {
		const short = p.projectId.slice(4);
		const projectStatuses = statuses.filter((s) => s.projectId === p.projectId);
		for (const [
			list,
			title,
			status,
			priority,
			who,
			start,
			due,
			extra = {},
		] of seeds[p.projectId] ?? []) {
			const number = p.nextNumber++;
			const statusRow = projectStatuses[S[status]];
			const created = Math.max(start ? -start : 0, 1) + 10;
			const assigneeIds = who.map((i) => U[i] as string);
			const creator = U[0] as string;
			tasks.push({
				id: `tsk_${short}_${number}`,
				projectId: p.projectId,
				listId: `wls_${short}_${list}`,
				parentId:
					extra.parent !== undefined ? `tsk_${short}_${extra.parent}` : null,
				number,
				title,
				description: extra.description ? doc(...extra.description) : null,
				statusId: statusRow?.id ?? "",
				priority,
				startDate: start === null ? null : dayOf(start),
				dueDate: due === null ? null : dayOf(due),
				dueTime: null,
				isMilestone: extra.milestone ?? false,
				estimateMinutes: extra.estimate ?? null,
				position: rankAt(number),
				recurrence: null,
				recurrenceSeriesId: null,
				source: null,
				createdBy: creator,
				completedAt:
					statusRow?.category === "done"
						? `${dayOf(due ?? 0)}T16:00:00.000Z`
						: null,
				archivedAt: null,
				createdAt: isoAgo(created * 24 * 60),
				updatedAt: isoAgo(Math.max(1, created - 5) * 60),
				assigneeIds,
				tagIds: (extra.tags ?? []).map((t) => `wtg_${short}_${t}`),
				fields: Object.fromEntries(
					Object.entries(extra.fields ?? {}).map(([k, v]) => [
						fieldIds[k] ?? k,
						v,
					]),
				),
				watchers: [
					{ userId: creator, reason: "creator", muted: false },
					...assigneeIds
						.filter((u) => u !== creator)
						.map((userId) => ({
							userId,
							reason: "assignee" as const,
							muted: false,
						})),
				],
			});
		}
	}
	// A weekly recurring task: the client check-in.
	const checkIn = tasks.find((t) => t.id === "tsk_blog_4");
	if (checkIn) {
		checkIn.recurrence = {
			freq: "weekly",
			interval: 1,
			byWeekday: [1],
			mode: "on_complete",
			ends: { kind: "never" },
			copy: {
				subtasks: false,
				checklist: true,
				fields: true,
				assignees: true,
				description: true,
			},
		};
		checkIn.recurrenceSeriesId = "rcs_blog_bios";
	}

	const checklistSeed: [string, string, boolean, string | null][] = [
		["tsk_shop_3", "Wireframe review with client", true, "usr_simone"],
		["tsk_shop_3", "Accessibility pass", false, "usr_giulia"],
		["tsk_shop_3", "Copy for error states", false, null],
		["tsk_shop_4", "Webhooks verified in test mode", true, "usr_marco"],
		["tsk_shop_4", "Refund flow tested", false, "usr_marco"],
		["tsk_blog_2", "Client approves draft", false, "usr_tom"],
		["tsk_blog_2", "Photos from the shoot", true, null],
	];
	const checklist: WorkChecklistItem[] = checklistSeed.map(
		([taskId, text, done, assigneeId], i) => ({
			id: `wci_${i + 1}`,
			taskId,
			text,
			done,
			doneBy: done ? (assigneeId ?? WORK_ME) : null,
			doneAt: done ? isoAgo(60 * 24 * 2) : null,
			assigneeId,
			position: rankAt(i),
		}),
	);

	const dependencies: WorkDependencyRow[] = [
		["tsk_shop_5", "tsk_shop_4"],
		["tsk_shop_6", "tsk_shop_4"],
		["tsk_shop_7", "tsk_shop_3"],
		["tsk_shop_7", "tsk_shop_8"],
		["tsk_blog_9", "tsk_blog_8"],
		["tsk_blog_11", "tsk_blog_9"],
		["tsk_blog_11", "tsk_blog_12"],
		["tsk_brand_5", "tsk_brand_2"],
		["tsk_brand_5", "tsk_brand_3"],
		["tsk_brand_8", "tsk_brand_5"],
	].map(([taskId, blockedById]) => ({
		taskId: taskId as string,
		blockedById: blockedById as string,
		lagDays: 0,
	}));

	const mention = (userId: string, label: string, after: string): PmDoc => ({
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{ type: "mention", attrs: { id: userId, label } },
					{ type: "text", text: after },
				],
			},
		],
	});
	const comment = (
		id: string,
		taskId: string,
		authorId: string,
		body: PmDoc,
		minutesAgo: number,
		extra: Partial<WorkComment> = {},
	): WorkComment => ({
		id,
		taskId,
		authorId,
		parentId: null,
		body,
		bodyText: (body.content ?? [])
			.flatMap((n) => n.content ?? [])
			.map((n) => n.text ?? `@${String(n.attrs?.label ?? "")}`)
			.join(""),
		editedAt: null,
		deletedAt: null,
		resolvedAt: null,
		resolvedBy: null,
		createdAt: isoAgo(minutesAgo),
		reactions: [],
		attachments: [],
		...extra,
	});
	const comments: WorkComment[] = [
		comment(
			"wcm_1",
			"tsk_shop_3",
			"usr_giulia",
			mention(
				"usr_simone",
				"Simone Maddiona",
				" can the client confirm guest checkout is in scope?",
			),
			60 * 26,
			{ reactions: [{ emoji: "👀", userIds: ["usr_marco"] }] },
		),
		comment(
			"wcm_2",
			"tsk_shop_3",
			"usr_simone",
			doc("Confirmed on the call this morning. It's in."),
			60 * 20,
			{
				parentId: "wcm_1",
				reactions: [{ emoji: "👍", userIds: ["usr_giulia", "usr_marco"] }],
			},
		),
		comment(
			"wcm_3",
			"tsk_shop_13",
			"usr_marco",
			doc("Reproduced. The discount is rounded per line, the total per order."),
			60 * 5,
		),
		comment(
			"wcm_4",
			"tsk_blog_2",
			"usr_tom",
			doc("Draft is in the shared folder, waiting for the client's notes."),
			60 * 30,
		),
		comment(
			"wcm_5",
			"tsk_brand_2",
			"usr_giulia",
			doc("Two options attached. I prefer the warmer one."),
			60 * 50,
			{
				reactions: [{ emoji: "🎉", userIds: ["usr_simone"] }],
			},
		),
	];

	const activity: WorkActivity[] = tasks.flatMap((t, i) => {
		const entries: WorkActivity[] = [
			{
				id: `wac_${i}_c`,
				taskId: t.id,
				actorId: t.createdBy,
				kind: "created",
				data: {},
				createdAt: t.createdAt,
			},
		];
		const statusRow = statuses.find((s) => s.id === t.statusId);
		if (statusRow && statusRow.position !== rankAt(0))
			entries.push({
				id: `wac_${i}_s`,
				taskId: t.id,
				actorId: t.assigneeIds[0] ?? t.createdBy,
				kind: "status",
				data: { from: "To do", to: statusRow.name },
				createdAt: t.updatedAt,
			});
		return entries;
	});

	const attachments: WorkAttachment[] = [
		{
			id: "wat_1",
			projectId: "prj_brand",
			taskId: "tsk_brand_2",
			commentId: "wcm_5",
			inlineIn: "none",
			uploaderId: "usr_giulia",
			name: "palette-warm.png",
			contentType: "image/png",
			size: 182_340,
			width: 1600,
			height: 1000,
			url: "/api/work/attachments/wat_1",
			thumbUrl: "/api/work/attachments/wat_1?thumb=1",
			createdAt: isoAgo(60 * 50),
		},
	];

	const notification = (
		id: string,
		kind: WorkNotification["kind"],
		taskId: string,
		actorId: string | null,
		minutesAgo: number,
		read = false,
		commentId: string | null = null,
	): WorkNotification => {
		const t = tasks.find((x) => x.id === taskId);
		const p = projects.find((x) => x.projectId === t?.projectId);
		return {
			id,
			kind,
			organizationId: WORK_ORG.id,
			projectId: p?.projectId ?? "",
			projectName: p?.name ?? "",
			taskId,
			taskKey: `${p?.key}-${t?.number}`,
			taskTitle: t?.title ?? "",
			commentId,
			actorId,
			data: {},
			readAt: read ? isoAgo(minutesAgo - 5) : null,
			createdAt: isoAgo(minutesAgo),
		};
	};
	const notifications: WorkNotification[] = [
		notification(
			"wnt_1",
			"mentioned",
			"tsk_shop_3",
			"usr_giulia",
			60 * 26,
			false,
			"wcm_1",
		),
		notification("wnt_2", "assigned", "tsk_shop_7", "usr_giulia", 60 * 8),
		notification("wnt_3", "overdue", "tsk_shop_13", null, 60 * 3),
		notification(
			"wnt_4",
			"commented",
			"tsk_blog_2",
			"usr_tom",
			60 * 30,
			true,
			"wcm_4",
		),
		notification(
			"wnt_5",
			"status_changed",
			"tsk_shop_16",
			"usr_marco",
			60 * 24 * 15,
			true,
		),
		notification("wnt_6", "due_soon", "tsk_blog_11", null, 60 * 2),
	];

	const entry = (
		i: number,
		taskId: string,
		userId: string,
		daysAgo: number,
		hours: number,
	): WorkTimeEntry => {
		const t = tasks.find((x) => x.id === taskId);
		const p = projects.find((x) => x.projectId === t?.projectId);
		const start = new Date(now - daysAgo * DAY);
		start.setUTCHours(9, 0, 0, 0);
		return {
			id: `wte_${i}`,
			projectId: p?.projectId ?? "",
			taskId,
			taskKey: `${p?.key}-${t?.number}`,
			taskTitle: t?.title ?? "",
			userId,
			startedAt: start.toISOString(),
			endedAt: new Date(start.getTime() + hours * 3_600_000).toISOString(),
			durationSec: Math.round(hours * 3600),
			note: null,
			billable: true,
			source: "manual",
			locked: false,
			createdAt: start.toISOString(),
		};
	};
	const timeEntries: WorkTimeEntry[] = [
		entry(1, "tsk_shop_3", WORK_ME, 1, 2.5),
		entry(2, "tsk_shop_3", "usr_giulia", 2, 4),
		entry(3, "tsk_shop_4", "usr_marco", 1, 3),
		entry(4, "tsk_shop_13", "usr_marco", 0, 1.5),
		entry(5, "tsk_blog_3", "usr_ana", 3, 6),
		entry(6, "tsk_blog_9", "usr_marco", 2, 5),
		entry(7, "tsk_brand_3", "usr_giulia", 1, 2),
		entry(8, "tsk_blog_2", WORK_ME, 4, 1),
	];

	const templates: WorkTemplate[] = [
		{
			id: "wtp_website_launch",
			organizationId: WORK_ORG.id,
			projectId: null,
			kind: "list",
			name: "Website launch",
			description: "Discovery, design, build, content, QA and the launch day.",
			payload: {
				lists: [
					{
						name: "Website launch",
						color: "blue",
						icon: null,
						tasks: ["Discovery", "Design", "Build", "Content", "QA"].map(
							(title, i) => ({
								title,
								description: null,
								priority: "normal" as const,
								startOffset: i * 10,
								dueOffset: i * 10 + 9,
								isMilestone: false,
								estimateMinutes: null,
								statusRef: null,
								tagRefs: [],
								fieldValues: [],
								assigneeRefs: [
									{ placeholder: i < 2 ? "Designer" : "Developer" },
								],
								checklist: [],
								subtasks: [],
								attachmentShas: [],
								dependsOn: i > 0 ? [i - 1] : [],
							}),
						),
					},
				],
			},
			createdBy: null,
			usageCount: 3,
			builtin: true,
			createdAt: isoAgo(60 * 24 * 90),
			updatedAt: isoAgo(60 * 24 * 90),
		},
	];

	const prefs: WorkPrefs = {
		email: "off",
		emailKinds: ["assigned", "mentioned", "due_soon", "overdue"],
		dailyHour: 8,
		timezone: null,
		capacityHoursPerWeek: 32,
		icalEnabled: false,
		mailAvailable: false,
	};

	return {
		projects,
		lists,
		statuses,
		views,
		fields,
		tags,
		tasks,
		checklist,
		dependencies,
		comments,
		activity,
		attachments,
		notifications,
		timeEntries,
		/** Running timer of the mock user, if any. */
		timer: null as WorkTimeEntry | null,
		templates,
		shares: [] as WorkShare[],
		prefs,
	};
}
