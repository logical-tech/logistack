/* In-memory Work API over `work-fixture.ts`, for VITE_API_MOCK=1. */
import type {
	DueBucket,
	FilterNode,
	InstanceMail,
	PmDoc,
	PmNode,
	WorkComment,
	WorkDependencyEdge,
	WorkFeedItem,
	WorkList,
	WorkProject,
	WorkSort,
	WorkStatus,
	WorkTask,
	WorkTaskListItem,
	WorkTaskListQuery,
	WorkTimeEntry,
	WorkView,
	WorkViewConfig,
} from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { WorkApi } from "../work";
import {
	createWorkFixture,
	dayOf,
	defaultViews,
	rankAt,
	seedStatuses,
	WORK_ME,
	WORK_ORG,
	type WorkTaskRow,
	withViewsDemo,
	workUsers,
} from "./work-fixture";
import { workImportsMock } from "./work-imports";

const w = withViewsDemo(createWorkFixture());

const noMail: InstanceMail = {
	configured: false,
	transport: null,
	host: null,
	port: null,
	secure: false,
	username: null,
	from: null,
	hasSecret: false,
};
let mail = noMail;

function delay<T>(value: T, ms = 120 + Math.random() * 220): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}
const fail = (status: number, code: string, message: string): never => {
	throw new ApiError(status, message, code);
};
const notFound = (what: string) => fail(404, "not_found", `${what} not found`);
const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const nowIso = () => new Date().toISOString();
const today = () => dayOf(0);

const find = <T>(rows: T[], pred: (r: T) => boolean, what: string): T =>
	rows.find(pred) ?? notFound(what);
/**
 * Like the server's lazy `work_project` insert: any other project id (the ops mock's projects)
 * gets statuses, one list and the four views the first time Work opens on it.
 */
function seedProject(id: string) {
	const slug = id.slice(4);
	const name = slug.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
	let key =
		slug
			.replace(/[^a-z]/gi, "")
			.slice(0, 4)
			.toUpperCase() || "WORK";
	while (w.projects.some((p) => p.key === key))
		key = `${key.slice(0, 3)}${Math.floor(Math.random() * 9)}`;
	const listId = `wls_${slug}_tasks`;
	w.projects.push({
		...(w.projects[0] as (typeof w.projects)[number]),
		projectId: id,
		name,
		key,
		folderPath: [],
		health: "unknown",
		since: null,
		services: [],
		nextNumber: 1,
		defaultListId: listId,
		allowShareLinks: false,
		hiddenServiceIds: [],
		repos: [],
	});
	w.lists.push({
		id: listId,
		projectId: id,
		name: "Tasks",
		description: null,
		color: "blue",
		icon: null,
		position: rankAt(0),
		archivedAt: null,
	});
	w.statuses.push(...seedStatuses(id));
	w.views.push(...defaultViews(id));
}
const project = (id: string) => {
	if (
		!w.projects.some((p) => p.projectId === id) &&
		/^prj_[a-z0-9_-]+$/.test(id)
	)
		seedProject(id);
	return find(w.projects, (p) => p.projectId === id, "project");
};
const task = (id: string) => find(w.tasks, (t) => t.id === id, "task");
const statusOf = (id: string) => find(w.statuses, (s) => s.id === id, "status");
const keyOf = (t: WorkTaskRow) => `${project(t.projectId).key}-${t.number}`;
const closed = (t: WorkTaskRow) => {
	const c = statusOf(t.statusId).category;
	return c === "done" || c === "cancelled";
};
const userName = (id: string) =>
	workUsers.find((u) => u.userId === id)?.name ?? id;

function blockedBy(t: WorkTaskRow): WorkDependencyEdge[] {
	return w.dependencies
		.filter((d) => d.taskId === t.id)
		.map((d) => edge(task(d.blockedById), d.lagDays));
}
function edge(t: WorkTaskRow, lagDays: number): WorkDependencyEdge {
	return {
		id: t.id,
		key: keyOf(t),
		title: t.title,
		statusId: t.statusId,
		projectId: t.projectId,
		lagDays,
		done: closed(t),
	};
}

function toItem(t: WorkTaskRow): WorkTaskListItem {
	const subs = w.tasks.filter((s) => s.parentId === t.id && !s.archivedAt);
	const items = w.checklist.filter((c) => c.taskId === t.id);
	const { description: _d, watchers: _w, recurrence, source: _s, ...rest } = t;
	const { recurrenceSeriesId: _r, ...row } = rest;
	return {
		...row,
		key: keyOf(t),
		recurring: recurrence !== null,
		counts: {
			subtasks: subs.length,
			subtasksDone: subs.filter(closed).length,
			checklist: items.length,
			checklistDone: items.filter((c) => c.done).length,
			comments: w.comments.filter((c) => c.taskId === t.id && !c.deletedAt)
				.length,
			attachments: w.attachments.filter((a) => a.taskId === t.id).length,
		},
		blocked: blockedBy(t).some((e) => !e.done),
		trackedSec: w.timeEntries
			.filter((e) => e.taskId === t.id)
			.reduce((s, e) => s + (e.durationSec ?? 0), 0),
	};
}

function toTask(t: WorkTaskRow): WorkTask {
	const item = toItem(t);
	const parent = t.parentId ? task(t.parentId) : null;
	return {
		...item,
		assigneeIds: t.assigneeIds,
		tagIds: t.tagIds,
		fields: t.fields,
		counts: item.counts ?? notFound("counts"),
		blocked: item.blocked ?? false,
		description: t.description,
		descriptionText: t.description ? docText(t.description) : null,
		watchers: t.watchers,
		watching: t.watchers.some((x) => x.userId === WORK_ME && !x.muted),
		parent: parent
			? {
					id: parent.id,
					key: keyOf(parent),
					title: parent.title,
					statusId: parent.statusId,
					projectId: parent.projectId,
				}
			: null,
		subtasks: w.tasks
			.filter((s) => s.parentId === t.id && !s.archivedAt)
			.sort(byPosition)
			.map(toItem),
		checklist: w.checklist
			.filter((c) => c.taskId === t.id)
			.sort((a, b) => a.position.localeCompare(b.position)),
		dependencies: {
			blockedBy: blockedBy(t),
			blocking: w.dependencies
				.filter((d) => d.blockedById === t.id)
				.map((d) => edge(task(d.taskId), d.lagDays)),
		},
		attachments: w.attachments.filter((a) => a.taskId === t.id),
		recurrence: t.recurrence,
		recurrenceSeriesId: t.recurrenceSeriesId,
		source: t.source,
		git: { summary: { pullRequests: { open: 0, merged: 0 }, commits: 0 } },
	};
}

function docText(d: PmNode): string {
	if (d.text) return d.text;
	if (d.type === "mention") return `@${String(d.attrs?.label ?? "")}`;
	const inner = (d.content ?? []).map(docText);
	return d.type === "doc" ? inner.join("\n") : inner.join("");
}

const byPosition = (a: { position: string }, b: { position: string }) =>
	a.position.localeCompare(b.position);

/** Rewrites positions of a list's siblings in their current order. */
function renumber(rows: { position: string }[]) {
	rows.sort(byPosition).forEach((r, i) => {
		r.position = rankAt(i * 10);
	});
}

/** Places `row` among `siblings` before/after another id (default: last). */
function place<R extends { id: string; position: string }>(
	row: R,
	siblings: R[],
	at: { before?: string; after?: string },
) {
	const others = siblings.filter((s) => s.id !== row.id).sort(byPosition);
	let i = others.length;
	if (at.before)
		i = Math.max(
			0,
			others.findIndex((s) => s.id === at.before),
		);
	else if (at.after) i = others.findIndex((s) => s.id === at.after) + 1;
	others.splice(i, 0, row);
	others.forEach((r, n) => {
		r.position = rankAt(n * 10);
	});
}

const touch = (t: WorkTaskRow) => {
	t.updatedAt = nowIso();
};
type ActivityKind = (typeof w.activity)[number]["kind"];
const act = (
	taskId: string,
	kind: ActivityKind,
	data: Record<string, unknown> = {},
) => ({
	id: rid("wac"),
	taskId,
	actorId: WORK_ME,
	kind,
	data,
	createdAt: nowIso(),
});
function log(
	t: WorkTaskRow,
	kind: ActivityKind,
	data: Record<string, unknown> = {},
) {
	touch(t);
	w.activity.push(act(t.id, kind, data));
}

// --- filters --------------------------------------------------------------

function dueBucket(due: string | null): DueBucket {
	if (!due) return "none";
	const d = (Date.parse(due) - Date.parse(today())) / 86_400_000;
	if (d < 0) return "overdue";
	if (d === 0) return "today";
	if (d === 1) return "tomorrow";
	const dow = (new Date(today()).getUTCDay() + 6) % 7;
	if (d < 7 - dow) return "this_week";
	if (d < 14 - dow) return "next_week";
	return "later";
}

function inRelative(date: string | null, rel: unknown): boolean {
	if (rel === "no_date") return date === null;
	if (!date) return false;
	const b = dueBucket(date);
	switch (rel) {
		case "overdue":
			return b === "overdue";
		case "today":
			return b === "today";
		case "tomorrow":
			return b === "tomorrow";
		case "this_week":
			return b === "today" || b === "tomorrow" || b === "this_week";
		case "next_week":
			return b === "next_week";
		case "next_7_days":
			return date >= today() && date <= dayOf(7);
		case "next_30_days":
			return date >= today() && date <= dayOf(30);
		case "last_7_days":
			return date >= dayOf(-7) && date <= today();
		default:
			return true;
	}
}

/** shortcut: covers the keys/ops the first UI uses, not all of section 7; swap for core `matchesTask` once the web bundles it. */
function matches(node: FilterNode, t: WorkTaskRow): boolean {
	if ("and" in node) return node.and.every((n) => matches(n, t));
	if ("or" in node) return node.or.some((n) => matches(n, t));
	const { key, op } = node;
	const value = node.value === "me" ? WORK_ME : node.value;
	const values: unknown[] = Array.isArray(value)
		? value.map((v) => (v === "me" ? WORK_ME : v))
		: [value];
	let actual: unknown;
	switch (key) {
		case "status":
			actual = t.statusId;
			break;
		case "statusCategory":
			actual = statusOf(t.statusId).category;
			break;
		case "assignee":
			actual = t.assigneeIds;
			break;
		case "priority":
			actual = t.priority;
			break;
		case "list":
			actual = t.listId;
			break;
		case "tag":
			actual = t.tagIds;
			break;
		case "createdBy":
			actual = t.createdBy;
			break;
		case "parent":
			actual = t.parentId;
			break;
		case "isMilestone":
			actual = t.isMilestone;
			break;
		case "blocked":
			actual = toItem(t).blocked;
			break;
		case "text":
			actual = `${t.title} ${t.description ? docText(t.description) : ""}`;
			break;
		case "startDate":
		case "dueDate":
			actual = t[key];
			break;
		default:
			actual = key.startsWith("field:")
				? t.fields[key.slice(6)]
				: (t as unknown as Record<string, unknown>)[key];
	}
	const list = Array.isArray(actual) ? actual : [actual];
	const empty =
		actual === null ||
		actual === undefined ||
		actual === "" ||
		(Array.isArray(actual) && actual.length === 0);
	switch (op) {
		case "empty":
			return empty;
		case "not_empty":
			return !empty;
		case "is":
		case "eq":
		case "any_of":
		case "on":
			return values.some((v) => list.includes(v));
		case "is_not":
		case "neq":
		case "none_of":
			return !values.some((v) => list.includes(v));
		case "all_of":
			return values.every((v) => list.includes(v));
		case "contains":
			return String(actual ?? "")
				.toLowerCase()
				.includes(String(value ?? "").toLowerCase());
		case "relative":
			return inRelative((actual as string | null) ?? null, value);
		case "before":
		case "lt":
			return !empty && String(actual) < String(value);
		case "after":
		case "gt":
			return !empty && String(actual) > String(value);
		case "lte":
			return !empty && String(actual) <= String(value);
		case "gte":
			return !empty && String(actual) >= String(value);
		case "between":
			return (
				!empty &&
				Array.isArray(value) &&
				String(actual) >= String(value[0]) &&
				String(actual) <= String(value[1])
			);
	}
}

const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 };

function compare(sort: WorkSort[]) {
	return (a: WorkTaskRow, b: WorkTaskRow) => {
		for (const { by, dir } of sort) {
			const get = (t: WorkTaskRow): string | number => {
				if (by === "priority") return priorityRank[t.priority];
				if (by === "status") return statusOf(t.statusId).position;
				if (by === "estimate") return t.estimateMinutes ?? Number.MAX_VALUE;
				if (by.startsWith("field:"))
					return String(t.fields[by.slice(6)] ?? "￿");
				const v = (t as unknown as Record<string, unknown>)[by];
				return typeof v === "number" ? v : String(v ?? "￿");
			};
			const x = get(a);
			const y = get(b);
			if (x !== y) return (x < y ? -1 : 1) * (dir === "asc" ? 1 : -1);
		}
		return byPosition(a, b);
	};
}

function groupValue(t: WorkTaskRow, groupBy: string): string[] {
	switch (groupBy) {
		case "status":
			return [t.statusId];
		case "priority":
			return [t.priority];
		case "assignee":
			return t.assigneeIds.length ? t.assigneeIds : ["none"];
		case "list":
			return [t.listId];
		case "tag":
			return t.tagIds.length ? t.tagIds : ["none"];
		case "dueBucket":
			return [dueBucket(t.dueDate)];
		default: {
			const v = t.fields[groupBy.slice(6)];
			return Array.isArray(v) ? v.map(String) : [String(v ?? "none")];
		}
	}
}

function listTasks(q: WorkTaskListQuery) {
	const view = q.viewId ? w.views.find((v) => v.id === q.viewId) : undefined;
	const filters: FilterNode[] = [];
	if (view?.config.filter) filters.push(view.config.filter);
	if (q.filter) filters.push(JSON.parse(q.filter) as FilterNode);
	const showClosed = q.includeClosed
		? q.includeClosed === "true"
		: (view?.config.showClosed ?? true);
	let rows = w.tasks.filter(
		(t) =>
			(!q.projectId || t.projectId === q.projectId) &&
			(q.assignee !== "me" || t.assigneeIds.includes(WORK_ME)) &&
			(!q.listId || t.listId === q.listId) &&
			(q.includeArchived === "true" || !t.archivedAt) &&
			(!q.parentId || t.parentId === q.parentId) &&
			(q.topLevel !== "true" || t.parentId === null) &&
			(showClosed || !closed(t)) &&
			filters.every((f) => matches(f, t)),
	);
	const groupBy = q.groupBy ?? null;
	if (groupBy && q.group !== undefined)
		rows = rows.filter((t) => groupValue(t, groupBy).includes(q.group ?? ""));
	const sort: WorkSort[] = q.sort
		? (JSON.parse(q.sort) as WorkSort[])
		: (view?.config.sort ?? []);
	return rows.sort(compare(sort));
}

// --- the adapter -----------------------------------------------------------

const projectDto = ({
	folderPath: _f,
	nextNumber: _n,
	health: _h,
	since: _s,
	services: _v,
	...p
}: (typeof w.projects)[number]): WorkProject => p;

const ordered = <T extends { id: string; position: string }>(
	rows: T[],
	ids: string[],
) => {
	for (const r of rows) {
		const i = ids.indexOf(r.id);
		if (i >= 0) r.position = rankAt(i * 10);
	}
	return rows.sort(byPosition);
};

function viewConfig(partial: Partial<WorkViewConfig> = {}): WorkViewConfig {
	const base = w.views[0]?.config ?? notFound("view");
	return { ...structuredClone(base), filter: null, ...partial };
}

function newTaskRow(
	input: Parameters<WorkApi["tasks"]["create"]>[0],
): WorkTaskRow {
	const list = find(w.lists, (l) => l.id === input.listId, "list");
	const p = project(list.projectId);
	const firstActive = w.statuses
		.filter((s) => s.projectId === p.projectId)
		.sort(byPosition)
		.find((s) => s.category === "backlog");
	const t: WorkTaskRow = {
		id: rid("tsk"),
		projectId: p.projectId,
		listId: list.id,
		parentId: input.parentId ?? null,
		number: p.nextNumber++,
		title: input.title,
		description: input.description ?? null,
		statusId: input.statusId ?? firstActive?.id ?? "",
		priority: input.priority ?? "none",
		startDate: input.startDate ?? null,
		dueDate: input.dueDate ?? null,
		dueTime: input.dueTime ?? null,
		isMilestone: input.isMilestone ?? false,
		estimateMinutes: input.estimateMinutes ?? null,
		position: rankAt(0),
		recurrence: null,
		recurrenceSeriesId: null,
		source: null,
		createdBy: WORK_ME,
		completedAt: null,
		archivedAt: null,
		createdAt: nowIso(),
		updatedAt: nowIso(),
		assigneeIds: input.assignees ?? [],
		tagIds: input.tags ?? [],
		fields: input.fields ?? {},
		watchers: [{ userId: WORK_ME, reason: "creator", muted: false }],
	};
	w.tasks.push(t);
	place(
		t,
		w.tasks.filter((x) => x.listId === t.listId && x.parentId === t.parentId),
		input,
	);
	w.activity.push(act(t.id, "created"));
	return t;
}

function setStatus(t: WorkTaskRow, statusId: string) {
	if (t.statusId === statusId) return;
	const from = statusOf(t.statusId);
	const to = statusOf(statusId);
	t.statusId = statusId;
	const done = to.category === "done" || to.category === "cancelled";
	const was = from.category === "done" || from.category === "cancelled";
	if (done && !was) t.completedAt = nowIso();
	if (!done) t.completedAt = null;
	log(t, "status", { from: from.name, to: to.name });
}

function comment(id: string) {
	return find(w.comments, (c) => c.id === id, "comment");
}

function timerEntry(taskId: string): WorkTimeEntry {
	const t = task(taskId);
	return {
		id: rid("wte"),
		projectId: t.projectId,
		taskId,
		taskKey: keyOf(t),
		taskTitle: t.title,
		userId: WORK_ME,
		startedAt: nowIso(),
		endedAt: null,
		durationSec: null,
		note: null,
		billable: true,
		source: "timer",
		locked: false,
		createdAt: nowIso(),
	};
}
function stopTimer(): WorkTimeEntry | null {
	const running = w.timer;
	if (!running) return null;
	running.endedAt = nowIso();
	running.durationSec = Math.max(
		60,
		Math.round((Date.now() - Date.parse(running.startedAt)) / 1000),
	);
	w.timeEntries.push(running);
	w.timer = null;
	return running;
}

const csvBlobUrl = (rows: string[][]) =>
	URL.createObjectURL(
		new Blob(
			[
				rows
					.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(","))
					.join("\n"),
			],
			{ type: "text/csv" },
		),
	);

export const workMock: WorkApi = {
	projects: {
		list: () =>
			delay(
				w.projects.map((p) => {
					const open = w.tasks.filter(
						(t) => t.projectId === p.projectId && !closed(t) && !t.archivedAt,
					);
					return {
						id: p.projectId,
						name: p.name,
						folderPath: p.folderPath,
						key: p.key,
						health: p.health,
						since: p.since,
						hasServices: p.services.length > 0,
						counts: {
							open: open.length,
							overdue: open.filter((t) => dueBucket(t.dueDate) === "overdue")
								.length,
							mine: open.filter((t) => t.assigneeIds.includes(WORK_ME)).length,
							doneThisWeek: w.tasks.filter(
								(t) =>
									t.projectId === p.projectId &&
									t.completedAt &&
									t.completedAt >= `${dayOf(-7)}`,
							).length,
						},
						archived: p.archived,
					};
				}),
			),
		get: async (id) => delay(projectDto(project(id))),
		updateSettings: async (id, patch) => {
			const p = project(id);
			if (patch.key && w.projects.some((x) => x.key === patch.key && x !== p))
				fail(409, "conflict", `key ${patch.key} is taken`);
			Object.assign(p, patch);
			return delay(projectDto(p));
		},
		health: async (id) => {
			const p = project(id);
			return delay({ health: p.health, since: p.since, services: p.services });
		},
		summary: async (id) => {
			project(id);
			const rows = w.tasks.filter((t) => t.projectId === id && !t.archivedAt);
			const statuses = w.statuses.filter((s) => s.projectId === id);
			const byCategory = { backlog: 0, active: 0, done: 0, cancelled: 0 };
			for (const t of rows) byCategory[statusOf(t.statusId).category]++;
			const people = new Map<string | null, { open: number; done: number }>();
			for (const t of rows)
				for (const u of t.assigneeIds.length ? t.assigneeIds : [null]) {
					const e = people.get(u) ?? { open: 0, done: 0 };
					e[closed(t) ? "done" : "open"]++;
					people.set(u, e);
				}
			return delay({
				total: rows.length,
				byStatus: statuses.map((s) => ({
					statusId: s.id,
					count: rows.filter((t) => t.statusId === s.id).length,
				})),
				byCategory,
				byAssignee: [...people].map(([userId, c]) => ({ userId, ...c })),
				overdue: rows.filter(
					(t) => !closed(t) && dueBucket(t.dueDate) === "overdue",
				).length,
				completedPerWeek: Array.from({ length: 12 }, (_, i) => {
					const from = dayOf((i - 12) * 7);
					const to = dayOf((i - 11) * 7);
					return {
						weekStart: from,
						count: rows.filter(
							(t) =>
								t.completedAt &&
								t.completedAt.slice(0, 10) >= from &&
								t.completedAt.slice(0, 10) < to,
						).length,
					};
				}),
				lists: w.lists.filter((l) => l.projectId === id).length,
				attachments: w.attachments.filter((a) => a.projectId === id).length,
			});
		},
		people: async (id) => {
			project(id);
			return delay(
				workUsers.map((u) => ({
					...u,
					assignable: u.userId !== "usr_tom",
					guest: u.userId === "usr_tom",
				})),
			);
		},
		services: async (id) =>
			delay(project(id).services.map(({ id, name }) => ({ id, name }))),
	},
	statuses: {
		list: async (id) =>
			delay(w.statuses.filter((s) => s.projectId === id).sort(byPosition)),
		create: async (projectId, input) => {
			project(projectId);
			const s: WorkStatus = {
				id: rid("wst"),
				projectId,
				wipLimit: null,
				...input,
				position: rankAt(9999),
			};
			w.statuses.push(s);
			renumber(w.statuses.filter((x) => x.projectId === projectId));
			return delay(s);
		},
		update: async (id, patch) => delay(Object.assign(statusOf(id), patch)),
		remove: async (id, moveTo) => {
			const s = statusOf(id);
			const target = statusOf(moveTo);
			const same = w.statuses.filter(
				(x) => x.projectId === s.projectId && x.category === s.category,
			);
			if (
				(s.category === "done" || s.category === "backlog") &&
				same.length < 2
			)
				fail(409, "conflict", `the last ${s.category} status can't be deleted`);
			for (const t of w.tasks) if (t.statusId === id) t.statusId = target.id;
			w.statuses = w.statuses.filter((x) => x.id !== id);
			return delay(undefined);
		},
		reorder: async (projectId, ids) =>
			delay(
				ordered(
					w.statuses.filter((s) => s.projectId === projectId),
					ids,
				),
			),
	},
	lists: {
		list: async (id) =>
			delay(
				w.lists
					.filter((l) => l.projectId === id)
					.sort(byPosition)
					.map((l) => ({
						...l,
						openCount: w.tasks.filter(
							(t) =>
								t.listId === l.id && !t.parentId && !t.archivedAt && !closed(t),
						).length,
					})),
			),
		create: async (projectId, input) => {
			project(projectId);
			const l: WorkList = {
				id: rid("wls"),
				projectId,
				description: null,
				color: null,
				icon: null,
				...input,
				position: rankAt(9999),
				archivedAt: null,
			};
			w.lists.push(l);
			renumber(w.lists.filter((x) => x.projectId === projectId));
			return delay(l);
		},
		update: async (id, patch) =>
			delay(
				Object.assign(
					find(w.lists, (l) => l.id === id, "list"),
					patch,
				),
			),
		remove: async (id, { moveTo, deleteTasks } = {}) => {
			const inList = w.tasks.filter((t) => t.listId === id);
			if (inList.length && !moveTo && !deleteTasks)
				fail(409, "conflict", "the list has tasks");
			if (moveTo) for (const t of inList) t.listId = moveTo;
			else w.tasks = w.tasks.filter((t) => t.listId !== id);
			w.lists = w.lists.filter((l) => l.id !== id);
			return delay(undefined);
		},
		archive: async (id) => {
			const l = find(w.lists, (x) => x.id === id, "list");
			l.archivedAt = nowIso();
			return delay(l);
		},
		restore: async (id) => {
			const l = find(w.lists, (x) => x.id === id, "list");
			l.archivedAt = null;
			return delay(l);
		},
		reorder: async (projectId, ids) =>
			delay(
				ordered(
					w.lists.filter((l) => l.projectId === projectId),
					ids,
				),
			),
	},
	fields: {
		list: async (id) =>
			delay(w.fields.filter((f) => f.projectId === id).sort(byPosition)),
		create: async (projectId, input) => {
			project(projectId);
			const f = {
				id: rid("wfd"),
				projectId,
				listId: input.listId ?? null,
				name: input.name,
				kind: input.config.kind,
				config: input.config,
				required: input.required ?? false,
				description: input.description ?? null,
				position: rankAt(9999),
			};
			w.fields.push(f);
			renumber(w.fields.filter((x) => x.projectId === projectId));
			return delay(f);
		},
		update: async (id, patch) => {
			const f = find(w.fields, (x) => x.id === id, "field");
			if (patch.config && patch.config.kind !== f.kind)
				fail(409, "conflict", "a field's kind can't change");
			return delay(Object.assign(f, patch));
		},
		remove: async (id) => {
			w.fields = w.fields.filter((f) => f.id !== id);
			for (const t of w.tasks) delete t.fields[id];
			return delay(undefined);
		},
		reorder: async (projectId, ids) =>
			delay(
				ordered(
					w.fields.filter((f) => f.projectId === projectId),
					ids,
				),
			),
	},
	tags: {
		list: async (id) => delay(w.tags.filter((t) => t.projectId === id)),
		create: async (projectId, input) => {
			const tag = {
				id: rid("wtg"),
				projectId,
				name: input.name,
				color: input.color ?? "gray",
			};
			w.tags.push(tag);
			return delay(tag);
		},
		update: async (id, patch) =>
			delay(
				Object.assign(
					find(w.tags, (t) => t.id === id, "tag"),
					patch,
				),
			),
		remove: async (id) => {
			w.tags = w.tags.filter((t) => t.id !== id);
			for (const t of w.tasks) t.tagIds = t.tagIds.filter((x) => x !== id);
			return delay(undefined);
		},
	},
	views: {
		list: async (id) =>
			delay(
				w.views
					.filter(
						(v) => v.projectId === id && (!v.ownerId || v.ownerId === WORK_ME),
					)
					.sort(byPosition),
			),
		create: async (projectId, input) => {
			const v: WorkView = {
				id: rid("wvw"),
				projectId,
				listId: input.listId ?? null,
				ownerId: input.shared ? null : WORK_ME,
				name: input.name,
				kind: input.kind,
				config: viewConfig(input.config as Partial<WorkViewConfig>),
				position: rankAt(9999),
				isDefault: input.isDefault ?? false,
			};
			w.views.push(v);
			renumber(w.views.filter((x) => x.projectId === projectId));
			return delay(v);
		},
		update: async (id, patch) => {
			const v = find(w.views, (x) => x.id === id, "view");
			if (patch.name) v.name = patch.name;
			if (patch.isDefault !== undefined) v.isDefault = patch.isDefault;
			if (patch.config)
				v.config = {
					...v.config,
					...(patch.config as Partial<WorkViewConfig>),
				};
			return delay(v);
		},
		remove: async (id) => {
			w.views = w.views.filter((v) => v.id !== id);
			return delay(undefined);
		},
		reorder: async (projectId, ids) =>
			delay(
				ordered(
					w.views.filter((v) => v.projectId === projectId),
					ids,
				),
			),
	},
	tasks: {
		list: async (q) => {
			if (!q.projectId && q.assignee !== "me")
				fail(400, "bad_request", "projectId is required");
			const rows = listTasks(q);
			const offset = Number(q.cursor ?? 0);
			const limit = Number(q.limit ?? 100);
			const page = rows.slice(offset, offset + limit);
			const deps = (q.include ?? "").split(",").includes("dependencies");
			return delay({
				items: page.map((t) =>
					deps
						? {
								...toItem(t),
								dependencies: w.dependencies
									.filter((d) => d.taskId === t.id)
									.map(({ blockedById, lagDays }) => ({
										blockedById,
										lagDays,
									})),
							}
						: toItem(t),
				),
				nextCursor:
					offset + limit < rows.length ? String(offset + limit) : null,
				total: rows.length,
			});
		},
		csvUrl: (q) =>
			csvBlobUrl([
				["Key", "Title", "Status", "Priority", "Start", "Due", "Assignees"],
				...listTasks(q).map((t) => [
					keyOf(t),
					t.title,
					statusOf(t.statusId).name,
					t.priority,
					t.startDate ?? "",
					t.dueDate ?? "",
					t.assigneeIds.map(userName).join("; "),
				]),
			]),
		byKey: async (key) => {
			const [k, n] = key.toUpperCase().split("-");
			const p = find(w.projects, (x) => x.key === k, "task");
			const t = find(
				w.tasks,
				(x) => x.projectId === p.projectId && x.number === Number(n),
				"task",
			);
			return delay({ taskId: t.id, projectId: t.projectId, key: keyOf(t) });
		},
		create: async (input) => delay(toTask(newTaskRow(input))),
		get: async (id) => delay(toTask(task(id))),
		update: async (id, patch) => {
			const t = task(id);
			const { statusId, expectedUpdatedAt, ...rest } = patch;
			if (expectedUpdatedAt && expectedUpdatedAt !== t.updatedAt)
				throw new ApiError(
					409,
					"someone else changed this task",
					"conflict",
					toTask(t),
				);
			if (statusId) setStatus(t, statusId);
			if (rest.priority && rest.priority !== t.priority)
				log(t, "priority", { from: t.priority, to: rest.priority });
			if (
				(rest.startDate !== undefined && rest.startDate !== t.startDate) ||
				(rest.dueDate !== undefined && rest.dueDate !== t.dueDate)
			)
				log(t, "dates", {
					from: [t.startDate, t.dueDate],
					to: [rest.startDate ?? t.startDate, rest.dueDate ?? t.dueDate],
				});
			Object.assign(t, rest);
			if (t.isMilestone && t.dueDate) t.startDate = t.dueDate;
			touch(t);
			return delay(toTask(t));
		},
		move: async (id, input) => {
			const t = task(id);
			if (input.statusId) setStatus(t, input.statusId);
			if (input.listId && input.listId !== t.listId) {
				log(t, "list_moved", { from: t.listId, to: input.listId });
				t.listId = input.listId;
			}
			if (input.parentId !== undefined) t.parentId = input.parentId;
			place(
				t,
				w.tasks.filter(
					(x) => x.listId === t.listId && x.parentId === t.parentId,
				),
				input,
			);
			touch(t);
			return delay(toTask(t));
		},
		moveProject: async (id, input, dryRun = false) => {
			const t = task(id);
			const target = project(input.projectId);
			const dropped = Object.keys(t.fields)
				.filter((f) => !input.fieldMap?.[f])
				.map((fieldId) => ({
					fieldId,
					name: w.fields.find((f) => f.id === fieldId)?.name ?? fieldId,
					reason: "no matching field in the target project",
				}));
			const number = dryRun ? target.nextNumber : target.nextNumber++;
			if (!dryRun) {
				const from = statusOf(t.statusId);
				const statuses = w.statuses.filter(
					(s) => s.projectId === target.projectId,
				);
				t.statusId =
					input.statusMap?.[t.statusId] ??
					(
						statuses.find((s) => s.name === from.name) ??
						statuses.find((s) => s.category === from.category) ??
						statuses[0]
					)?.id ??
					t.statusId;
				t.fields = Object.fromEntries(
					Object.entries(t.fields)
						.filter(([f]) => input.fieldMap?.[f])
						.map(([f, v]) => [input.fieldMap?.[f] ?? f, v]),
				);
				t.projectId = target.projectId;
				t.listId = input.listId;
				t.number = number;
				t.tagIds = [];
				log(t, "project_moved", { to: target.name });
			}
			return delay({
				taskId: t.id,
				number,
				key: `${target.key}-${number}`,
				dropped,
				dryRun,
			});
		},
		duplicate: async (id, opts) => {
			const src = task(id);
			const copy = newTaskRow({
				listId: src.listId,
				title: opts.title ?? `${src.title} (copy)`,
				parentId: src.parentId,
				statusId: src.statusId,
				priority: src.priority,
				startDate: src.startDate,
				dueDate: src.dueDate,
				description: src.description,
				fields: opts.fields === false ? {} : structuredClone(src.fields),
				assignees: opts.assignees ? [...src.assigneeIds] : [],
				tags: [...src.tagIds],
				after: src.id,
			});
			if (opts.checklist !== false)
				for (const c of w.checklist.filter((x) => x.taskId === id))
					w.checklist.push({
						...c,
						id: rid("wci"),
						taskId: copy.id,
						done: false,
						doneAt: null,
						doneBy: null,
					});
			return delay(toTask(copy));
		},
		archive: async (id) => {
			const t = task(id);
			t.archivedAt = nowIso();
			log(t, "archived");
			return delay(toTask(t));
		},
		restore: async (id) => {
			const t = task(id);
			t.archivedAt = null;
			log(t, "restored");
			return delay(toTask(t));
		},
		remove: async (id) => {
			task(id);
			w.tasks = w.tasks.filter((t) => t.id !== id && t.parentId !== id);
			w.dependencies = w.dependencies.filter(
				(d) => d.taskId !== id && d.blockedById !== id,
			);
			return delay(undefined);
		},
		bulk: async ({ taskIds, set, archive, delete: del }) => {
			const updated: string[] = [];
			const errors: { taskId: string; code: string; message: string }[] = [];
			for (const id of taskIds) {
				const t = w.tasks.find((x) => x.id === id);
				if (!t) {
					errors.push({
						taskId: id,
						code: "not_found",
						message: "task not found",
					});
					continue;
				}
				if (del) {
					w.tasks = w.tasks.filter((x) => x.id !== id);
					updated.push(id);
					continue;
				}
				if (archive) t.archivedAt = nowIso();
				if (set) {
					if (set.statusId) setStatus(t, set.statusId);
					if (set.listId) t.listId = set.listId;
					if (set.priority) t.priority = set.priority;
					if (set.startDate !== undefined) t.startDate = set.startDate;
					if (set.dueDate !== undefined) t.dueDate = set.dueDate;
					const shift = (d: string | null) =>
						d && set.shiftDays
							? new Date(Date.parse(d) + set.shiftDays * 86_400_000)
									.toISOString()
									.slice(0, 10)
							: d;
					t.startDate = shift(t.startDate);
					t.dueDate = shift(t.dueDate);
					t.assigneeIds = [
						...new Set([...t.assigneeIds, ...(set.addAssignees ?? [])]),
					].filter((u) => !set.removeAssignees?.includes(u));
					t.tagIds = [...new Set([...t.tagIds, ...(set.addTags ?? [])])].filter(
						(x) => !set.removeTags?.includes(x),
					);
					Object.assign(t.fields, set.fields ?? {});
				}
				touch(t);
				updated.push(id);
			}
			return delay({ updated, errors });
		},
		addAssignee: async (id, userId) => {
			const t = task(id);
			if (!t.assigneeIds.includes(userId)) {
				t.assigneeIds.push(userId);
				if (!t.watchers.some((x) => x.userId === userId))
					t.watchers.push({ userId, reason: "assignee", muted: false });
				log(t, "assignee_added", { userId });
			}
			return delay(undefined);
		},
		removeAssignee: async (id, userId) => {
			const t = task(id);
			t.assigneeIds = t.assigneeIds.filter((u) => u !== userId);
			log(t, "assignee_removed", { userId });
			return delay(undefined);
		},
		watch: async (id, userId) => {
			const t = task(id);
			const x = t.watchers.find((v) => v.userId === userId);
			if (x) x.muted = false;
			else t.watchers.push({ userId, reason: "manual", muted: false });
			return delay(undefined);
		},
		unwatch: async (id, userId) => {
			const x = task(id).watchers.find((v) => v.userId === userId);
			if (x) x.muted = true;
			return delay(undefined);
		},
		addTag: async (id, tagId) => {
			const t = task(id);
			if (!t.tagIds.includes(tagId)) t.tagIds.push(tagId);
			log(t, "tag_added", { tagId });
			return delay(undefined);
		},
		removeTag: async (id, tagId) => {
			const t = task(id);
			t.tagIds = t.tagIds.filter((x) => x !== tagId);
			log(t, "tag_removed", { tagId });
			return delay(undefined);
		},
		setField: async (id, fieldId, value) => {
			const t = task(id);
			log(t, "field", { fieldId, from: t.fields[fieldId] ?? null, to: value });
			t.fields[fieldId] = value;
			return delay(undefined);
		},
		clearField: async (id, fieldId) => {
			delete task(id).fields[fieldId];
			return delay(undefined);
		},
		addDependency: async (id, { blockedById, lagDays = 0 }) => {
			// Walk up from the blocker: reaching `id` means a loop.
			const seen = new Set<string>();
			const stack = [blockedById];
			while (stack.length) {
				const cur = stack.pop() as string;
				if (cur === id)
					fail(409, "conflict", "this dependency would create a loop");
				if (seen.has(cur)) continue;
				seen.add(cur);
				for (const d of w.dependencies)
					if (d.taskId === cur) stack.push(d.blockedById);
			}
			w.dependencies.push({ taskId: id, blockedById, lagDays });
			log(task(id), "dependency_added", { blockedById });
			return delay(undefined);
		},
		removeDependency: async (id, blockedById) => {
			w.dependencies = w.dependencies.filter(
				(d) => !(d.taskId === id && d.blockedById === blockedById),
			);
			return delay(undefined);
		},
		shiftPreview: async (id, { deltaDays }) => {
			// shortcut: calendar days and direct dependants only; core `shiftDependants` handles working days and chains.
			const shift = (d: string | null) =>
				d
					? new Date(Date.parse(d) + deltaDays * 86_400_000)
							.toISOString()
							.slice(0, 10)
					: null;
			return delay({
				changes: w.dependencies
					.filter((d) => d.blockedById === id && deltaDays > 0)
					.map((d) => task(d.taskId))
					.map((t) => ({
						id: t.id,
						startDate: shift(t.startDate),
						dueDate: shift(t.dueDate),
					})),
			});
		},
		activity: async (id) => {
			task(id);
			const items: WorkFeedItem[] = [
				...w.activity
					.filter((a) => a.taskId === id)
					.map((activity) => ({ type: "activity" as const, activity })),
				...w.comments
					.filter((c) => c.taskId === id)
					.map((comment) => ({ type: "comment" as const, comment })),
			];
			const at = (i: WorkFeedItem) =>
				i.type === "activity" ? i.activity.createdAt : i.comment.createdAt;
			return delay({
				items: items.sort((a, b) => at(a).localeCompare(at(b))),
				nextCursor: null,
			});
		},
	},
	checklist: {
		list: async (taskId) =>
			delay(w.checklist.filter((c) => c.taskId === taskId).sort(byPosition)),
		create: async (taskId, input) => {
			task(taskId);
			const c = {
				id: rid("wci"),
				taskId,
				text: input.text,
				done: false,
				doneBy: null,
				doneAt: null,
				assigneeId: input.assigneeId ?? null,
				position: rankAt(0),
			};
			w.checklist.push(c);
			place(
				c,
				w.checklist.filter((x) => x.taskId === taskId),
				input,
			);
			return delay(c);
		},
		update: async (id, { before, after, ...patch }) => {
			const c = find(w.checklist, (x) => x.id === id, "checklist item");
			if (patch.done !== undefined && patch.done !== c.done) {
				c.doneBy = patch.done ? WORK_ME : null;
				c.doneAt = patch.done ? nowIso() : null;
			}
			Object.assign(c, patch);
			if (before || after)
				place(
					c,
					w.checklist.filter((x) => x.taskId === c.taskId),
					{ before, after },
				);
			return delay(c);
		},
		remove: async (id) => {
			w.checklist = w.checklist.filter((c) => c.id !== id);
			return delay(undefined);
		},
		convert: async (id) => {
			const c = find(w.checklist, (x) => x.id === id, "checklist item");
			const parent = task(c.taskId);
			w.checklist = w.checklist.filter((x) => x.id !== id);
			return delay(
				toTask(
					newTaskRow({
						listId: parent.listId,
						parentId: parent.id,
						title: c.text,
						assignees: c.assigneeId ? [c.assigneeId] : [],
					}),
				),
			);
		},
	},
	comments: {
		list: async (taskId) =>
			delay(w.comments.filter((c) => c.taskId === taskId)),
		create: async (taskId, input) => {
			task(taskId);
			const c: WorkComment = {
				id: rid("wcm"),
				taskId,
				authorId: WORK_ME,
				parentId: input.parentId ?? null,
				body: input.body,
				bodyText: docText(input.body),
				editedAt: null,
				deletedAt: null,
				resolvedAt: null,
				resolvedBy: null,
				createdAt: nowIso(),
				reactions: [],
				attachments: w.attachments.filter((a) =>
					input.attachmentIds?.includes(a.id),
				),
			};
			w.comments.push(c);
			return delay(c);
		},
		update: async (id, { body }) => {
			const c = comment(id);
			Object.assign(c, { body, bodyText: docText(body), editedAt: nowIso() });
			return delay(c);
		},
		remove: async (id) => {
			Object.assign(comment(id), {
				body: null,
				bodyText: null,
				deletedAt: nowIso(),
			});
			return delay(undefined);
		},
		resolve: async (id) =>
			delay(
				Object.assign(comment(id), {
					resolvedAt: nowIso(),
					resolvedBy: WORK_ME,
				}),
			),
		unresolve: async (id) =>
			delay(Object.assign(comment(id), { resolvedAt: null, resolvedBy: null })),
		react: async (id, emoji) => {
			const c = comment(id);
			const r = c.reactions.find((x) => x.emoji === emoji);
			if (!r) c.reactions.push({ emoji, userIds: [WORK_ME] });
			else if (!r.userIds.includes(WORK_ME)) r.userIds.push(WORK_ME);
			return delay(undefined);
		},
		unreact: async (id, emoji) => {
			const c = comment(id);
			for (const r of c.reactions)
				if (r.emoji === emoji)
					r.userIds = r.userIds.filter((u) => u !== WORK_ME);
			c.reactions = c.reactions.filter((r) => r.userIds.length);
			return delay(undefined);
		},
	},
	attachments: {
		upload: async ({ file, name, taskId, commentId, inline }) => {
			const owner = taskId
				? task(taskId)
				: task(comment(commentId ?? "").taskId);
			const url = URL.createObjectURL(file);
			const a = {
				id: rid("wat"),
				projectId: owner.projectId,
				taskId: taskId ?? owner.id,
				commentId: commentId ?? null,
				inlineIn: inline ?? "none",
				uploaderId: WORK_ME,
				name: name ?? (file instanceof File ? file.name : "file"),
				contentType: file.type || "application/octet-stream",
				size: file.size,
				width: null,
				height: null,
				url,
				thumbUrl: file.type.startsWith("image/") ? url : null,
				createdAt: nowIso(),
			};
			w.attachments.push(a);
			return delay(a, 600);
		},
		url: (id, thumb) =>
			(thumb
				? w.attachments.find((a) => a.id === id)?.thumbUrl
				: w.attachments.find((a) => a.id === id)?.url) ??
			`/api/work/attachments/${id}`,
		remove: async (id) => {
			w.attachments = w.attachments.filter((a) => a.id !== id);
			return delay(undefined);
		},
	},
	attachmentSettings: {
		get: async () =>
			delay({
				quotaGb: null,
				quotaBytes: 2 * 1024 ** 3,
				usedBytes: w.attachments.reduce((n, a) => n + a.size, 0),
				destinationId: null,
				maxMb: 25,
				counts: { db: w.attachments.length, s3: 0 },
			}),
		update: async () => workMock.attachmentSettings.get(),
		migrate: async () =>
			fail(409, "conflict", "choose an S3 destination for attachments first"),
	},
	instanceMail: {
		get: async () => delay(mail),
		update: async (input) => {
			mail = {
				configured: true,
				transport: input.transport,
				host: input.transport === "smtp" ? input.host : null,
				port: input.transport === "smtp" ? (input.port ?? 587) : null,
				secure: input.transport === "smtp" ? (input.secure ?? false) : false,
				username: input.transport === "smtp" ? (input.username ?? null) : null,
				from: input.from,
				hasSecret:
					input.transport === "smtp"
						? !!input.password || mail.hasSecret
						: !!input.apiKey || mail.hasSecret,
			};
			w.prefs.mailAvailable = true;
			return delay(mail);
		},
		remove: async () => {
			mail = noMail;
			w.prefs.mailAvailable = false;
			w.prefs.email = "off";
			return delay(mail);
		},
		test: async (input) =>
			delay(
				input.config?.transport === "smtp" && input.config.host.includes("fail")
					? { ok: false, error: "connect ECONNREFUSED" }
					: { ok: true, error: null },
				700,
			),
	},
	me: {
		tasks: async ({ watching } = {}) => {
			const mine = w.tasks.filter(
				(t) =>
					!t.archivedAt &&
					!closed(t) &&
					(t.assigneeIds.includes(WORK_ME) ||
						(watching &&
							t.watchers.some((x) => x.userId === WORK_ME && !x.muted))),
			);
			const order: DueBucket[] = [
				"overdue",
				"today",
				"tomorrow",
				"this_week",
				"next_week",
				"later",
				"none",
			];
			return delay({
				buckets: order.map((bucket) => ({
					bucket,
					items: mine
						.filter((t) => dueBucket(t.dueDate) === bucket)
						.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
						.map((t) => ({
							...toItem(t),
							projectName: project(t.projectId).name,
							watching: !t.assigneeIds.includes(WORK_ME),
						})),
				})),
			});
		},
		inbox: async ({ unread } = {}) =>
			delay({
				items: w.notifications
					.filter((n) => !unread || !n.readAt)
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
				nextCursor: null,
				unread: w.notifications.filter((n) => !n.readAt).length,
			}),
		markRead: async (input) => {
			for (const n of w.notifications)
				if ("all" in input || input.ids.includes(n.id)) n.readAt ??= nowIso();
			return delay(undefined);
		},
		prefs: async () => delay(w.prefs),
		updatePrefs: async (input) => delay(Object.assign(w.prefs, input)),
		rotateIcal: async () => {
			w.prefs.icalEnabled = true;
			return delay({
				url: `${location.origin}/ical/${Math.random().toString(36).slice(2)}.ics`,
			});
		},
	},
	search: async (q, projectId) => {
		const needle = q.trim().toLowerCase();
		const hits = w.tasks
			.filter((t) => !projectId || t.projectId === projectId)
			.map((t) => {
				const key = keyOf(t).toLowerCase();
				const match =
					key === needle || (projectId && String(t.number) === needle)
						? ("key" as const)
						: t.title.toLowerCase().includes(needle)
							? ("title" as const)
							: t.description &&
									docText(t.description).toLowerCase().includes(needle)
								? ("text" as const)
								: w.comments.some(
											(c) =>
												c.taskId === t.id &&
												c.bodyText?.toLowerCase().includes(needle),
										)
									? ("comment" as const)
									: null;
				return { t, match };
			})
			.filter((h) => needle && h.match)
			.slice(0, 20);
		return delay({
			items: hits.map(({ t, match }) => ({
				id: t.id,
				key: keyOf(t),
				title: t.title,
				statusId: t.statusId,
				projectId: t.projectId,
				projectName: project(t.projectId).name,
				match: match ?? "title",
			})),
		});
	},
	time: {
		start: async (taskId) => {
			const stopped = stopTimer();
			w.timer = timerEntry(taskId);
			return delay({ started: w.timer, stopped });
		},
		stop: async () => {
			stopTimer();
			return delay({ running: null });
		},
		current: async () => delay({ running: w.timer }),
		list: async (taskId) =>
			delay(w.timeEntries.filter((e) => e.taskId === taskId)),
		create: async (taskId, input) => {
			const e = timerEntry(taskId);
			Object.assign(e, {
				source: "manual",
				startedAt: input.startedAt,
				durationSec: input.durationSec,
				endedAt: new Date(
					Date.parse(input.startedAt) + input.durationSec * 1000,
				).toISOString(),
				note: input.note ?? null,
				billable: input.billable ?? true,
			});
			w.timeEntries.push(e);
			return delay(e);
		},
		update: async (id, patch) =>
			delay(
				Object.assign(
					find(w.timeEntries, (e) => e.id === id, "time entry"),
					patch,
				),
			),
		remove: async (id) => {
			w.timeEntries = w.timeEntries.filter((e) => e.id !== id);
			return delay(undefined);
		},
		report: async (q) => {
			const groupBy = q.groupBy ?? "day";
			const rows = new Map<
				string,
				{
					label: string;
					seconds: number;
					billableSeconds: number;
					entries: number;
				}
			>();
			const entries = w.timeEntries.filter(
				(e) =>
					(!q.projectId || e.projectId === q.projectId) &&
					(!q.userId || e.userId === q.userId) &&
					e.startedAt.slice(0, 10) >= q.from &&
					e.startedAt.slice(0, 10) <= q.to &&
					(q.billable === undefined || String(e.billable) === q.billable),
			);
			for (const e of entries) {
				const [key, label] =
					groupBy === "project"
						? [e.projectId, project(e.projectId).name]
						: groupBy === "user"
							? [e.userId, userName(e.userId)]
							: groupBy === "task"
								? [e.taskId, `${e.taskKey} ${e.taskTitle}`]
								: [e.startedAt.slice(0, 10), e.startedAt.slice(0, 10)];
				const r = rows.get(key) ?? {
					label,
					seconds: 0,
					billableSeconds: 0,
					entries: 0,
				};
				r.seconds += e.durationSec ?? 0;
				if (e.billable) r.billableSeconds += e.durationSec ?? 0;
				r.entries++;
				rows.set(key, r);
			}
			const list = [...rows].map(([key, r]) => ({ key, ...r }));
			return delay({
				groupBy,
				rows: list,
				totals: {
					seconds: list.reduce((s, r) => s + r.seconds, 0),
					billableSeconds: list.reduce((s, r) => s + r.billableSeconds, 0),
					entries: entries.length,
				},
			});
		},
		reportCsvUrl: (q) =>
			csvBlobUrl([
				["Date", "Task", "Person", "Hours", "Billable"],
				...w.timeEntries
					.filter(
						(e) =>
							(!q.projectId || e.projectId === q.projectId) &&
							e.startedAt.slice(0, 10) >= q.from &&
							e.startedAt.slice(0, 10) <= q.to,
					)
					.map((e) => [
						e.startedAt.slice(0, 10),
						`${e.taskKey} ${e.taskTitle}`,
						userName(e.userId),
						((e.durationSec ?? 0) / 3600).toFixed(2),
						e.billable ? "yes" : "no",
					]),
			]),
	},
	templates: {
		list: async (projectId) =>
			delay(
				w.templates
					.filter((t) => !t.projectId || t.projectId === projectId)
					.map(({ payload, ...t }) => ({
						...t,
						taskCount:
							(payload.tasks?.length ?? 0) +
							(payload.lists ?? []).reduce((s, l) => s + l.tasks.length, 0),
					})),
			),
		get: async (id) => delay(find(w.templates, (t) => t.id === id, "template")),
		create: async (input) => {
			const tpl = {
				id: rid("wtp"),
				organizationId: WORK_ORG.id,
				projectId: input.projectId ?? null,
				kind: input.source.kind,
				name: input.name,
				description: input.description ?? null,
				payload: { tasks: [] },
				createdBy: WORK_ME,
				usageCount: 0,
				builtin: false,
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			w.templates.push(tpl);
			return delay(tpl);
		},
		update: async (id, patch) =>
			delay(
				Object.assign(
					find(w.templates, (t) => t.id === id, "template"),
					patch,
				),
			),
		remove: async (id) => {
			w.templates = w.templates.filter((t) => t.id !== id);
			return delay(undefined);
		},
		instantiate: async (id, input) => {
			const tpl = find(w.templates, (t) => t.id === id, "template");
			const drafts = [
				...(tpl.payload.tasks ?? []),
				...(tpl.payload.lists ?? []).flatMap((l) => l.tasks),
			];
			const listId =
				"listId" in input.target
					? input.target.listId
					: (project(input.target.projectId).defaultListId ?? notFound("list"));
			// shortcut: calendar-day offsets, no dependencies; the server uses core `instantiateTemplate`.
			const at = (o?: number) =>
				o === undefined
					? null
					: new Date(Date.parse(input.anchor.date) + o * 86_400_000)
							.toISOString()
							.slice(0, 10);
			const ids = input.dryRun
				? []
				: drafts.map(
						(d) =>
							newTaskRow({
								listId,
								title: d.title,
								priority: d.priority,
								startDate: at(d.startOffset),
								dueDate: at(d.dueOffset),
								isMilestone: d.isMilestone,
							}).id,
					);
			if (!input.dryRun) tpl.usageCount++;
			return delay({
				dryRun: input.dryRun ?? false,
				created: { tasks: drafts.length, lists: 0, fields: 0, statuses: 0 },
				taskIds: ids,
				warnings: [],
			});
		},
	},
	// Imports live in their own section: ./work-imports.ts.
	imports: workImportsMock,
	shares: {
		list: async (projectId) =>
			delay(w.shares.filter((s) => s.projectId === projectId)),
		create: async (projectId, input) => {
			if (!project(projectId).allowShareLinks)
				fail(409, "conflict", "share links are off for this project");
			const share = {
				id: rid("wsh"),
				projectId,
				listId: input.listId ?? null,
				viewId: input.viewId ?? null,
				name: input.name,
				showComments: input.showComments ?? false,
				showAssignees: input.showAssignees ?? true,
				fieldIds: input.fieldIds ?? [],
				hasPassword: !!input.password,
				expiresAt: input.expiresAt ?? null,
				revokedAt: null,
				lastViewedAt: null,
				viewCount: 0,
				createdBy: WORK_ME,
				createdAt: nowIso(),
			};
			w.shares.push(share);
			return delay({
				share,
				url: `${location.origin}/share/${Math.random().toString(36).slice(2)}`,
			});
		},
		revoke: async (id) => {
			find(w.shares, (s) => s.id === id, "share").revokedAt = nowIso();
			return delay(undefined);
		},
	},
	guests: {
		invite: async (projectId) => {
			project(projectId);
			const id = rid("inv");
			return delay({
				invitationId: id,
				url: `${location.origin}/accept-invitation/${id}`,
				emailed: false,
			});
		},
	},
	workload: async ({ weeks = 6 } = {}) => {
		const dow = (new Date(today()).getUTCDay() + 6) % 7;
		const mondays = Array.from({ length: Number(weeks) }, (_, i) =>
			dayOf(i * 7 - dow),
		);
		return delay({
			weeks: mondays,
			people: workUsers.map((u) => ({
				userId: u.userId,
				name: u.name,
				avatar: u.avatar,
				capacityMinutes: w.prefs.capacityHoursPerWeek * 60,
				cells: mondays.map((weekStart, i) => {
					const end = mondays[i + 1] ?? dayOf(Number(weeks) * 7 - dow);
					const tasks = w.tasks.filter(
						(t) =>
							t.assigneeIds.includes(u.userId) &&
							!closed(t) &&
							t.dueDate &&
							t.dueDate >= weekStart &&
							t.dueDate < end,
					);
					return {
						weekStart,
						// shortcut: the whole estimate lands in the due week; the server spreads it over working days.
						minutes: tasks.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0),
						taskIds: tasks.map((t) => t.id),
					};
				}),
			})),
		});
	},
	ai: {
		summarise: async (taskId) => {
			const lines = w.comments
				.filter((c) => c.taskId === taskId && c.bodyText)
				.map((c) => `${userName(c.authorId ?? "")}: ${c.bodyText}`);
			const draft: PmDoc = {
				type: "doc",
				content: [
					{
						type: "bulletList",
						content: (lines.length ? lines : ["No discussion yet."]).map(
							(text) => ({
								type: "listItem",
								content: [
									{ type: "paragraph", content: [{ type: "text", text }] },
								],
							}),
						),
					},
				],
			};
			return delay({ draft }, 900);
		},
		subtasks: async (taskId) =>
			delay(
				{
					subtasks: ["Research", "Draft", "Review with client", "Ship"].map(
						(s) => ({
							title: `${s}: ${task(taskId).title}`,
							estimateMinutes: 120,
						}),
					),
				},
				900,
			),
		description: async (taskId) =>
			delay(
				{
					description: {
						type: "doc" as const,
						content: [
							{
								type: "paragraph",
								content: [
									{
										type: "text",
										text: `Goal: ${task(taskId).title}. Done when the client has signed off.`,
									},
								],
							},
						],
					},
				},
				900,
			),
	},
};
