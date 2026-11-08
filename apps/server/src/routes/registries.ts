import { createRoute, z } from "@hono/zod-openapi";
import { RegistryKind } from "@logistack/contracts";
import { decrypt, encrypt } from "@logistack/core";
import {
	type Db,
	instanceSettings,
	registry,
	registryRetention,
} from "@logistack/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, notFound, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { checkRegistry } from "../registry/client.ts";
import {
	inOrganization,
	requireInstanceAdmin,
	requirePermission,
} from "../scope.ts";
import { guardedFetch, hostPolicy } from "../ssrf.ts";

export const DEFAULT_KEEP_TAGS = 10;

const KeepTags = z.int().min(1).max(500);

const Registry = z
	.object({
		id: z.string(),
		kind: RegistryKind,
		url: z.string(),
		username: z.string().nullable(),
		hasPassword: z.boolean(),
		isDefault: z.boolean(),
		/** The newest N images of each service survive the hourly prune. */
		keepTags: z.int(),
		createdAt: z.string(),
	})
	.openapi("Registry");

const Registries = z
	.object({
		local: z.object({
			enabled: z.boolean(),
			/** Where nodes push and pull: `registry.<instance domain>`. Null without a domain. */
			url: z.string().nullable(),
			registryId: z.string().nullable(),
		}),
		registries: z.array(Registry),
	})
	.openapi("Registries");

/** External registries; the local one is managed through its switch. */
const ExternalKind = z.enum(["ghcr", "dockerhub", "gitlab", "generic"]);

const Url = z
	.string()
	.trim()
	.regex(
		/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/i,
		"a host with an optional namespace, like ghcr.io/acme",
	);

const Credentials = z.object({
	username: z.string().trim().min(1).optional(),
	password: z.string().min(1).optional(),
});

export const RegistryInput = Credentials.extend({
	kind: ExternalKind,
	url: Url,
	isDefault: z.boolean().default(false),
	keepTags: KeepTags.default(DEFAULT_KEEP_TAGS),
});

const Check = z
	.object({
		ok: z.boolean(),
		message: z.string(),
		detail: z.string().optional(),
	})
	.openapi("RegistryCheck");

async function instanceDomain(db: Db): Promise<string | null> {
	const [s] = await db.select().from(instanceSettings);
	if (s?.primaryDomain) return s.primaryDomain;
	return s?.publicUrl ? new URL(s.publicUrl).hostname : null;
}

/** One default per organization (a partial unique index enforces it); clears the others first. */
async function makeDefault(db: Db, organizationId: string, id: string) {
	await db.transaction(async (tx) => {
		await tx
			.update(registry)
			.set({ isDefault: false })
			.where(
				and(
					eq(registry.organizationId, organizationId),
					ne(registry.id, id),
					eq(registry.isDefault, true),
				),
			);
		await tx
			.update(registry)
			.set({ isDefault: true })
			.where(eq(registry.id, id));
	});
}

const randomPassword = () =>
	crypto
		.getRandomValues(new Uint8Array(24))
		.toBase64({ alphabet: "base64url" });

export const registries = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/registries",
			tags: ["registries"],
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(Registries, "Registries"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const [settings] = await db.select().from(instanceSettings);
			const rows = await db
				.select({ registry, keepTags: registryRetention.keepTags })
				.from(registry)
				.leftJoin(
					registryRetention,
					eq(registryRetention.registryId, registry.id),
				)
				.where(eq(registry.organizationId, orgId))
				.orderBy(asc(registry.createdAt));
			const local = rows.find((r) => r.registry.kind === "local")?.registry;
			const domain = await instanceDomain(db);
			return c.json(
				{
					local: {
						enabled: Boolean(settings?.localRegistryEnabled && local),
						url: local?.url ?? (domain ? `registry.${domain}` : null),
						registryId: local?.id ?? null,
					},
					registries: rows.map(({ registry: r, keepTags }) => ({
						id: r.id,
						kind: r.kind,
						url: r.url,
						username: r.username,
						hasPassword: r.passwordEncrypted !== null,
						isDefault: r.isDefault,
						keepTags: keepTags ?? DEFAULT_KEEP_TAGS,
						createdAt: r.createdAt.toISOString(),
					})),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"registry.test",
			createRoute({
				method: "post",
				path: "/registries/test",
				tags: ["registries"],
				security,
				summary: "Log in, push and pull a test image",
				description:
					"Pushes `<url>/logistack-check:check`, a few hundred bytes, through the registry API and reads it back. Nothing is stored in LogiStack.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(Credentials.extend({ url: Url })),
				responses: { 200: json(Check, "Result"), ...errors },
			}),
		),
		async (c) => {
			const { url, username, password } = c.req.valid("json");
			const policy = await hostPolicy(c.var.deps.db);
			return c.json(
				await checkRegistry(
					url,
					username && password ? { username, password } : undefined,
					// The registry and its token realm are user-chosen hosts.
					((u: string | URL, init?: RequestInit) =>
						guardedFetch(u, init ?? {}, policy)) as typeof fetch,
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"registry.create",
			createRoute({
				method: "post",
				path: "/registries",
				tags: ["registries"],
				security,
				summary: "Add an external registry",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(RegistryInput),
				responses: {
					201: json(z.object({ id: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const row = one(
				await db
					.insert(registry)
					.values({
						organizationId: orgId,
						kind: input.kind,
						url: input.url,
						username: input.username ?? null,
						passwordEncrypted: input.password
							? await encrypt(masterKey, input.password)
							: null,
					})
					.returning({ id: registry.id }),
			);
			await db
				.insert(registryRetention)
				.values({ registryId: row.id, keepTags: input.keepTags });
			if (input.isDefault) await makeDefault(db, orgId, row.id);
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	)
	.openapi(
		mutation(
			"registry.update",
			createRoute({
				method: "patch",
				path: "/registries/{id}",
				tags: ["registries"],
				security,
				summary: "Make a registry the default, or change its retention",
				middleware: [requirePermission("admin", inOrganization)],
				request: {
					params: IdParam,
					...body(
						z
							.object({ isDefault: z.boolean(), keepTags: KeepTags })
							.partial()
							.refine((o) => Object.keys(o).length > 0, "nothing to update"),
					),
				},
				responses: { 204: { description: "Updated" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			c.set("auditResourceId", id);
			one(
				await db
					.select({ id: registry.id })
					.from(registry)
					.where(and(eq(registry.id, id), eq(registry.organizationId, orgId))),
				"registry",
			);
			if (input.isDefault === true) await makeDefault(db, orgId, id);
			if (input.isDefault === false)
				await db
					.update(registry)
					.set({ isDefault: false })
					.where(eq(registry.id, id));
			if (input.keepTags !== undefined)
				await db
					.insert(registryRetention)
					.values({ registryId: id, keepTags: input.keepTags })
					.onConflictDoUpdate({
						target: registryRetention.registryId,
						set: { keepTags: input.keepTags },
					});
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"registry.delete",
			createRoute({
				method: "delete",
				path: "/registries/{id}",
				tags: ["registries"],
				security,
				summary: "Remove an external registry",
				description:
					"Images already pushed stay in the registry. Builds stop pushing to it once it is gone.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const rows = await c.var.deps.db
				.delete(registry)
				.where(
					and(
						eq(registry.id, id),
						eq(registry.organizationId, requireActor(c).organizationId),
						ne(registry.kind, "local"),
					),
				)
				.returning({ id: registry.id });
			if (!rows.length) throw notFound("registry");
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"registry.local",
			createRoute({
				method: "put",
				path: "/registries/local",
				tags: ["registries"],
				security,
				summary: "Turn the managed local registry on or off",
				description:
					"On: the worker runs Zot with a volume behind Caddy on `registry.<instance domain>`, with generated credentials, and it becomes the default. Off: the service stops and the images stay, unless `purge` is set, which deletes them with the credentials.",
				middleware: [
					requirePermission("admin", inOrganization),
					requireInstanceAdmin,
				],
				request: body(
					z.object({ enabled: z.boolean(), purge: z.boolean().default(false) }),
				),
				responses: {
					200: json(
						z.object({ enabled: z.boolean(), url: z.string().nullable() }),
						"State",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { enabled, purge } = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const [existing] = await db
				.select()
				.from(registry)
				.where(
					and(eq(registry.organizationId, orgId), eq(registry.kind, "local")),
				);
			await db.update(instanceSettings).set({ localRegistryEnabled: enabled });
			if (!enabled) {
				if (existing && purge)
					await db.delete(registry).where(eq(registry.id, existing.id));
				else if (existing)
					await db
						.update(registry)
						.set({ isDefault: false })
						.where(eq(registry.id, existing.id));
				return c.json({ enabled: false, url: existing?.url ?? null }, 200);
			}
			const domain = await instanceDomain(db);
			if (!domain)
				throw new Failure(
					"bad_request",
					"the instance has no domain yet: finish setup first",
				);
			const id =
				existing?.id ??
				one(
					await db
						.insert(registry)
						.values({
							organizationId: orgId,
							kind: "local",
							url: `registry.${domain}`,
							username: "logistack",
							passwordEncrypted: await encrypt(masterKey, randomPassword()),
						})
						.returning({ id: registry.id }),
				).id;
			if (!existing)
				await db
					.insert(registryRetention)
					.values({ registryId: id, keepTags: DEFAULT_KEEP_TAGS });
			await makeDefault(db, orgId, id);
			c.set("auditResourceId", id);
			return c.json(
				{ enabled: true, url: existing?.url ?? `registry.${domain}` },
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/registries/{id}/credentials",
			tags: ["registries"],
			security,
			summary: "Reveal a registry's credentials (for `docker login`)",
			middleware: [requirePermission("read:secrets", inOrganization)],
			request: { params: IdParam },
			responses: {
				200: json(
					z.object({
						username: z.string().nullable(),
						password: z.string().nullable(),
					}),
					"Credentials",
				),
				...errors,
			},
		}),
		async (c) => {
			const r = one(
				await c.var.deps.db
					.select()
					.from(registry)
					.where(
						and(
							eq(registry.id, c.req.valid("param").id),
							eq(registry.organizationId, requireActor(c).organizationId),
						),
					),
				"registry",
			);
			return c.json(
				{
					username: r.username,
					password: r.passwordEncrypted
						? await decrypt(c.var.deps.masterKey, r.passwordEncrypted)
						: null,
				},
				200,
			);
		},
	);
