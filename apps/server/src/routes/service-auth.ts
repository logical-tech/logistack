import { createRoute, z } from "@hono/zod-openapi";
import { BasicAuthUserInput } from "@logistack/contracts";
import { serviceBasicAuth } from "@logistack/db";
import { eq } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { hashUsers } from "../basic-auth.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { byParam, requirePermission } from "../scope.ts";

const BasicAuthView = z
	.object({ users: z.array(z.object({ username: z.string() })) })
	.openapi("ServiceBasicAuth");

const BasicAuthInput = z.object({
	/** Empty turns protection off. A listed user without a password keeps the one it has. */
	users: z.array(BasicAuthUserInput).max(20),
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
					"The proxy checks the credentials before the request reaches the service; no redeploy is needed. Applies to domains added later too. A domain's own basic_auth rule (PUT /domains/{id}/access) adds its users to these.",
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
			const [row] = await db
				.select()
				.from(serviceBasicAuth)
				.where(eq(serviceBasicAuth.serviceId, id));
			const hashed = await hashUsers(users, row?.users ?? []);
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
