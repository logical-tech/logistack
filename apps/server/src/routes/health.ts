import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { errors, json, router, security } from "../openapi.ts";

const Health = z
	.object({
		status: z.enum(["ok", "degraded"]),
		db: z.boolean(),
		redis: z.boolean(),
	})
	.openapi("Health");

const Version = z
	.object({ version: z.string(), commit: z.string().optional() })
	.openapi("Version");

export const health = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/version",
			tags: ["health"],
			security,
			summary: "The LogiStack version this server runs",
			responses: { 200: json(Version, "Version"), ...errors },
		}),
		(c) => {
			requireActor(c);
			const { LOGISTACK_VERSION: version, LOGISTACK_COMMIT: commit } =
				c.var.deps.config;
			return c.json({ version, ...(commit && { commit }) }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/health",
			tags: ["health"],
			summary: "Container healthcheck: Postgres and Redis reachable",
			responses: {
				200: json(Health, "Healthy"),
				503: json(Health, "A dependency is down"),
			},
		}),
		async (c) => {
			const { db, bus } = c.var.deps;
			const [dbOk, redisOk] = await Promise.all([
				db.execute(sql`select 1`).then(
					() => true,
					() => false,
				),
				bus.ping(),
			]);
			const ok = dbOk && redisOk;
			return c.json(
				{
					status: ok ? ("ok" as const) : ("degraded" as const),
					db: dbOk,
					redis: redisOk,
				},
				ok ? 200 : 503,
			);
		},
	);
