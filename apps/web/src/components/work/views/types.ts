/*
 * The contract between ViewHost and the view components (table, board, timeline, calendar).
 * Keep it stable: views are built in parallel against it. Views mutate tasks through the hooks in
 * `@/lib/api/work-queries` (`usePatchWorkTask`, `useMoveWorkTask`, `useBulkWorkTasks`…), which
 * update every cached list optimistically.
 */
import type {
	WorkField,
	WorkList,
	WorkPerson,
	WorkProject,
	WorkStatus,
	WorkTag,
	WorkTask,
	WorkTaskCreate,
	WorkTaskListItem,
	WorkTaskListQuery,
	WorkView,
	WorkViewConfig,
} from "@logistack/contracts";

/** Everything about a project a view needs, loaded once by ViewHost. Arrays are in display order. */
export type WorkProjectContext = {
	id: string;
	/** `SHOP`. */
	key: string;
	name: string;
	settings: WorkProject;
	statuses: WorkStatus[];
	/** Lists that are not archived. */
	lists: WorkList[];
	fields: WorkField[];
	tags: WorkTag[];
	people: WorkPerson[];
	/** The actor holds `work`: edit, move, create tasks. */
	canEdit: boolean;
	/** The actor holds `work:admin`: statuses, fields, lists, shared views. */
	canAdmin: boolean;
};

/** The view's tasks as ViewHost fetched them. */
export type ViewTasks = {
	/**
	 * The list query behind `items` (project, view, filter incl. search and ad-hoc conditions,
	 * sort, closed, subtasks, includes). A view that pages per group (board columns) extends it
	 * with `groupBy` + `group` and runs `useWorkTasks` itself.
	 */
	query: WorkTaskListQuery;
	items: WorkTaskListItem[];
	/** When the server could count cheaply. */
	total: number | undefined;
	isLoading: boolean;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	fetchNextPage: () => void;
};

/** A quick-add draft: the list defaults to the view's list, else the project's default list. */
export type NewTaskInput = Omit<WorkTaskCreate, "listId"> & { listId?: string };

export type ViewProps = {
	project: WorkProjectContext;
	view: WorkView;
	/** The saved config with the viewer's unsaved changes applied: render from this, not `view.config`. */
	config: WorkViewConfig;
	tasks: ViewTasks;
	/** Opens the task sheet (`?task=` in the URL). */
	onOpenTask: (taskId: string) => void;
	/** An unsaved change (collapse a group, zoom, resize a column); ViewHost offers "Save view". */
	onConfigChange: (patch: Partial<WorkViewConfig>) => void;
	onCreateTask: (input: NewTaskInput) => Promise<WorkTask>;
};
