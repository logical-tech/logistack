/*
 * Work (project management): every route of `workRoutes` in @logistack/contracts.
 * Plain fetch over `workPath`, since the server routes land separately from this client.
 */
import {
	type ClickUpConnection,
	type ClickUpInspection,
	type ClickUpInspectRequest,
	type ClickUpToken,
	type ClickUpTreeNode,
	type ClickUpTreeRequest,
	type CsvUpload,
	type ProjectHealth,
	type WorkAiDescription,
	type WorkAiSubtasks,
	type WorkAiSummary,
	type WorkAttachment,
	type WorkAttachmentInline,
	type WorkChecklistCreate,
	type WorkChecklistItem,
	type WorkChecklistPatch,
	type WorkComment,
	type WorkCommentCreate,
	type WorkCommentPatch,
	type WorkDependencyCreate,
	type WorkFeedPage,
	type WorkField,
	type WorkFieldCreate,
	type WorkFieldPatch,
	type WorkGuestInvite,
	type WorkGuestInvited,
	type WorkIcalToken,
	type WorkImport,
	type WorkImportCreate,
	type WorkInboxPage,
	type WorkInboxRead,
	type WorkList,
	type WorkListCreate,
	type WorkListPatch,
	type WorkMyTasks,
	type WorkPerson,
	type WorkPrefs,
	type WorkPrefsUpdate,
	type WorkProject,
	type WorkProjectListItem,
	type WorkProjectSettingsPatch,
	type WorkProjectSummary,
	type WorkReaction,
	type WorkRouteName,
	type WorkSearchResult,
	type WorkServiceName,
	type WorkShare,
	type WorkShareCreate,
	type WorkShareCreated,
	type WorkShiftPreview,
	type WorkShiftPreviewRequest,
	type WorkStatus,
	type WorkStatusCreate,
	type WorkStatusPatch,
	type WorkTag,
	type WorkTagCreate,
	type WorkTagPatch,
	type WorkTask,
	type WorkTaskBulk,
	type WorkTaskBulkResult,
	type WorkTaskByKey,
	type WorkTaskCreate,
	type WorkTaskDuplicate,
	type WorkTaskListQuery,
	type WorkTaskMove,
	type WorkTaskMoveProject,
	type WorkTaskMoveProjectResult,
	type WorkTaskPage,
	type WorkTaskPatch,
	type WorkTemplate,
	type WorkTemplateCreate,
	type WorkTemplateInstantiate,
	type WorkTemplateInstantiateResult,
	type WorkTemplateListItem,
	type WorkTemplatePatch,
	type WorkTimeEntry,
	type WorkTimeEntryCreate,
	type WorkTimeEntryPatch,
	type WorkTimeReport,
	type WorkTimeReportQuery,
	type WorkTimer,
	type WorkTimerStart,
	type WorkView,
	type WorkViewCreate,
	type WorkViewPatch,
	type WorkWorkload,
	type WorkWorkloadQuery,
	workPath,
	workRoutes,
} from "@logistack/contracts";
import { ApiError } from "./adapter";

export type WorkAttachmentUpload = {
	file: File | Blob;
	/** Name sent with a Blob (a pasted image). */
	name?: string;
	taskId?: string;
	commentId?: string;
	inline?: WorkAttachmentInline;
};

export type WorkApi = {
	projects: {
		list(): Promise<WorkProjectListItem[]>;
		get(id: string): Promise<WorkProject>;
		updateSettings(
			id: string,
			patch: WorkProjectSettingsPatch,
		): Promise<WorkProject>;
		health(id: string): Promise<ProjectHealth>;
		summary(id: string): Promise<WorkProjectSummary>;
		people(id: string): Promise<WorkPerson[]>;
		/** Service names for the hidden-services picker (work:admin). */
		services(id: string): Promise<WorkServiceName[]>;
	};
	statuses: {
		list(projectId: string): Promise<WorkStatus[]>;
		create(projectId: string, input: WorkStatusCreate): Promise<WorkStatus>;
		update(id: string, patch: WorkStatusPatch): Promise<WorkStatus>;
		/** Its tasks move to `moveTo`. */
		remove(id: string, moveTo: string): Promise<void>;
		reorder(projectId: string, ids: string[]): Promise<WorkStatus[]>;
	};
	lists: {
		list(projectId: string): Promise<WorkList[]>;
		create(projectId: string, input: WorkListCreate): Promise<WorkList>;
		update(id: string, patch: WorkListPatch): Promise<WorkList>;
		remove(
			id: string,
			opts?: { moveTo?: string; deleteTasks?: boolean },
		): Promise<void>;
		archive(id: string): Promise<WorkList>;
		restore(id: string): Promise<WorkList>;
		reorder(projectId: string, ids: string[]): Promise<WorkList[]>;
	};
	fields: {
		list(projectId: string): Promise<WorkField[]>;
		create(projectId: string, input: WorkFieldCreate): Promise<WorkField>;
		update(id: string, patch: WorkFieldPatch): Promise<WorkField>;
		remove(id: string): Promise<void>;
		reorder(projectId: string, ids: string[]): Promise<WorkField[]>;
	};
	tags: {
		list(projectId: string): Promise<WorkTag[]>;
		create(projectId: string, input: WorkTagCreate): Promise<WorkTag>;
		update(id: string, patch: WorkTagPatch): Promise<WorkTag>;
		remove(id: string): Promise<void>;
	};
	views: {
		list(projectId: string): Promise<WorkView[]>;
		create(projectId: string, input: WorkViewCreate): Promise<WorkView>;
		update(id: string, patch: WorkViewPatch): Promise<WorkView>;
		remove(id: string): Promise<void>;
		reorder(projectId: string, ids: string[]): Promise<WorkView[]>;
	};
	tasks: {
		list(query: WorkTaskListQuery): Promise<WorkTaskPage>;
		/** Where "Export CSV" points: the same query with `format=csv`. */
		csvUrl(query: WorkTaskListQuery): string;
		byKey(key: string): Promise<WorkTaskByKey>;
		create(input: WorkTaskCreate): Promise<WorkTask>;
		get(id: string): Promise<WorkTask>;
		/** 409 `conflict` with the current task in `details` when `expectedUpdatedAt` is stale. */
		update(id: string, patch: WorkTaskPatch): Promise<WorkTask>;
		move(id: string, input: WorkTaskMove): Promise<WorkTask>;
		moveProject(
			id: string,
			input: WorkTaskMoveProject,
			dryRun?: boolean,
		): Promise<WorkTaskMoveProjectResult>;
		duplicate(id: string, input: WorkTaskDuplicate): Promise<WorkTask>;
		archive(id: string): Promise<WorkTask>;
		restore(id: string): Promise<WorkTask>;
		remove(id: string): Promise<void>;
		bulk(input: WorkTaskBulk): Promise<WorkTaskBulkResult>;
		addAssignee(id: string, userId: string): Promise<void>;
		removeAssignee(id: string, userId: string): Promise<void>;
		watch(id: string, userId: string): Promise<void>;
		unwatch(id: string, userId: string): Promise<void>;
		addTag(id: string, tagId: string): Promise<void>;
		removeTag(id: string, tagId: string): Promise<void>;
		setField(id: string, fieldId: string, value: unknown): Promise<void>;
		clearField(id: string, fieldId: string): Promise<void>;
		addDependency(id: string, input: WorkDependencyCreate): Promise<void>;
		removeDependency(id: string, blockedById: string): Promise<void>;
		shiftPreview(
			id: string,
			input: WorkShiftPreviewRequest,
		): Promise<WorkShiftPreview>;
		/** Comments and activity merged, newest last; `cursor` pages older items. */
		activity(id: string, cursor?: string): Promise<WorkFeedPage>;
	};
	checklist: {
		list(taskId: string): Promise<WorkChecklistItem[]>;
		create(
			taskId: string,
			input: WorkChecklistCreate,
		): Promise<WorkChecklistItem>;
		update(id: string, patch: WorkChecklistPatch): Promise<WorkChecklistItem>;
		remove(id: string): Promise<void>;
		/** Returns the new subtask. */
		convert(id: string): Promise<WorkTask>;
	};
	comments: {
		list(taskId: string): Promise<WorkComment[]>;
		create(taskId: string, input: WorkCommentCreate): Promise<WorkComment>;
		update(id: string, patch: WorkCommentPatch): Promise<WorkComment>;
		remove(id: string): Promise<void>;
		resolve(id: string): Promise<WorkComment>;
		unresolve(id: string): Promise<WorkComment>;
		react(id: string, emoji: WorkReaction): Promise<void>;
		unreact(id: string, emoji: WorkReaction): Promise<void>;
	};
	attachments: {
		upload(input: WorkAttachmentUpload): Promise<WorkAttachment>;
		url(id: string, thumb?: boolean): string;
		remove(id: string): Promise<void>;
	};
	me: {
		tasks(opts?: { watching?: boolean }): Promise<WorkMyTasks>;
		inbox(opts?: { unread?: boolean; cursor?: string }): Promise<WorkInboxPage>;
		markRead(input: WorkInboxRead): Promise<void>;
		prefs(): Promise<WorkPrefs>;
		updatePrefs(input: WorkPrefsUpdate): Promise<WorkPrefs>;
		/** Rotates the token; the URL is shown once. */
		rotateIcal(): Promise<WorkIcalToken>;
	};
	search(q: string, projectId?: string): Promise<WorkSearchResult>;
	time: {
		start(taskId: string): Promise<WorkTimerStart>;
		stop(): Promise<WorkTimer>;
		current(): Promise<WorkTimer>;
		list(taskId: string): Promise<WorkTimeEntry[]>;
		create(taskId: string, input: WorkTimeEntryCreate): Promise<WorkTimeEntry>;
		update(id: string, patch: WorkTimeEntryPatch): Promise<WorkTimeEntry>;
		remove(id: string): Promise<void>;
		report(query: WorkTimeReportQuery): Promise<WorkTimeReport>;
		reportCsvUrl(query: WorkTimeReportQuery): string;
	};
	templates: {
		list(projectId?: string): Promise<WorkTemplateListItem[]>;
		get(id: string): Promise<WorkTemplate>;
		create(input: WorkTemplateCreate): Promise<WorkTemplate>;
		update(id: string, patch: WorkTemplatePatch): Promise<WorkTemplate>;
		remove(id: string): Promise<void>;
		instantiate(
			id: string,
			input: WorkTemplateInstantiate,
		): Promise<WorkTemplateInstantiateResult>;
	};
	imports: {
		list(): Promise<WorkImport[]>;
		get(id: string): Promise<WorkImport>;
		create(input: WorkImportCreate): Promise<WorkImport>;
		dryRun(id: string): Promise<WorkImport>;
		run(id: string): Promise<WorkImport>;
		cancel(id: string): Promise<WorkImport>;
		clickupTest(input: ClickUpToken): Promise<ClickUpConnection>;
		clickupTree(input: ClickUpTreeRequest): Promise<ClickUpTreeNode[]>;
		clickupInspect(input: ClickUpInspectRequest): Promise<ClickUpInspection>;
		csvUpload(file: File): Promise<CsvUpload>;
	};
	shares: {
		list(projectId: string): Promise<WorkShare[]>;
		create(
			projectId: string,
			input: WorkShareCreate,
		): Promise<WorkShareCreated>;
		revoke(id: string): Promise<void>;
	};
	guests: {
		invite(
			projectId: string,
			input: WorkGuestInvite,
		): Promise<WorkGuestInvited>;
	};
	workload(query?: WorkWorkloadQuery): Promise<WorkWorkload>;
	ai: {
		summarise(taskId: string): Promise<WorkAiSummary>;
		subtasks(taskId: string): Promise<WorkAiSubtasks>;
		description(taskId: string): Promise<WorkAiDescription>;
	};
};

type Query = Record<string, unknown>;

/** `?a=1&b=2`, dropping empty values. */
export function workQuery(query: Query = {}): string {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(query))
		if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
	const s = qs.toString();
	return s ? `?${s}` : "";
}

const url = (
	name: WorkRouteName,
	params?: Record<string, string>,
	query?: Query,
) => workPath(name, params) + workQuery(query);

async function call<T>(
	name: WorkRouteName,
	opts: {
		params?: Record<string, string>;
		query?: Query;
		json?: unknown;
		form?: FormData;
	} = {},
): Promise<T> {
	const res = await fetch(url(name, opts.params, opts.query), {
		method: workRoutes[name].method,
		credentials: "include",
		...(opts.json !== undefined
			? {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(opts.json),
				}
			: opts.form
				? { body: opts.form }
				: {}),
	});
	if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
	const payload = (await res.json().catch(() => null)) as {
		error?: { code?: string; message?: string; details?: unknown };
	} | null;
	throw new ApiError(
		res.status,
		payload?.error?.message ?? `${res.url} failed with ${res.status}`,
		payload?.error?.code,
		payload?.error?.details,
	);
}

const id = (v: string) => ({ id: v });
const order = (name: WorkRouteName) => (projectId: string, ids: string[]) =>
	call<never>(name, { params: id(projectId), json: { ids } });

export const workHttp: WorkApi = {
	projects: {
		list: () => call("projectList"),
		get: (v) => call("projectGet", { params: id(v) }),
		updateSettings: (v, json) =>
			call("projectSettings", { params: id(v), json }),
		health: (v) => call("projectHealth", { params: id(v) }),
		summary: (v) => call("projectSummary", { params: id(v) }),
		people: (v) => call("projectPeople", { params: id(v) }),
		services: (v) => call("projectServices", { params: id(v) }),
	},
	statuses: {
		list: (v) => call("statusList", { params: id(v) }),
		create: (v, json) => call("statusCreate", { params: id(v), json }),
		update: (v, json) => call("statusUpdate", { params: id(v), json }),
		remove: (v, moveTo) =>
			call("statusDelete", { params: id(v), query: { moveTo } }),
		reorder: order("statusOrder"),
	},
	lists: {
		list: (v) => call("listList", { params: id(v) }),
		create: (v, json) => call("listCreate", { params: id(v), json }),
		update: (v, json) => call("listUpdate", { params: id(v), json }),
		remove: (v, opts = {}) =>
			call("listDelete", { params: id(v), query: opts }),
		archive: (v) => call("listArchive", { params: id(v) }),
		restore: (v) => call("listRestore", { params: id(v) }),
		reorder: order("listOrder"),
	},
	fields: {
		list: (v) => call("fieldList", { params: id(v) }),
		create: (v, json) => call("fieldCreate", { params: id(v), json }),
		update: (v, json) => call("fieldUpdate", { params: id(v), json }),
		remove: (v) => call("fieldDelete", { params: id(v) }),
		reorder: order("fieldOrder"),
	},
	tags: {
		list: (v) => call("tagList", { params: id(v) }),
		create: (v, json) => call("tagCreate", { params: id(v), json }),
		update: (v, json) => call("tagUpdate", { params: id(v), json }),
		remove: (v) => call("tagDelete", { params: id(v) }),
	},
	views: {
		list: (v) => call("viewList", { params: id(v) }),
		create: (v, json) => call("viewCreate", { params: id(v), json }),
		update: (v, json) => call("viewUpdate", { params: id(v), json }),
		remove: (v) => call("viewDelete", { params: id(v) }),
		reorder: order("viewOrder"),
	},
	tasks: {
		list: (query) => call("taskList", { query }),
		csvUrl: (query) => url("taskList", undefined, { ...query, format: "csv" }),
		byKey: (key) => call("taskByKey", { params: { key } }),
		create: (json) => call("taskCreate", { json }),
		get: (v) => call("taskGet", { params: id(v) }),
		update: (v, json) => call("taskUpdate", { params: id(v), json }),
		move: (v, json) => call("taskMove", { params: id(v), json }),
		moveProject: (v, json, dryRun) =>
			call("taskMoveProject", {
				params: id(v),
				json,
				query: { dryRun: dryRun || undefined },
			}),
		duplicate: (v, json) => call("taskDuplicate", { params: id(v), json }),
		archive: (v) => call("taskArchive", { params: id(v) }),
		restore: (v) => call("taskRestore", { params: id(v) }),
		remove: (v) => call("taskDelete", { params: id(v) }),
		bulk: (json) => call("taskBulk", { json }),
		addAssignee: (v, userId) =>
			call("taskAssigneeAdd", { params: { id: v, userId } }),
		removeAssignee: (v, userId) =>
			call("taskAssigneeRemove", { params: { id: v, userId } }),
		watch: (v, userId) => call("taskWatcherAdd", { params: { id: v, userId } }),
		unwatch: (v, userId) =>
			call("taskWatcherRemove", { params: { id: v, userId } }),
		addTag: (v, tagId) => call("taskTagAdd", { params: { id: v, tagId } }),
		removeTag: (v, tagId) =>
			call("taskTagRemove", { params: { id: v, tagId } }),
		setField: (v, fieldId, value) =>
			call("taskFieldSet", { params: { id: v, fieldId }, json: { value } }),
		clearField: (v, fieldId) =>
			call("taskFieldClear", { params: { id: v, fieldId } }),
		addDependency: (v, json) =>
			call("taskDependencyAdd", { params: id(v), json }),
		removeDependency: (v, blockedById) =>
			call("taskDependencyRemove", { params: { id: v, blockedById } }),
		shiftPreview: (v, json) =>
			call("taskShiftPreview", { params: id(v), json }),
		activity: (v, cursor) =>
			call("taskActivity", { params: id(v), query: { cursor } }),
	},
	checklist: {
		list: (v) => call("checklistList", { params: id(v) }),
		create: (v, json) => call("checklistCreate", { params: id(v), json }),
		update: (v, json) => call("checklistUpdate", { params: id(v), json }),
		remove: (v) => call("checklistDelete", { params: id(v) }),
		convert: (v) => call("checklistConvert", { params: id(v) }),
	},
	comments: {
		list: (v) => call("commentList", { params: id(v) }),
		create: (v, json) => call("commentCreate", { params: id(v), json }),
		update: (v, json) => call("commentUpdate", { params: id(v), json }),
		remove: (v) => call("commentDelete", { params: id(v) }),
		resolve: (v) => call("commentResolve", { params: id(v) }),
		unresolve: (v) => call("commentUnresolve", { params: id(v) }),
		react: (v, emoji) => call("reactionAdd", { params: { id: v, emoji } }),
		unreact: (v, emoji) => call("reactionRemove", { params: { id: v, emoji } }),
	},
	attachments: {
		upload: ({ file, name, taskId, commentId, inline }) => {
			const form = new FormData();
			form.set(
				"file",
				file,
				name ?? (file instanceof File ? file.name : "file"),
			);
			if (taskId) form.set("taskId", taskId);
			if (commentId) form.set("commentId", commentId);
			if (inline) form.set("inline", inline);
			return call("attachmentUpload", { form });
		},
		url: (v, thumb) =>
			url("attachmentGet", id(v), { thumb: thumb ? 1 : undefined }),
		remove: (v) => call("attachmentDelete", { params: id(v) }),
	},
	me: {
		tasks: ({ watching } = {}) =>
			call("myTasks", {
				query: { include: watching ? "watching" : undefined },
			}),
		inbox: ({ unread, cursor } = {}) =>
			call("inbox", { query: { unread: unread ? 1 : undefined, cursor } }),
		markRead: (json) => call("inboxRead", { json }),
		prefs: () => call("prefsGet"),
		updatePrefs: (json) => call("prefsUpdate", { json }),
		rotateIcal: () => call("icalToken"),
	},
	search: (q, projectId) => call("search", { query: { q, projectId } }),
	time: {
		start: (v) => call("timerStart", { params: id(v) }),
		stop: () => call("timerStop"),
		current: () => call("timerGet"),
		list: (v) => call("timeList", { params: id(v) }),
		create: (v, json) => call("timeCreate", { params: id(v), json }),
		update: (v, json) => call("timeUpdate", { params: id(v), json }),
		remove: (v) => call("timeDelete", { params: id(v) }),
		report: (query) => call("timeReport", { query }),
		reportCsvUrl: (query) =>
			url("timeReport", undefined, { ...query, format: "csv" }),
	},
	templates: {
		list: (projectId) => call("templateList", { query: { projectId } }),
		get: (v) => call("templateGet", { params: id(v) }),
		create: (json) => call("templateCreate", { json }),
		update: (v, json) => call("templateUpdate", { params: id(v), json }),
		remove: (v) => call("templateDelete", { params: id(v) }),
		instantiate: (v, json) =>
			call("templateInstantiate", { params: id(v), json }),
	},
	imports: {
		list: () => call("importList"),
		get: (v) => call("importGet", { params: id(v) }),
		create: (json) => call("importCreate", { json }),
		dryRun: (v) => call("importDryRun", { params: id(v) }),
		run: (v) => call("importRun", { params: id(v) }),
		cancel: (v) => call("importCancel", { params: id(v) }),
		clickupTest: (json) => call("clickupTest", { json }),
		clickupTree: (json) => call("clickupTree", { json }),
		clickupInspect: (json) => call("clickupInspect", { json }),
		csvUpload: (file) => {
			const form = new FormData();
			form.set("file", file);
			return call("csvUpload", { form });
		},
	},
	shares: {
		list: (v) => call("shareList", { params: id(v) }),
		create: (v, json) => call("shareCreate", { params: id(v), json }),
		revoke: (v) => call("shareRevoke", { params: id(v) }),
	},
	guests: {
		invite: (v, json) => call("guestInvite", { params: id(v), json }),
	},
	workload: (query = {}) => call("workload", { query }),
	ai: {
		summarise: (v) => call("aiSummarise", { params: id(v) }),
		subtasks: (v) => call("aiSubtasks", { params: id(v) }),
		description: (v) => call("aiDescription", { params: id(v) }),
	},
};
