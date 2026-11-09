/** Work pages live in two shells: `/work/projects/…` (Work shell) and `/projects/$id/tasks/…` (ops). */
export type WorkBase = "work" | "ops";

export const overviewRoute = (base: WorkBase) =>
	base === "work"
		? ("/work/projects/$projectId" as const)
		: ("/projects/$projectId/tasks" as const);

export const viewRoute = (base: WorkBase) =>
	base === "work"
		? ("/work/projects/$projectId/v/$viewId" as const)
		: ("/projects/$projectId/tasks/v/$viewId" as const);

export const settingsRoute = (base: WorkBase) =>
	base === "work"
		? ("/work/projects/$projectId/settings" as const)
		: ("/projects/$projectId/tasks/settings" as const);
