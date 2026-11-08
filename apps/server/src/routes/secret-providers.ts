import { createRoute, z } from "@hono/zod-openapi";
import {
	SecretProviderKind,
	SecretProviderName,
	SecretProviderView,
} from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import { type Db, secret, secretProvider } from "@logistack/db";
import { secretProviders } from "@logistack/providers";
import {
	failureMessage,
	openSource,
	providerConfig,
	type SourceSpec,
} from "@logistack/worker/external-secrets";
import { and, asc, count, eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, notFound, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { contributedProvider, PluginProviderFields } from "../plugins.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const Config = z.record(z.string(), z.unknown());
type Row = typeof secretProvider.$inferSelect;

/** Config parsed for its kind; a plugin's provider is checked against the plugin's own form. */
async function parseInput(
	db: Db,
	organizationId: string,
	input: {
		kind: SecretProviderKind;
		config: Record<string, unknown>;
		pluginInstallId?: string;
		pluginProvider?: string;
	},
) {
	if (input.kind === "plugin") {
		const p = await contributedProvider(
			db,
			organizationId,
			"secretProviders",
			input,
			input.config,
		);
		return {
			config: p.config,
			url: `plugin:${p.install.pluginId}/${p.provider.name}`,
			columns: p.columns,
		};
	}
	const config = parseConfig(input.kind, input.config);
	return { config, url: config.url, columns: {} };
}

function parseConfig(
	kind: Exclude<SecretProviderKind, "plugin">,
	config: unknown,
) {
	const parsed = secretProviders[kind].configSchema.safeParse(config);
	if (!parsed.success)
		throw new Failure(
			"validation_failed",
			"config does not match the provider",
			parsed.error.issues,
		);
	return parsed.data as { url: string };
}

/** Signs in with `config`; a failure is a 400 that says why, never a value or credential. */
async function testConnection(
	db: Db,
	masterKey: CryptoKey,
	spec: SourceSpec,
	config: unknown,
) {
	try {
		await (await openSource({ db, masterKey }, spec, config)).test();
	} catch (e) {
		throw new Failure("bad_request", failureMessage(e));
	}
}

async function providerRow(db: Db, organizationId: string, id: string) {
	const [row] = await db
		.select()
		.from(secretProvider)
		.where(
			and(
				eq(secretProvider.id, id),
				eq(secretProvider.organizationId, organizationId),
			),
		);
	if (!row) throw notFound("secret provider");
	return row;
}

const usage = (db: Db, id: string) =>
	db.$count(secret, eq(secret.providerId, id));

const view = (r: Row, secrets: number) => ({
	id: r.id,
	kind: r.kind,
	pluginInstallId: r.pluginInstallId,
	pluginProvider: r.pluginProvider,
	name: r.name,
	url: r.url,
	secrets,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt,
});

async function uniqueName(db: Db, organizationId: string, name: string) {
	const taken = await db.$count(
		secretProvider,
		and(
			eq(secretProvider.organizationId, organizationId),
			eq(secretProvider.name, name),
		),
	);
	if (taken)
		throw new Failure(
			"conflict",
			`a secret provider named "${name}" already exists`,
		);
}

const View = SecretProviderView;
const Ok = json(z.object({ ok: z.literal(true) }), "Connected");
const tags = ["secret-providers"];
const admin = [requirePermission("admin", inOrganization)];

export const secretProviderRoutes = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/secret-providers",
			tags,
			security,
			summary: "External secret managers external secrets read from",
			description: "Credentials are never returned.",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(View), "Providers"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const [rows, used] = await Promise.all([
				db
					.select()
					.from(secretProvider)
					.where(eq(secretProvider.organizationId, organizationId))
					.orderBy(asc(secretProvider.name)),
				db
					.select({ id: secret.providerId, n: count() })
					.from(secret)
					.where(eq(secret.organizationId, organizationId))
					.groupBy(secret.providerId),
			]);
			const n = new Map(used.map((u) => [u.id, u.n]));
			return c.json(
				rows.map((r) => view(r, n.get(r.id) ?? 0)),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"secret_provider.test",
			createRoute({
				method: "post",
				path: "/secret-providers/test",
				tags,
				security,
				summary: "Test an unsaved provider config",
				description:
					"Signs in and checks the configured project or token is usable. Reads no secret.",
				middleware: admin,
				request: body(
					z.object({
						kind: SecretProviderKind,
						config: Config,
						...PluginProviderFields,
					}),
				),
				responses: { 200: Ok, ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const parsed = await parseInput(db, organizationId, input);
			await testConnection(
				db,
				masterKey,
				{ ...input, ...parsed.columns, organizationId },
				parsed.config,
			);
			return c.json({ ok: true as const }, 200);
		},
	)
	.openapi(
		mutation(
			"secret_provider.create",
			createRoute({
				method: "post",
				path: "/secret-providers",
				tags,
				security,
				summary: "Add a secret provider",
				description:
					"Tests the connection first and refuses a config that cannot sign in. The config is stored encrypted. `name` is what references use: `secret://<name>/<path>#<key>`.",
				middleware: admin,
				request: body(
					z.object({
						kind: SecretProviderKind,
						name: SecretProviderName,
						config: Config,
						...PluginProviderFields,
					}),
				),
				responses: { 201: json(View, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { kind, name } = input;
			const { db, masterKey } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const parsed = await parseInput(db, organizationId, input);
			await uniqueName(db, organizationId, name);
			await testConnection(
				db,
				masterKey,
				{ kind, organizationId, ...parsed.columns },
				parsed.config,
			);
			const row = one(
				await db
					.insert(secretProvider)
					.values({
						organizationId,
						kind,
						name,
						url: parsed.url,
						configEncrypted: await encrypt(
							masterKey,
							JSON.stringify(parsed.config),
						),
						...parsed.columns,
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			c.set("auditDiff", { kind, name, url: parsed.url });
			return c.json(view(row, 0), 201);
		},
	)
	.openapi(
		mutation(
			"secret_provider.update",
			createRoute({
				method: "patch",
				path: "/secret-providers/{id}",
				tags,
				security,
				summary: "Rename a provider or replace its whole config",
				description:
					"Renaming changes the `secret://<name>/` prefix every reference shows. A new config is tested before it is saved.",
				middleware: admin,
				request: {
					params: IdParam,
					...body(
						z.object({
							name: SecretProviderName.optional(),
							config: Config.optional(),
						}),
					),
				},
				responses: { 200: json(View, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const current = await providerRow(db, organizationId, id);
			if (input.name && input.name !== current.name)
				await uniqueName(db, organizationId, input.name);
			const parsed =
				input.config &&
				(await parseInput(db, organizationId, {
					kind: current.kind,
					config: input.config,
					pluginInstallId: current.pluginInstallId ?? undefined,
					pluginProvider: current.pluginProvider ?? undefined,
				}));
			if (parsed) await testConnection(db, masterKey, current, parsed.config);
			const row = one(
				await db
					.update(secretProvider)
					.set({
						...(input.name ? { name: input.name } : {}),
						...(parsed
							? {
									url: parsed.url,
									configEncrypted: await encrypt(
										masterKey,
										JSON.stringify(parsed.config),
									),
								}
							: {}),
					})
					.where(eq(secretProvider.id, id))
					.returning(),
			);
			c.set("auditResourceId", id);
			c.set("auditDiff", {
				...(input.name ? { name: input.name } : {}),
				...(parsed ? { url: parsed.url, config: "replaced" } : {}),
			});
			return c.json(view(row, await usage(db, id)), 200);
		},
	)
	.openapi(
		mutation(
			"secret_provider.test",
			createRoute({
				method: "post",
				path: "/secret-providers/{id}/test",
				tags,
				security,
				summary: "Test a saved provider",
				middleware: admin,
				request: { params: IdParam },
				responses: { 200: Ok, ...errors },
			}),
		),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const row = await providerRow(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			c.set("auditResourceId", row.id);
			await testConnection(
				db,
				masterKey,
				row,
				await providerConfig({ db, masterKey }, row),
			);
			return c.json({ ok: true as const }, 200);
		},
	)
	.openapi(
		mutation(
			"secret_provider.delete",
			createRoute({
				method: "delete",
				path: "/secret-providers/{id}",
				tags,
				security,
				summary: "Remove a provider",
				description:
					"Refused (409) while an external secret reads from it. Nothing in the provider is touched.",
				middleware: admin,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const row = await providerRow(db, requireActor(c).organizationId, id);
			const n = await usage(db, id);
			if (n)
				throw new Failure(
					"conflict",
					`${n} secret(s) read from ${row.name}; delete them or point them at another provider first`,
				);
			await db.delete(secretProvider).where(eq(secretProvider.id, id));
			c.set("auditResourceId", id);
			c.set("auditDiff", { name: row.name, kind: row.kind });
			return c.body(null, 204);
		},
	);
