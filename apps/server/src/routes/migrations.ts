/**
 * The migration wizard's API (MIG-6): start a migration from the Dokploy this server runs next
 * to, import it, cut services over one at a time, roll back, and hand 80/443 to Caddy. Admin
 * only. Views never carry a value from the plan: names, statuses and notes only.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
	MigrationItemStatus,
	MigrationSource,
	MigrationStatus,
} from "@logistack/contracts";
import {
	decommissionBlocker,
	decrypt,
	migrationItemTransition,
	sourceProfiles,
} from "@logistack/core";
import { migration, migrationItem } from "@logistack/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { log } from "../log.ts";
import { type Plan, planMigration, runImport } from "../migration/import.ts";
import { detectSource } from "../migration/sources.ts";
import { errors, IdParam, json, router, security } from "../openapi.ts";
import { runQueues } from "../run-queues.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const ItemService = z.object({
	name: z.string(),
	/** Its DNS name; Dokploy's `appName` for apps and databases. */
	slug: z.string(),
	kind: z.string(),
	engine: z.string().nullable(),
	domains: z.array(z.string()),
	/** Dokploy ran it; a stopped one is imported stopped. */
	running: z.boolean(),
	/** Whether the cutover stops Dokploy first (adopted volumes) or after (stateless). */
	stateful: z.boolean(),
});

const MigrationItemView = z
	.object({
		id: z.string(),
		kind: z.string(),
		name: z.string(),
		/** Organization-level resources have none. */
		project: z.string().nullable(),
		environment: z.string().nullable(),
		status: MigrationItemStatus,
		/** As planned: what carries over fully, in part, or not at all. */
		support: z.enum(["full", "partial", "unsupported"]),
		notes: z.array(z.string()),
		services: z.array(ItemService),
		/** Created resource ids: `id`, or service ids by slug. */
		targets: z.record(z.string(), z.string()),
		lastError: z.string().nullable(),
	})
	.openapi("MigrationItem");

const ProxyView = z
	.object({
		status: z.enum(["not_started", "switched", "fell_back"]),
		at: z.string().nullable(),
		error: z.string().nullable(),
		certificates: z
			.object({
				imported: z.array(z.string()),
				skipped: z.array(
					z.object({ hostname: z.string(), reason: z.string() }),
				),
				error: z.string().nullable(),
			})
			.nullable(),
		probes: z.array(
			z.object({ hostname: z.string(), ok: z.boolean(), detail: z.string() }),
		),
	})
	.openapi("MigrationProxy");

const DecommissionView = z
	.object({
		status: z.enum(["not_started", "done", "failed"]),
		at: z.string().nullable(),
		error: z.string().nullable(),
		/** On the server, root only: the dump, the tarball of /etc/dokploy and the inventory. */
		archivePath: z.string().nullable(),
		removed: z.array(z.string()),
		kept: z.array(z.object({ name: z.string(), reason: z.string() })),
	})
	.openapi("MigrationDecommission");

const MigrationView = z
	.object({
		id: z.string(),
		source: MigrationSource,
		status: MigrationStatus,
		createdAt: z.string(),
		items: z.array(MigrationItemView),
		proxy: ProxyView,
		decommission: DecommissionView,
		/** Why Dokploy cannot be removed yet; null once it can. */
		decommissionBlocker: z.string().nullable(),
	})
	.openapi("Migration");

const SourceView = z
	.object({
		/** What install.sh found next to this server; null on a plain install. */
		source: MigrationSource.nullable(),
		/** The latest migration of the organization, to resume the wizard. */
		migrationId: z.string().nullable(),
	})
	.openapi("MigrationSource");

const admin = requirePermission("admin", inOrganization);
const tags = ["migrations"];

type MigrationRow = typeof migration.$inferSelect;
type ItemRow = typeof migrationItem.$inferSelect;

async function itemView(
	c: Context<Env>,
	row: ItemRow,
): Promise<z.infer<typeof MigrationItemView>> {
	const plan = JSON.parse(
		await decrypt(c.var.deps.masterKey, row.planEncrypted),
	) as Plan;
	const base = {
		id: row.id,
		kind: row.kind,
		name: row.name,
		status: row.status,
		support: plan.item.status,
		notes: plan.item.notes,
		targets: row.targets,
		lastError: row.lastError,
	};
	if (plan.type === "org")
		return { ...base, project: null, environment: null, services: [] };
	return {
		...base,
		project: plan.item.project,
		environment: plan.item.environment,
		services: plan.item.services.map((s) => ({
			name: s.name,
			slug: s.slug,
			kind: s.spec.kind,
			engine: s.spec.kind === "database" ? s.spec.engine : null,
			domains: s.domains.map((d) => d.hostname),
			running: s.running,
			stateful: s.adoptedVolumes.length > 0,
		})),
	};
}

function proxyView(m: MigrationRow): z.infer<typeof ProxyView> {
	const s = m.proxyState;
	const r = s?.result;
	return {
		status: r?.status ?? "not_started",
		at: r?.at ?? null,
		error: r?.status === "fell_back" ? r.error : null,
		certificates: s?.certificates
			? {
					imported: s.certificates.imported,
					skipped: s.certificates.skipped,
					error: s.certificates.error ?? null,
				}
			: null,
		probes: r?.status === "switched" ? r.probes : [],
	};
}

async function ownMigration(c: Context<Env>, id: string) {
	const [m] = await c.var.deps.db
		.select()
		.from(migration)
		.where(
			and(
				eq(migration.id, id),
				eq(migration.organizationId, requireActor(c).organizationId),
			),
		);
	if (!m) throw notFound("migration");
	return m;
}

async function ownItem(c: Context<Env>, id: string) {
	const [row] = await c.var.deps.db
		.select({ item: migrationItem, organizationId: migration.organizationId })
		.from(migrationItem)
		.innerJoin(migration, eq(migration.id, migrationItem.migrationId))
		.where(eq(migrationItem.id, id));
	if (!row || row.organizationId !== requireActor(c).organizationId)
		throw notFound("migration item");
	return row.item;
}

async function view(c: Context<Env>, m: MigrationRow) {
	const items = await c.var.deps.db
		.select()
		.from(migrationItem)
		.where(eq(migrationItem.migrationId, m.id))
		.orderBy(asc(migrationItem.position));
	return {
		id: m.id,
		source: m.source,
		status: m.status,
		createdAt: m.createdAt.toISOString(),
		items: await Promise.all(items.map((r) => itemView(c, r))),
		proxy: proxyView(m),
		decommission: {
			status: m.decommission?.result?.status ?? ("not_started" as const),
			at: m.decommission?.result?.at ?? null,
			error:
				m.decommission?.result?.status === "failed"
					? m.decommission.result.error
					: null,
			archivePath: m.decommission?.archive?.path ?? null,
			removed: m.decommission?.removed ?? [],
			kept: m.decommission?.kept ?? [],
		},
		decommissionBlocker:
			m.status === "decommissioned"
				? null
				: (decommissionBlocker(
						items,
						m.proxyState?.result?.status === "switched",
						m.source,
					) ?? null),
	};
}

/** Statuses a cutover may start from; anything else is refused before it reaches the queue. */
const cuttable = (s: string) => s === "imported" || s === "rolled_back";

const itemAction = <P extends string>(path: P, summary: string) =>
	createRoute({
		method: "post",
		path,
		tags,
		security,
		summary,
		middleware: [admin],
		request: { params: IdParam },
		responses: { 202: json(MigrationItemView, "Accepted"), ...errors },
	});

export const migrations = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/migrations/source",
			tags,
			security,
			summary:
				"What this server can migrate from, and the migration in progress",
			middleware: [admin],
			responses: { 200: json(SourceView, "Source"), ...errors },
		}),
		async (c) => {
			const [latest] = await c.var.deps.db
				.select({ id: migration.id })
				.from(migration)
				.where(eq(migration.organizationId, requireActor(c).organizationId))
				.orderBy(desc(migration.createdAt))
				.limit(1);
			return c.json(
				{
					source: detectSource(c.var.deps.config)?.source ?? null,
					migrationId: latest?.id ?? null,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"migration.create",
			createRoute({
				method: "post",
				path: "/migrations",
				tags,
				security,
				summary: "Read the source platform (read-only) and plan a migration",
				description:
					"Reads the database and files of the platform install.sh found (Dokploy or Coolify) without changing them, and stores the inventory: one item per service and organization resource, each full, partial or unsupported with notes. Nothing is created in LogiStack yet.",
				middleware: [admin],
				responses: { 201: json(MigrationView, "Planned"), ...errors },
			}),
		),
		async (c) => {
			const found = detectSource(c.var.deps.config);
			if (!found)
				throw new Failure(
					"conflict",
					"no Dokploy or Coolify next to this server: install.sh did not find one",
				);
			const label = sourceProfiles[found.source].label;
			const inventory = await found.read().catch((e: unknown) => {
				throw new Failure(
					"unprocessable",
					`${label} could not be read: ${e instanceof Error ? e.message : String(e)}`,
				);
			});
			const id = await planMigration(
				c.var.deps,
				requireActor(c).organizationId,
				found.source,
				inventory,
			);
			c.set("auditResourceId", id);
			return c.json(await view(c, await ownMigration(c, id)), 201);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/migrations/{id}",
			tags,
			security,
			summary: "A migration with its items and the proxy switch",
			middleware: [admin],
			request: { params: IdParam },
			responses: { 200: json(MigrationView, "Migration"), ...errors },
		}),
		async (c) =>
			c.json(
				await view(c, await ownMigration(c, c.req.valid("param").id)),
				200,
			),
	)
	.openapi(
		mutation(
			"migration.import",
			createRoute({
				method: "post",
				path: "/migrations/{id}/import",
				tags,
				security,
				summary: "Import every planned or failed item, without deploying",
				description:
					"Runs in the background; follow `migration.item_changed` on `migration:<id>`. Running it again retries the failed items only.",
				middleware: [admin],
				request: { params: IdParam },
				responses: { 202: json(MigrationView, "Started"), ...errors },
			}),
		),
		async (c) => {
			const m = await ownMigration(c, c.req.valid("param").id);
			c.set("auditResourceId", m.id);
			void runImport(c.var.deps, m.id).catch((error) =>
				log("error", "migration import failed", {
					migrationId: m.id,
					error: String(error),
				}),
			);
			return c.json(
				{ ...(await view(c, m)), status: "importing" as const },
				202,
			);
		},
	)
	.openapi(
		mutation(
			"migration.switch_proxy",
			createRoute({
				method: "post",
				path: "/migrations/{id}/proxy-switch",
				tags,
				security,
				summary: "Hand ports 80/443 from Dokploy's Traefik to Caddy",
				description:
					"Imports Traefik's certificates for the cut-over domains, stops Traefik, turns ingress on and probes every domain. Traefik starts again if Caddy does not come up.",
				middleware: [admin],
				request: { params: IdParam },
				responses: { 202: json(MigrationView, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const m = await ownMigration(c, c.req.valid("param").id);
			c.set("auditResourceId", m.id);
			await runQueues(c.var.deps.config.REDIS_URL).migration.add(
				"switch_proxy",
				{ migrationId: m.id, action: "switch_proxy" },
				{ jobId: `proxy-${m.id}`, removeOnComplete: true, removeOnFail: true },
			);
			return c.json(await view(c, m), 202);
		},
	)
	.openapi(
		mutation(
			"migration.decommission",
			createRoute({
				method: "post",
				path: "/migrations/{id}/decommission",
				tags,
				security,
				summary: "Archive the source platform, then remove it",
				description:
					"Dumps the source's database and archives its configuration directory (/etc/dokploy or /data/coolify) and the inventory on the server, then removes the source's own services or containers, its proxy and the sources already moved. Volumes and items left on the source stay. Refused until every item is on LogiStack or left on the source and traffic is switched.",
				middleware: [admin],
				request: { params: IdParam },
				responses: { 202: json(MigrationView, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const m = await ownMigration(c, c.req.valid("param").id);
			const v = await view(c, m);
			if (m.status === "decommissioned")
				throw new Failure(
					"conflict",
					`${sourceProfiles[v.source].label} is already removed`,
				);
			if (v.decommissionBlocker)
				throw new Failure(
					"conflict",
					`cannot remove ${sourceProfiles[v.source].label} yet: ${v.decommissionBlocker}`,
				);
			c.set("auditResourceId", m.id);
			await runQueues(c.var.deps.config.REDIS_URL).migration.add(
				"decommission",
				{ migrationId: m.id, action: "decommission" },
				{
					jobId: `decommission-${m.id}`,
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
			return c.json(v, 202);
		},
	)
	.openapi(
		mutation(
			"migration_item.cutover",
			itemAction(
				"/migration-items/{id}/cutover",
				"Move one item from the source platform to LogiStack",
			),
		),
		async (c) => {
			const item = await ownItem(c, c.req.valid("param").id);
			if (!cuttable(item.status))
				throw new Failure(
					"conflict",
					`a ${item.status} item cannot be cut over`,
				);
			c.set("auditResourceId", item.id);
			await runQueues(c.var.deps.config.REDIS_URL).migration.add(
				"cutover",
				{ itemId: item.id, action: "cutover" },
				// One job per item at a time: a second click while it runs is a no-op.
				{
					jobId: `item-${item.id}`,
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
			return c.json(await itemView(c, item), 202);
		},
	)
	.openapi(
		mutation(
			"migration_item.rollback",
			itemAction(
				"/migration-items/{id}/rollback",
				"Give one item back to the source platform",
			),
		),
		async (c) => {
			const item = await ownItem(c, c.req.valid("param").id);
			if (item.status !== "cut_over" && item.status !== "imported")
				throw new Failure(
					"conflict",
					`a ${item.status} item cannot be rolled back`,
				);
			c.set("auditResourceId", item.id);
			await runQueues(c.var.deps.config.REDIS_URL).migration.add(
				"rollback",
				{ itemId: item.id, action: "rollback" },
				{
					jobId: `item-${item.id}`,
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
			return c.json(await itemView(c, item), 202);
		},
	)
	.openapi(
		mutation(
			"migration_item.skip",
			itemAction(
				"/migration-items/{id}/skip",
				"Leave one item on the source platform",
			),
		),
		async (c) => c.json(await skip(c, "skip"), 202),
	)
	.openapi(
		mutation(
			"migration_item.unskip",
			itemAction("/migration-items/{id}/unskip", "Plan a skipped item again"),
		),
		async (c) => c.json(await skip(c, "unskip"), 202),
	);

async function skip(c: Context<Env>, type: "skip" | "unskip") {
	const item = await ownItem(c, c.req.param("id") ?? "");
	const next = migrationItemTransition(item.status, { type });
	if (!next.ok)
		throw new Failure("conflict", `a ${item.status} item cannot ${type}`);
	if (type === "unskip") {
		// An item the inventory found unsupported has nothing to import.
		const plan = JSON.parse(
			await decrypt(c.var.deps.masterKey, item.planEncrypted),
		) as Plan;
		if (plan.item.status === "unsupported")
			throw new Failure("conflict", "an unsupported item cannot be planned");
	}
	c.set("auditResourceId", item.id);
	const [updated] = await c.var.deps.db
		.update(migrationItem)
		.set({ status: next.state })
		.where(eq(migrationItem.id, item.id))
		.returning();
	return itemView(c, updated ?? item);
}
