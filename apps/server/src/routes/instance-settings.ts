import { createRoute, z } from "@hono/zod-openapi";
import { instanceSettings, organization } from "@logistack/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { one } from "../errors.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";

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
				// shortcut: any organization admin edits instance settings; split out an instance-admin role once instances host several organizations.
				middleware: [requirePermission("admin", inOrganization)],
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
	);
