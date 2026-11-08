import { createRoute, z } from "@hono/zod-openapi";
import { type Db, instanceSettings, organization, user } from "@logistack/db";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { isInstanceAdminRole, requireActor } from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import {
	inOrganization,
	requireInstanceAdmin,
	requirePermission,
} from "../scope.ts";

const InstanceSettings = z
	.object({
		organizationName: z.string(),
		publicUrl: z.string().nullable(),
		letsencryptEmail: z.string().nullable(),
		generatedDomainBase: z.string(),
		localRegistryEnabled: z.boolean(),
		/** Lets source checks and other server-side requests reach private networks. */
		allowPrivateHosts: z.boolean(),
	})
	.openapi("InstanceSettings");

const InstanceAdmin = z
	.object({ id: z.string(), name: z.string(), email: z.string() })
	.openapi("InstanceAdmin");

const adminRole = sql`'admin' = any(string_to_array(replace(coalesce(${user.role}, ''), ' ', ''), ','))`;

/** better-auth's `user.role` is a comma list; add or drop `admin`, leaving the admin plugin's default `user`. */
function withAdmin(role: string | null, admin: boolean) {
	const rest = (role ?? "")
		.split(",")
		.map((r) => r.trim())
		.filter((r) => r && r !== "admin" && r !== "user");
	return [admin ? "admin" : "user", ...rest].join(",");
}

const admins = (db: Db) =>
	db
		.select({ id: user.id, name: user.name, email: user.email })
		.from(user)
		.where(adminRole)
		.orderBy(user.createdAt);

async function read(c: Context<Env>) {
	const { db } = c.var.deps;
	const [s] = await db
		.select()
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	const org = one(
		await db
			.select({ name: organization.name })
			.from(organization)
			.where(eq(organization.id, requireActor(c).organizationId)),
		"organization",
	);
	return {
		organizationName: org.name,
		publicUrl: s?.publicUrl ?? null,
		letsencryptEmail: s?.letsencryptEmail ?? null,
		generatedDomainBase: s?.generatedDomainBase ?? "sslip",
		localRegistryEnabled: s?.localRegistryEnabled ?? true,
		allowPrivateHosts: s?.allowPrivateHosts ?? false,
	};
}

export const instance = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/instance/settings",
			tags: ["settings"],
			security,
			summary: "Organization name and instance-wide settings",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(InstanceSettings, "Settings"), ...errors },
		}),
		async (c) => c.json(await read(c), 200),
	)
	.openapi(
		mutation(
			"instance.update",
			createRoute({
				method: "patch",
				path: "/instance/settings",
				tags: ["settings"],
				security,
				summary: "Change instance-wide security settings",
				middleware: [
					requirePermission("admin", inOrganization),
					requireInstanceAdmin,
				],
				request: body(z.object({ allowPrivateHosts: z.boolean() })),
				responses: { 200: json(InstanceSettings, "Settings"), ...errors },
			}),
		),
		async (c) => {
			const { allowPrivateHosts } = c.req.valid("json");
			const before = await read(c);
			await c.var.deps.db
				.update(instanceSettings)
				.set({ allowPrivateHosts })
				.where(eq(instanceSettings.id, "singleton"));
			c.set("auditDiff", {
				before: { allowPrivateHosts: before.allowPrivateHosts },
				after: { allowPrivateHosts },
			});
			return c.json({ ...before, allowPrivateHosts }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/instance/admins",
			tags: ["settings"],
			security,
			summary: "Instance admins",
			middleware: [requireInstanceAdmin],
			responses: { 200: json(z.array(InstanceAdmin), "Admins"), ...errors },
		}),
		async (c) => c.json(await admins(c.var.deps.db), 200),
	)
	.openapi(
		mutation(
			"instance.admin_add",
			createRoute({
				method: "post",
				path: "/instance/admins",
				tags: ["settings"],
				security,
				summary: "Make a user an instance admin",
				description:
					"The user must already have an account on this instance. Instance admins update the server, manage nodes and change instance-wide settings.",
				middleware: [requireInstanceAdmin],
				request: body(z.object({ email: z.string().trim().min(1) })),
				responses: { 200: json(z.array(InstanceAdmin), "Admins"), ...errors },
			}),
		),
		async (c) => {
			const { email } = c.req.valid("json");
			const { db } = c.var.deps;
			await db.transaction(async (tx) => {
				const [target] = await tx
					.select({ id: user.id, role: user.role, kind: user.kind })
					.from(user)
					.where(sql`lower(${user.email}) = lower(${email})`);
				if (!target || target.kind !== "human") throw notFound("user");
				if (!isInstanceAdminRole(target.role))
					await tx
						.update(user)
						.set({ role: withAdmin(target.role, true) })
						.where(eq(user.id, target.id));
				await auditInTx(c, tx, { resourceId: target.id, diff: { email } });
			});
			return c.json(await admins(db), 200);
		},
	)
	.openapi(
		mutation(
			"instance.admin_remove",
			createRoute({
				method: "delete",
				path: "/instance/admins/{id}",
				tags: ["settings"],
				security,
				summary: "Remove an instance admin",
				description: "The last instance admin cannot be removed.",
				middleware: [requireInstanceAdmin],
				request: { params: IdParam },
				responses: { 200: json(z.array(InstanceAdmin), "Admins"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			await db.transaction(async (tx) => {
				// Locking every admin row serializes concurrent removals, so two can never empty the list.
				const current = await tx
					.select({ id: user.id, role: user.role })
					.from(user)
					.where(adminRole)
					.for("update");
				const target = current.find((u) => u.id === id);
				if (!target) throw notFound("instance admin");
				if (current.length === 1)
					throw new Failure(
						"conflict",
						"the instance needs at least one admin; add another first",
					);
				await tx
					.update(user)
					.set({ role: withAdmin(target.role, false) })
					.where(eq(user.id, id));
				await auditInTx(c, tx, { resourceId: id });
			});
			return c.json(await admins(db), 200);
		},
	);
