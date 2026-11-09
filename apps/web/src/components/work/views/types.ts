import type {
	WorkProjectListItem,
	WorkView,
	WorkViewConfig,
} from "@logistack/contracts";

/** What the ViewHost hands every view kind. */
export type ViewProps = {
	project: WorkProjectListItem;
	view: WorkView;
	/** Effective config: the saved one plus ad-hoc changes. */
	config: WorkViewConfig;
	onConfigChange(next: Partial<WorkViewConfig>): void;
	onOpenTask(taskId: string): void;
	listId?: string;
};
