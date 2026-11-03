import { createRoute, z } from "@hono/zod-openapi";
import { DatabaseSchema } from "@logistack/contracts";
import { openDatabase } from "../database.ts";
import { errors, json, router, security } from "../openapi.ts";
import { byParam, requirePermission } from "../scope.ts";

const Id = z.object({ id: z.string() });
const svc = byParam("service");

export const databases = router().openapi(
	createRoute({
		method: "get",
		path: "/databases/{id}/schema",
		tags: ["databases"],
		security,
		summary: "Schemas, tables, views and columns of a database service",
		description:
			"A database deployed before the explorer existed is not on its network yet: the call fails with 409 and `details.reason` `unreachable` until the service is redeployed.",
		middleware: [requirePermission("read", svc)],
		request: { params: Id },
		responses: { 200: json(DatabaseSchema, "Schema"), ...errors },
	}),
	async (c) => {
		const db = await openDatabase(c, c.req.valid("param").id);
		return c.json(await db.client.introspect(), 200);
	},
);
