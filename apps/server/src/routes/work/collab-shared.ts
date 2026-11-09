import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import type { PermissionAction } from "@logistack/contracts";
import { type WorkRouteName, workRoutes } from "@logistack/contracts";
import { project, workProject, workTask } from "@logistack/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../../actor.ts";
import type { Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import { security } from "../../openapi.ts";
import { checkWork } from "../../work/context.ts";

type Method = Lowercase<(typeof workRoutes)[WorkRouteName]["method"]>;

/** An OpenAPI route from the shared table: method, path and operation id come from contracts. */
export function workRoute<R extends Omit<RouteConfig, "method" | "path">>(
	name: WorkRouteName,
	rest: R,
) {
	const r = workRoutes[name];
	return createRoute({
		tags: ["work"],
		security,
		...rest,
		method: r.method.toLowerCase() as Method,
		path: r.path.replace(/:(\w+)/g, "{$1}"),
		operationId: r.operationId,
	});
}

/** The task with what permission checks, events and emails need; 404 outside the actor's org. */
export async function loadTask(c: Context<Env>, taskId: string) {
	const [t] = await c.var.deps.db
		.select({
			id: workTask.id,
			projectId: workTask.projectId,
			number: workTask.number,
			title: workTask.title,
			createdBy: workTask.createdBy,
			key: workProject.key,
			organizationId: project.organizationId,
			archivedAt: project.archivedAt,
		})
		.from(workTask)
		.innerJoin(project, eq(project.id, workTask.projectId))
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.where(eq(workTask.id, taskId));
	if (!t || t.organizationId !== requireActor(c).organizationId)
		throw notFound("task");
	return t;
}

export type LoadedTask = Awaited<ReturnType<typeof loadTask>>;

/** `checkWork` on the task's project; mutations also refuse an archived project. */
export async function checkTask(
	c: Context<Env>,
	action: PermissionAction,
	t: LoadedTask,
	mutating = action !== "read:work",
) {
	const r = await checkWork(c, action, t.projectId);
	if (mutating && t.archivedAt)
		throw new Failure("conflict", "project archived");
	return r;
}
