import type { RouteConfig } from "@hono/zod-openapi";
import { type WorkRouteName, workRoutes } from "@logistack/contracts";
import { type AuditAction, mutation } from "../../audit.ts";
import { security } from "../../openapi.ts";

type Extra = Omit<RouteConfig, "method" | "path">;

/**
 * An OpenAPI route config from the shared `workRoutes` table (method, path, operationId), so the
 * server registers exactly what the web client calls. Paths are relative to the `/api` mount.
 */
export function spec<E extends Extra>(
	name: WorkRouteName,
	extra: E,
): E & { method: RouteConfig["method"]; path: string } {
	const r = workRoutes[name];
	return {
		...extra,
		method: r.method.toLowerCase() as RouteConfig["method"],
		path: r.path.replace(/^\/api/, "").replace(/:(\w+)/g, "{$1}"),
		operationId: r.operationId,
		tags: ["work"],
		security,
		...(r.note ? { description: r.note } : {}),
	};
}

/** `spec` for a mutating route, wrapped in the audit middleware. */
export const mutationSpec = <E extends Extra>(
	action: AuditAction,
	name: WorkRouteName,
	extra: E,
) => mutation(action, spec(name, extra));
