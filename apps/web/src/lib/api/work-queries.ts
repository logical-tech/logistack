/*
 * TanStack Query keys and hooks for Work. Every key starts with "work", so a
 * structural change can invalidate a project's queries with one call.
 */
import type {
	WorkTask,
	WorkTaskListItem,
	WorkTaskListQuery,
	WorkTaskMove,
	WorkTaskPage,
	WorkTaskPatch,
	WorkTimeReportQuery,
	WorkWorkloadQuery,
} from "@logistack/contracts";
import {
	type InfiniteData,
	infiniteQueryOptions,
	type QueryClient,
	type QueryKey,
	queryOptions,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from ".";
import type { WorkApi } from "./work";

const work = () => api.work;

export const workKeys = {
	all: ["work"] as const,
	projects: () => ["work", "projects"] as const,
	project: (id: string) => ["work", "project", id] as const,
	projectPart: (
		id: string,
		part:
			| "health"
			| "summary"
			| "people"
			| "services"
			| "statuses"
			| "lists"
			| "fields"
			| "tags"
			| "views"
			| "shares",
	) => ["work", "project", id, part] as const,
	tasks: () => ["work", "tasks"] as const,
	taskList: (query: WorkTaskListQuery) => ["work", "tasks", query] as const,
	task: (id: string) => ["work", "task", id] as const,
	taskPart: (
		id: string,
		part: "activity" | "checklist" | "comments" | "time",
	) => ["work", "task", id, part] as const,
	byKey: (key: string) => ["work", "by-key", key] as const,
	me: () => ["work", "me"] as const,
	myTasks: (watching: boolean) => ["work", "me", "tasks", watching] as const,
	inbox: (unread: boolean) => ["work", "me", "inbox", unread] as const,
	prefs: () => ["work", "me", "prefs"] as const,
	attachmentSettings: () => ["work", "attachment-settings"] as const,
	instanceMail: () => ["instance", "mail"] as const,
	timer: () => ["work", "me", "timer"] as const,
	search: (q: string, projectId?: string) =>
		["work", "search", q, projectId ?? null] as const,
	timeReport: (query: WorkTimeReportQuery) =>
		["work", "time-report", query] as const,
	templates: (projectId?: string) =>
		["work", "templates", projectId ?? null] as const,
	template: (id: string) => ["work", "template", id] as const,
	imports: () => ["work", "imports"] as const,
	import: (id: string) => ["work", "import", id] as const,
	workload: (query: WorkWorkloadQuery) => ["work", "workload", query] as const,
};

// --- query options (usable in route loaders) ------------------------------

export const workProjectsQuery = () =>
	queryOptions({
		queryKey: workKeys.projects(),
		queryFn: () => work().projects.list(),
	});
export const workProjectQuery = (id: string) =>
	queryOptions({
		queryKey: workKeys.project(id),
		queryFn: () => work().projects.get(id),
	});
const part =
	<P extends Parameters<typeof workKeys.projectPart>[1], R>(
		p: P,
		fn: (id: string) => Promise<R>,
	) =>
	(id: string) =>
		queryOptions({
			queryKey: workKeys.projectPart(id, p),
			queryFn: () => fn(id),
		});
export const workHealthQuery = part("health", (id) =>
	work().projects.health(id),
);
export const workSummaryQuery = part("summary", (id) =>
	work().projects.summary(id),
);
export const workPeopleQuery = part("people", (id) =>
	work().projects.people(id),
);
export const workServicesQuery = part("services", (id) =>
	work().projects.services(id),
);
export const workStatusesQuery = part("statuses", (id) =>
	work().statuses.list(id),
);
export const workListsQuery = part("lists", (id) => work().lists.list(id));
export const workFieldsQuery = part("fields", (id) => work().fields.list(id));
export const workTagsQuery = part("tags", (id) => work().tags.list(id));
export const workViewsQuery = part("views", (id) => work().views.list(id));
export const workSharesQuery = part("shares", (id) => work().shares.list(id));

export const workTasksQuery = (query: WorkTaskListQuery) =>
	infiniteQueryOptions({
		queryKey: workKeys.taskList(query),
		queryFn: ({ pageParam }) =>
			work().tasks.list({ ...query, cursor: pageParam ?? undefined }),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor,
	});
export const workTaskQuery = (id: string) =>
	queryOptions({
		queryKey: workKeys.task(id),
		queryFn: () => work().tasks.get(id),
	});

// --- queries ---------------------------------------------------------------

export const useWorkProjects = () => useQuery(workProjectsQuery());
export const useWorkProject = (id: string) => useQuery(workProjectQuery(id));
export const useWorkHealth = (id: string) => useQuery(workHealthQuery(id));
export const useWorkSummary = (id: string) => useQuery(workSummaryQuery(id));
export const useWorkPeople = (id: string) => useQuery(workPeopleQuery(id));
export const useWorkServices = (id: string) => useQuery(workServicesQuery(id));
export const useWorkStatuses = (id: string) => useQuery(workStatusesQuery(id));
export const useWorkLists = (id: string) => useQuery(workListsQuery(id));
export const useWorkFields = (id: string) => useQuery(workFieldsQuery(id));
export const useWorkTags = (id: string) => useQuery(workTagsQuery(id));
export const useWorkViews = (id: string) => useQuery(workViewsQuery(id));
export const useWorkShares = (id: string) => useQuery(workSharesQuery(id));
export const useWorkTasks = (query: WorkTaskListQuery) =>
	useInfiniteQuery(workTasksQuery(query));
export const useWorkTask = (id: string | undefined) =>
	useQuery({ ...workTaskQuery(id ?? ""), enabled: !!id });
export const useWorkTaskByKey = (key: string) =>
	useQuery({
		queryKey: workKeys.byKey(key),
		queryFn: () => work().tasks.byKey(key),
	});
export const useWorkActivity = (taskId: string) =>
	useInfiniteQuery({
		queryKey: workKeys.taskPart(taskId, "activity"),
		queryFn: ({ pageParam }) =>
			work().tasks.activity(taskId, pageParam ?? undefined),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor,
	});
export const useWorkChecklist = (taskId: string) =>
	useQuery({
		queryKey: workKeys.taskPart(taskId, "checklist"),
		queryFn: () => work().checklist.list(taskId),
	});
export const useWorkComments = (taskId: string) =>
	useQuery({
		queryKey: workKeys.taskPart(taskId, "comments"),
		queryFn: () => work().comments.list(taskId),
	});
export const useWorkTimeEntries = (taskId: string) =>
	useQuery({
		queryKey: workKeys.taskPart(taskId, "time"),
		queryFn: () => work().time.list(taskId),
	});
export const useMyWorkTasks = (watching = false) =>
	useQuery({
		queryKey: workKeys.myTasks(watching),
		queryFn: () => work().me.tasks({ watching }),
	});
export const useWorkInbox = (unread = false) =>
	useInfiniteQuery({
		queryKey: workKeys.inbox(unread),
		queryFn: ({ pageParam }) =>
			work().me.inbox({ unread, cursor: pageParam ?? undefined }),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor,
	});
export const useWorkPrefs = () =>
	useQuery({ queryKey: workKeys.prefs(), queryFn: () => work().me.prefs() });
export const useWorkTimer = () =>
	useQuery({
		queryKey: workKeys.timer(),
		queryFn: () => work().time.current(),
	});
export const useWorkSearch = (q: string, projectId?: string) =>
	useQuery({
		queryKey: workKeys.search(q, projectId),
		queryFn: () => work().search(q, projectId),
		enabled: q.trim().length > 0,
		placeholderData: (prev) => prev,
	});
export const useWorkTimeReport = (query: WorkTimeReportQuery) =>
	useQuery({
		queryKey: workKeys.timeReport(query),
		queryFn: () => work().time.report(query),
	});
export const useWorkTemplates = (projectId?: string) =>
	useQuery({
		queryKey: workKeys.templates(projectId),
		queryFn: () => work().templates.list(projectId),
	});
export const useWorkTemplate = (id: string) =>
	useQuery({
		queryKey: workKeys.template(id),
		queryFn: () => work().templates.get(id),
	});
export const useWorkImports = () =>
	useQuery({
		queryKey: workKeys.imports(),
		queryFn: () => work().imports.list(),
	});
/** Polls while the import runs; WebSocket progress can replace this later. */
export const useWorkImport = (id: string) =>
	useQuery({
		queryKey: workKeys.import(id),
		queryFn: () => work().imports.get(id),
		refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
	});
export const useWorkWorkload = (query: WorkWorkloadQuery = {}) =>
	useQuery({
		queryKey: workKeys.workload(query),
		queryFn: () => work().workload(query),
	});

// --- mutations -------------------------------------------------------------

/** A mutation that invalidates `keys` (all of them prefix-matched) when it settles. */
function useWorkMutation<A, R>(
	fn: (w: WorkApi, args: A) => Promise<R>,
	keys: (args: A, result: R | undefined) => QueryKey[],
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (args: A) => fn(work(), args),
		onSettled: (result, _e, args) =>
			Promise.all(
				keys(args, result).map((queryKey) =>
					qc.invalidateQueries({ queryKey }),
				),
			),
	});
}

/** Anything structural: the project's settings, lists, statuses, fields, views and every task list. */
const structural = (projectId: string): QueryKey[] => [
	workKeys.project(projectId),
	workKeys.tasks(),
	workKeys.projects(),
];
/** A task changed: its detail, every task list, My tasks, project counts. */
const taskChanged = (id: string): QueryKey[] => [
	workKeys.task(id),
	workKeys.tasks(),
	workKeys.me(),
	workKeys.projects(),
];

export const useUpdateWorkSettings = () =>
	useWorkMutation(
		(
			w,
			a: {
				id: string;
				patch: Parameters<WorkApi["projects"]["updateSettings"]>[1];
			},
		) => w.projects.updateSettings(a.id, a.patch),
		(a) => structural(a.id),
	);

// Statuses, lists, fields, tags, views: CRUD + order, keyed by project.
type ProjectArgs<T> = { projectId: string } & T;
export const useCreateWorkStatus = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{ input: Parameters<WorkApi["statuses"]["create"]>[1] }>,
		) => w.statuses.create(a.projectId, a.input),
		(a) => structural(a.projectId),
	);
export const useUpdateWorkStatus = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{
				id: string;
				patch: Parameters<WorkApi["statuses"]["update"]>[1];
			}>,
		) => w.statuses.update(a.id, a.patch),
		(a) => structural(a.projectId),
	);
export const useDeleteWorkStatus = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ id: string; moveTo: string }>) =>
			w.statuses.remove(a.id, a.moveTo),
		(a) => structural(a.projectId),
	);
export const useReorderWorkStatuses = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ ids: string[] }>) =>
			w.statuses.reorder(a.projectId, a.ids),
		(a) => structural(a.projectId),
	);

export const useCreateWorkList = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ input: Parameters<WorkApi["lists"]["create"]>[1] }>) =>
			w.lists.create(a.projectId, a.input),
		(a) => structural(a.projectId),
	);
export const useUpdateWorkList = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{
				id: string;
				patch: Parameters<WorkApi["lists"]["update"]>[1];
			}>,
		) => w.lists.update(a.id, a.patch),
		(a) => structural(a.projectId),
	);
export const useDeleteWorkList = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{ id: string; moveTo?: string; deleteTasks?: boolean }>,
		) => w.lists.remove(a.id, { moveTo: a.moveTo, deleteTasks: a.deleteTasks }),
		(a) => structural(a.projectId),
	);
export const useArchiveWorkList = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ id: string; archived: boolean }>) =>
			a.archived ? w.lists.archive(a.id) : w.lists.restore(a.id),
		(a) => structural(a.projectId),
	);
export const useReorderWorkLists = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ ids: string[] }>) =>
			w.lists.reorder(a.projectId, a.ids),
		(a) => structural(a.projectId),
	);

export const useCreateWorkField = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{ input: Parameters<WorkApi["fields"]["create"]>[1] }>,
		) => w.fields.create(a.projectId, a.input),
		(a) => structural(a.projectId),
	);
export const useUpdateWorkField = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{
				id: string;
				patch: Parameters<WorkApi["fields"]["update"]>[1];
			}>,
		) => w.fields.update(a.id, a.patch),
		(a) => structural(a.projectId),
	);
export const useDeleteWorkField = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ id: string }>) => w.fields.remove(a.id),
		(a) => structural(a.projectId),
	);
export const useReorderWorkFields = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ ids: string[] }>) =>
			w.fields.reorder(a.projectId, a.ids),
		(a) => structural(a.projectId),
	);

export const useCreateWorkTag = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ input: Parameters<WorkApi["tags"]["create"]>[1] }>) =>
			w.tags.create(a.projectId, a.input),
		(a) => [workKeys.projectPart(a.projectId, "tags")],
	);
export const useUpdateWorkTag = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{
				id: string;
				patch: Parameters<WorkApi["tags"]["update"]>[1];
			}>,
		) => w.tags.update(a.id, a.patch),
		(a) => [workKeys.projectPart(a.projectId, "tags")],
	);
export const useDeleteWorkTag = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ id: string }>) => w.tags.remove(a.id),
		(a) => structural(a.projectId),
	);

export const useCreateWorkView = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ input: Parameters<WorkApi["views"]["create"]>[1] }>) =>
			w.views.create(a.projectId, a.input),
		(a) => [workKeys.projectPart(a.projectId, "views")],
	);
export const useUpdateWorkView = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{
				id: string;
				patch: Parameters<WorkApi["views"]["update"]>[1];
			}>,
		) => w.views.update(a.id, a.patch),
		(a) => [workKeys.projectPart(a.projectId, "views"), workKeys.tasks()],
	);
export const useDeleteWorkView = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ id: string }>) => w.views.remove(a.id),
		(a) => [workKeys.projectPart(a.projectId, "views")],
	);
export const useReorderWorkViews = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ ids: string[] }>) =>
			w.views.reorder(a.projectId, a.ids),
		(a) => [workKeys.projectPart(a.projectId, "views")],
	);

// --- tasks, with optimistic patch and move -------------------------------

type TaskPages = InfiniteData<WorkTaskPage, string | null>;

/**
 * Edits often spread a full task into a list row or a row into the full task. The one field
 * whose shape differs is `dependencies` (row: `{blockedById, lagDays}[]`, full task:
 * `{blockedBy, blocking}`), so each cache keeps its own; only a refetch changes it.
 */
function keepShape<T extends { dependencies?: unknown }>(
	before: T,
	after: T,
): T {
	return { ...after, dependencies: before.dependencies };
}

/** Applies `edit` to the task everywhere it's cached; returns a rollback. */
export function patchCachedTask(
	qc: QueryClient,
	id: string,
	edit: <T extends Omit<WorkTaskListItem, "dependencies">>(t: T) => T,
): () => void {
	const lists = qc.getQueriesData<TaskPages>({ queryKey: workKeys.tasks() });
	const detail = qc.getQueryData<WorkTask>(workKeys.task(id));
	for (const [key, data] of lists)
		if (data)
			qc.setQueryData<TaskPages>(key, {
				...data,
				pages: data.pages.map((p) => ({
					...p,
					items: p.items.map((t) => (t.id === id ? keepShape(t, edit(t)) : t)),
				})),
			});
	if (detail)
		qc.setQueryData(workKeys.task(id), keepShape(detail, edit(detail)));
	return () => {
		for (const [key, data] of lists) qc.setQueryData(key, data);
		if (detail) qc.setQueryData(workKeys.task(id), detail);
	};
}

/** Reorders a moved task inside each cached page that holds its neighbour. */
function reorderCached(qc: QueryClient, id: string, move: WorkTaskMove) {
	const anchor = move.before ?? move.after;
	if (!anchor) return;
	for (const [key, data] of qc.getQueriesData<TaskPages>({
		queryKey: workKeys.tasks(),
	})) {
		if (!data) continue;
		qc.setQueryData<TaskPages>(key, {
			...data,
			pages: data.pages.map((p) => {
				const moved = p.items.find((t) => t.id === id);
				const rest = p.items.filter((t) => t.id !== id);
				const at = rest.findIndex((t) => t.id === anchor);
				if (!moved || at < 0) return p;
				rest.splice(move.before ? at : at + 1, 0, moved);
				return { ...p, items: rest };
			}),
		});
	}
}

function useOptimisticTask<A extends { id: string }>(
	fn: (w: WorkApi, a: A) => Promise<WorkTask>,
	apply: (qc: QueryClient, a: A) => () => void,
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (a: A) => fn(work(), a),
		onMutate: async (a) => {
			await qc.cancelQueries({ queryKey: workKeys.tasks() });
			await qc.cancelQueries({ queryKey: workKeys.task(a.id) });
			return { rollback: apply(qc, a) };
		},
		onError: (_e, _a, ctx) => ctx?.rollback(),
		onSuccess: (task) => qc.setQueryData(workKeys.task(task.id), task),
		onSettled: (_r, _e, a) =>
			Promise.all(
				[workKeys.tasks(), workKeys.me(), workKeys.projects()].map((queryKey) =>
					qc.invalidateQueries({ queryKey }),
				),
			).then(() =>
				qc.invalidateQueries({ queryKey: workKeys.taskPart(a.id, "activity") }),
			),
	});
}

/** Optimistic PATCH; on 409 `conflict` the error's `details` carries the current task. */
export const usePatchWorkTask = () =>
	useOptimisticTask(
		(w, a: { id: string; patch: WorkTaskPatch }) =>
			w.tasks.update(a.id, a.patch),
		(qc, { id, patch }) => {
			const { expectedUpdatedAt: _, recurrence, ...rest } = patch;
			return patchCachedTask(qc, id, (t) => ({
				...t,
				...rest,
				...(recurrence !== undefined ? { recurring: recurrence !== null } : {}),
			}));
		},
	);

/** Optimistic drag: list/status/parent change plus reordering next to `before`/`after`. */
export const useMoveWorkTask = () =>
	useOptimisticTask(
		(w, a: { id: string; move: WorkTaskMove }) => w.tasks.move(a.id, a.move),
		(qc, { id, move }) => {
			const { before: _b, after: _a, ...fields } = move;
			const rollback = patchCachedTask(qc, id, (t) => ({
				...t,
				...Object.fromEntries(
					Object.entries(fields).filter(([, v]) => v !== undefined),
				),
			}));
			reorderCached(qc, id, move);
			return rollback;
		},
	);

export const useCreateWorkTask = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["tasks"]["create"]>[0]) =>
			w.tasks.create(input),
		(input) => [
			workKeys.tasks(),
			workKeys.me(),
			workKeys.projects(),
			...(input.parentId ? [workKeys.task(input.parentId)] : []),
		],
	);
export const useMoveWorkTaskToProject = () =>
	useWorkMutation(
		(
			w,
			a: {
				id: string;
				input: Parameters<WorkApi["tasks"]["moveProject"]>[1];
				dryRun?: boolean;
			},
		) => w.tasks.moveProject(a.id, a.input, a.dryRun),
		(a) => (a.dryRun ? [] : taskChanged(a.id)),
	);
export const useDuplicateWorkTask = () =>
	useWorkMutation(
		(
			w,
			a: { id: string; input: Parameters<WorkApi["tasks"]["duplicate"]>[1] },
		) => w.tasks.duplicate(a.id, a.input),
		(a) => taskChanged(a.id),
	);
export const useArchiveWorkTask = () =>
	useWorkMutation(
		(w, a: { id: string; archived: boolean }) =>
			a.archived ? w.tasks.archive(a.id) : w.tasks.restore(a.id),
		(a) => taskChanged(a.id),
	);
export const useDeleteWorkTask = () =>
	useWorkMutation(
		(w, id: string) => w.tasks.remove(id),
		() => [workKeys.tasks(), workKeys.me(), workKeys.projects()],
	);
export const useBulkWorkTasks = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["tasks"]["bulk"]>[0]) => w.tasks.bulk(input),
		() => [workKeys.all],
	);

/** Assignees, watchers, tags: `on` adds, `off` removes. */
export const useWorkTaskAssignee = () =>
	useWorkMutation(
		(w, a: { id: string; userId: string; on: boolean }) =>
			a.on
				? w.tasks.addAssignee(a.id, a.userId)
				: w.tasks.removeAssignee(a.id, a.userId),
		(a) => taskChanged(a.id),
	);
export const useWorkTaskWatcher = () =>
	useWorkMutation(
		(w, a: { id: string; userId: string; on: boolean }) =>
			a.on ? w.tasks.watch(a.id, a.userId) : w.tasks.unwatch(a.id, a.userId),
		(a) => [workKeys.task(a.id), workKeys.me()],
	);
export const useWorkTaskTag = () =>
	useWorkMutation(
		(w, a: { id: string; tagId: string; on: boolean }) =>
			a.on ? w.tasks.addTag(a.id, a.tagId) : w.tasks.removeTag(a.id, a.tagId),
		(a) => taskChanged(a.id),
	);
/** `value === null` clears the field. */
export const useSetWorkTaskField = () =>
	useWorkMutation(
		(w, a: { id: string; fieldId: string; value: unknown }) =>
			a.value === null || a.value === undefined
				? w.tasks.clearField(a.id, a.fieldId)
				: w.tasks.setField(a.id, a.fieldId, a.value),
		(a) => taskChanged(a.id),
	);
export const useAddWorkDependency = () =>
	useWorkMutation(
		(
			w,
			a: {
				id: string;
				input: Parameters<WorkApi["tasks"]["addDependency"]>[1];
			},
		) => w.tasks.addDependency(a.id, a.input),
		(a) => [...taskChanged(a.id), workKeys.task(a.input.blockedById)],
	);
export const useRemoveWorkDependency = () =>
	useWorkMutation(
		(w, a: { id: string; blockedById: string }) =>
			w.tasks.removeDependency(a.id, a.blockedById),
		(a) => [...taskChanged(a.id), workKeys.task(a.blockedById)],
	);
/** Not a cache write: the timeline asks before applying. */
export const useWorkShiftPreview = () =>
	useMutation({
		mutationFn: (a: {
			id: string;
			input: Parameters<WorkApi["tasks"]["shiftPreview"]>[1];
		}) => work().tasks.shiftPreview(a.id, a.input),
	});

// Checklist
const checklistChanged = (taskId: string): QueryKey[] => [
	workKeys.taskPart(taskId, "checklist"),
	workKeys.task(taskId),
	workKeys.tasks(),
];
export const useCreateWorkChecklistItem = () =>
	useWorkMutation(
		(
			w,
			a: {
				taskId: string;
				input: Parameters<WorkApi["checklist"]["create"]>[1];
			},
		) => w.checklist.create(a.taskId, a.input),
		(a) => checklistChanged(a.taskId),
	);
export const useUpdateWorkChecklistItem = () =>
	useWorkMutation(
		(
			w,
			a: {
				taskId: string;
				id: string;
				patch: Parameters<WorkApi["checklist"]["update"]>[1];
			},
		) => w.checklist.update(a.id, a.patch),
		(a) => checklistChanged(a.taskId),
	);
export const useDeleteWorkChecklistItem = () =>
	useWorkMutation(
		(w, a: { taskId: string; id: string }) => w.checklist.remove(a.id),
		(a) => checklistChanged(a.taskId),
	);
export const useConvertWorkChecklistItem = () =>
	useWorkMutation(
		(w, a: { taskId: string; id: string }) => w.checklist.convert(a.id),
		(a) => checklistChanged(a.taskId),
	);

// Comments and reactions
const commentsChanged = (taskId: string): QueryKey[] => [
	workKeys.taskPart(taskId, "comments"),
	workKeys.taskPart(taskId, "activity"),
	workKeys.task(taskId),
];
export const useCreateWorkComment = () =>
	useWorkMutation(
		(
			w,
			a: {
				taskId: string;
				input: Parameters<WorkApi["comments"]["create"]>[1];
			},
		) => w.comments.create(a.taskId, a.input),
		(a) => [...commentsChanged(a.taskId), workKeys.tasks()],
	);
export const useUpdateWorkComment = () =>
	useWorkMutation(
		(
			w,
			a: {
				taskId: string;
				id: string;
				patch: Parameters<WorkApi["comments"]["update"]>[1];
			},
		) => w.comments.update(a.id, a.patch),
		(a) => commentsChanged(a.taskId),
	);
export const useDeleteWorkComment = () =>
	useWorkMutation(
		(w, a: { taskId: string; id: string }) => w.comments.remove(a.id),
		(a) => commentsChanged(a.taskId),
	);
export const useResolveWorkComment = () =>
	useWorkMutation(
		(w, a: { taskId: string; id: string; resolved: boolean }) =>
			a.resolved ? w.comments.resolve(a.id) : w.comments.unresolve(a.id),
		(a) => commentsChanged(a.taskId),
	);
export const useWorkReaction = () =>
	useWorkMutation(
		(
			w,
			a: {
				taskId: string;
				id: string;
				emoji: Parameters<WorkApi["comments"]["react"]>[1];
				on: boolean;
			},
		) =>
			a.on
				? w.comments.react(a.id, a.emoji)
				: w.comments.unreact(a.id, a.emoji),
		(a) => commentsChanged(a.taskId),
	);

// Attachments
export const useUploadWorkAttachment = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["attachments"]["upload"]>[0]) =>
			w.attachments.upload(input),
		(input, res) => {
			const taskId = input.taskId ?? res?.taskId;
			return taskId ? commentsChanged(taskId) : [];
		},
	);
export const useDeleteWorkAttachment = () =>
	useWorkMutation(
		(w, a: { taskId: string; id: string }) => w.attachments.remove(a.id),
		(a) => commentsChanged(a.taskId),
	);

// Me
export const useMarkWorkInboxRead = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["me"]["markRead"]>[0]) =>
			w.me.markRead(input),
		() => [workKeys.me()],
	);
export const useUpdateWorkPrefs = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["me"]["updatePrefs"]>[0]) =>
			w.me.updatePrefs(input),
		() => [workKeys.prefs()],
	);
export const useRotateWorkIcal = () =>
	useWorkMutation(
		(w, _: undefined) => w.me.rotateIcal(),
		() => [workKeys.prefs()],
	);

// Attachment storage and instance mail
export const useWorkAttachmentSettings = (enabled = true) =>
	useQuery({
		queryKey: workKeys.attachmentSettings(),
		queryFn: () => work().attachmentSettings.get(),
		enabled,
	});
export const useUpdateWorkAttachmentSettings = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["attachmentSettings"]["update"]>[0]) =>
			w.attachmentSettings.update(input),
		() => [workKeys.attachmentSettings()],
	);
export const useMigrateWorkAttachments = () =>
	useWorkMutation(
		(w, _: undefined) => w.attachmentSettings.migrate(),
		() => [workKeys.attachmentSettings()],
	);
export const useInstanceMail = (enabled = true) =>
	useQuery({
		queryKey: workKeys.instanceMail(),
		queryFn: () => work().instanceMail.get(),
		enabled,
	});
export const useUpdateInstanceMail = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["instanceMail"]["update"]>[0]) =>
			w.instanceMail.update(input),
		() => [workKeys.instanceMail(), workKeys.prefs()],
	);
export const useRemoveInstanceMail = () =>
	useWorkMutation(
		(w, _: undefined) => w.instanceMail.remove(),
		() => [workKeys.instanceMail(), workKeys.prefs()],
	);
export const useTestInstanceMail = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["instanceMail"]["test"]>[0]) =>
			w.instanceMail.test(input),
		() => [],
	);

// Time
const timeChanged = (taskId?: string): QueryKey[] => [
	workKeys.timer(),
	["work", "time-report"],
	workKeys.tasks(),
	...(taskId ? [workKeys.taskPart(taskId, "time"), workKeys.task(taskId)] : []),
];
export const useStartWorkTimer = () =>
	useWorkMutation(
		(w, taskId: string) => w.time.start(taskId),
		(taskId, res) => [
			...timeChanged(taskId),
			...(res?.stopped ? timeChanged(res.stopped.taskId) : []),
		],
	);
export const useStopWorkTimer = () =>
	useWorkMutation(
		(w, _: undefined) => w.time.stop(),
		() => [workKeys.all],
	);
export const useCreateWorkTimeEntry = () =>
	useWorkMutation(
		(
			w,
			a: { taskId: string; input: Parameters<WorkApi["time"]["create"]>[1] },
		) => w.time.create(a.taskId, a.input),
		(a) => timeChanged(a.taskId),
	);
export const useUpdateWorkTimeEntry = () =>
	useWorkMutation(
		(
			w,
			a: {
				taskId: string;
				id: string;
				patch: Parameters<WorkApi["time"]["update"]>[1];
			},
		) => w.time.update(a.id, a.patch),
		(a) => timeChanged(a.taskId),
	);
export const useDeleteWorkTimeEntry = () =>
	useWorkMutation(
		(w, a: { taskId: string; id: string }) => w.time.remove(a.id),
		(a) => timeChanged(a.taskId),
	);

// Templates
export const useCreateWorkTemplate = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["templates"]["create"]>[0]) =>
			w.templates.create(input),
		() => [["work", "templates"]],
	);
export const useUpdateWorkTemplate = () =>
	useWorkMutation(
		(
			w,
			a: { id: string; patch: Parameters<WorkApi["templates"]["update"]>[1] },
		) => w.templates.update(a.id, a.patch),
		(a) => [["work", "templates"], workKeys.template(a.id)],
	);
export const useDeleteWorkTemplate = () =>
	useWorkMutation(
		(w, id: string) => w.templates.remove(id),
		() => [["work", "templates"]],
	);
export const useInstantiateWorkTemplate = () =>
	useWorkMutation(
		(
			w,
			a: {
				id: string;
				input: Parameters<WorkApi["templates"]["instantiate"]>[1];
			},
		) => w.templates.instantiate(a.id, a.input),
		(a) => (a.input.dryRun ? [] : [workKeys.all]),
	);

// Imports
export const useCreateWorkImport = () =>
	useWorkMutation(
		(w, input: Parameters<WorkApi["imports"]["create"]>[0]) =>
			w.imports.create(input),
		() => [workKeys.imports()],
	);
export const useWorkImportAction = () =>
	useWorkMutation(
		(w, a: { id: string; action: "dryRun" | "run" | "cancel" }) =>
			w.imports[a.action](a.id),
		(a) => [workKeys.imports(), workKeys.import(a.id)],
	);
/** Wizard calls with no cache: test the token, read the tree, upload a CSV. */
export const useClickUpTest = () =>
	useMutation({
		mutationFn: (input: Parameters<WorkApi["imports"]["clickupTest"]>[0]) =>
			work().imports.clickupTest(input),
	});
export const useClickUpTree = () =>
	useMutation({
		mutationFn: (input: Parameters<WorkApi["imports"]["clickupTree"]>[0]) =>
			work().imports.clickupTree(input),
	});
export const useClickUpInspect = () =>
	useMutation({
		mutationFn: (input: Parameters<WorkApi["imports"]["clickupInspect"]>[0]) =>
			work().imports.clickupInspect(input),
	});
export const useWorkCsvUpload = () =>
	useMutation({ mutationFn: (file: File) => work().imports.csvUpload(file) });

// Shares and guests
export const useCreateWorkShare = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{ input: Parameters<WorkApi["shares"]["create"]>[1] }>,
		) => w.shares.create(a.projectId, a.input),
		(a) => [workKeys.projectPart(a.projectId, "shares")],
	);
export const useRevokeWorkShare = () =>
	useWorkMutation(
		(w, a: ProjectArgs<{ id: string }>) => w.shares.revoke(a.id),
		(a) => [workKeys.projectPart(a.projectId, "shares")],
	);
export const useInviteWorkGuest = () =>
	useWorkMutation(
		(
			w,
			a: ProjectArgs<{ input: Parameters<WorkApi["guests"]["invite"]>[1] }>,
		) => w.guests.invite(a.projectId, a.input),
		(a) => [workKeys.projectPart(a.projectId, "people")],
	);

// AI assist: drafts only, nothing is written.
export const useWorkAiSummarise = () =>
	useMutation({ mutationFn: (taskId: string) => work().ai.summarise(taskId) });
export const useWorkAiSubtasks = () =>
	useMutation({ mutationFn: (taskId: string) => work().ai.subtasks(taskId) });
export const useWorkAiDescription = () =>
	useMutation({
		mutationFn: (taskId: string) => work().ai.description(taskId),
	});
