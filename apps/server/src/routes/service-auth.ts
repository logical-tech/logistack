import { createRoute, z } from "@hono/zod-openapi";
import { serviceBasicAuth } from "@logistack/db";
import { eq } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { Failure } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { byParam, requirePermission } from "../scope.ts";

const BasicAuthView = z
	.object({ users: z.array(z.object({ username: z.string() })) })
	.openapi("ServiceBasicAuth");

const BasicAuthInput = z.object({
	/** Empty turns protection off. A listed user without a password keeps the one it has. */
	users: z
		.array(
			z.object({
				username: z
					.string()
					.trim()
					.min(1)
					.max(64)
					.regex(/^[^:\s]+$/, "no colons or spaces"),
				password: z.string().min(8).max(128).optional(),
			}),
		)
		.max(20),
});

export const serviceAuth = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/basic-auth",
			tags: ["services"],
			security,
			summary: "Who may pass the proxy's basic auth in front of the service",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(BasicAuthView, "Users, never hashes"), ...errors },
		}),
		async (c) => {
			const [row] = await c.var.deps.db
				.select()
				.from(serviceBasicAuth)
				.where(eq(serviceBasicAuth.serviceId, c.req.valid("param").id));
			return c.json(
				{ users: (row?.users ?? []).map((u) => ({ username: u.username })) },
				200,
			);
		},
	)
	.openapi(
		mutation(
			"service.basic_auth",
			createRoute({
				method: "put",
				path: "/services/{id}/basic-auth",
				tags: ["services"],
				security,
				summary:
					"Set or clear basic auth in front of every domain of the service",
				description:
					"The proxy checks the credentials before the request reaches the service; no redeploy is needed.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(BasicAuthInput) },
				responses: { 200: json(BasicAuthView, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { users } = c.req.valid("json");
			const { db, config } = c.var.deps;
			c.set("auditResourceId", id);
			if (new Set(users.map((u) => u.username)).size !== users.length)
				throw new Failure("bad_request", "usernames must be unique");
			const [row] = await db
				.select()
				.from(serviceBasicAuth)
				.where(eq(serviceBasicAuth.serviceId, id));
			const hashed = await Promise.all(
				users.map(async (u) => {
					if (u.password)
						return {
							username: u.username,
							hash: await Bun.password.hash(u.password, {
								algorithm: "bcrypt",
								cost: 10,
							}),
						};
					const kept = row?.users.find((x) => x.username === u.username);
					if (!kept)
						throw new Failure("bad_request", `${u.username} needs a password`);
					return kept;
				}),
			);
			if (hashed.length === 0)
				await db
					.delete(serviceBasicAuth)
					.where(eq(serviceBasicAuth.serviceId, id));
			else
				await db
					.insert(serviceBasicAuth)
					.values({ serviceId: id, users: hashed })
					.onConflictDoUpdate({
						target: serviceBasicAuth.serviceId,
						set: { users: hashed },
					});
			await requestProxySync(config.REDIS_URL, "basic auth changed").catch(
				(err: unknown) =>
					log("warn", "proxy sync request failed", { error: String(err) }),
			);
			return c.json(
				{ users: hashed.map((u) => ({ username: u.username })) },
				200,
			);
		},
	);
