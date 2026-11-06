/**
 * Imports a planned migration into LogiStack through the API's own routes, as the system actor
 * `migrate-<source>`: the same validation, permission checks and audit as a person gets. Nothing is
 * deployed; the cutover (MIG-3b) does that. It runs in the api process because the routes live
 * here.
 *
 * Every step is idempotent, so an import interrupted anywhere runs again from the start of the
 * item it was on: a resource that exists (by `importedFrom`, name or URL) is reused, not created
 * twice, and each service's settings are written as full sets.
 */
import type {
	EnvironmentKind,
	MigrationItemStatus,
	MigrationSource,
} from "@logistack/contracts";
import { environmentKinds } from "@logistack/contracts";
import {
	decrypt,
	encrypt,
	importable,
	type MigrationItemEvent,
	migrationItemTransition,
	sourceProfiles,
} from "@logistack/core";
import {
	environment,
	gitProvider,
	migration,
	migrationBridge,
	migrationItem,
	project,
	service,
} from "@logistack/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type Actor, systemActor } from "../actor.ts";
import { createApp } from "../app.ts";
import type { Deps } from "../env.ts";
import { envelope } from "../events.ts";
import { log } from "../log.ts";
import { slugify } from "../openapi.ts";
import type {
	Inventory,
	InventoryItem,
	OrgItem,
	ServiceDraft,
} from "./types.ts";

/** The system actor an import acts as, and the folder its projects land in. */
export const actorId = (source: MigrationSource) => `migrate-${source}`;
export const folderName = (source: MigrationSource) =>
	`Imported from ${sourceProfiles[source].label}`;

/** What a `migration_item` row carries, encrypted: the inventory item as planned. */
export type Plan =
	| { type: "org"; item: OrgItem }
	| { type: "service"; item: InventoryItem };

/**
 * Stores an inventory as a migration: organization resources first (services reference them),
 * then the services in inventory order. An unsupported item starts `skipped`.
 */
export async function planMigration(
	deps: Deps,
	organizationId: string,
	source: MigrationSource,
	inventory: Inventory,
): Promise<string> {
	const plans: Plan[] = [
		...inventory.org.map((item) => ({ type: "org" as const, item })),
		...inventory.items.map((item) => ({ type: "service" as const, item })),
	];
	return deps.db.transaction(async (tx) => {
		const [row] = await tx
			.insert(migration)
			.values({ organizationId, source })
			.returning({ id: migration.id });
		if (!row) throw new Error("migration not created");
		if (plans.length)
			await tx.insert(migrationItem).values(
				await Promise.all(
					plans.map(async (plan, position) => ({
						migrationId: row.id,
						kind: plan.item.kind,
						sourceId: plan.item.sourceId,
						name: plan.item.name,
						position,
						status: (plan.item.status === "unsupported"
							? "skipped"
							: "planned") as MigrationItemStatus,
						planEncrypted: await encrypt(deps.masterKey, JSON.stringify(plan)),
					})),
				),
			);
		return row.id;
	});
}

export type Call = <T = { id: string }>(
	method: string,
	path: string,
	body?: unknown,
) => Promise<T>;

/** An api client acting as the system actor of the migration's organization. */
async function client(
	deps: Deps,
	organizationId: string,
	source: MigrationSource,
): Promise<Call> {
	const actor = await systemActor(deps.db, organizationId, actorId(source));
	if (!actor) throw new Error("the organization has no owner");
	return callAs(deps, actor);
}

/** The api's own routes, in process, as `actor`: their validation, permission checks and audit. */
export function callAs(deps: Deps, actor: Actor): Call {
	const app = createApp(deps, { actor });
	return async (method, path, body) => {
		const res = await app.request(`/api${path}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json = (await res.json().catch(() => null)) as {
			error?: { message?: string; details?: unknown };
		} | null;
		if (!res.ok) {
			const e = json?.error;
			throw new Error(
				`${method} ${path}: ${e?.message ?? res.status}${e?.details ? ` ${JSON.stringify(e.details)}` : ""}`,
			);
		}
		return json as never;
	};
}

/** Ids the import created so far, by item kind and source id. */
type Created = Map<string, Record<string, string>>;
const key = (kind: string, sourceId: string) => `${kind}\u0000${sourceId}`;

async function importOrg(
	deps: Deps,
	organizationId: string,
	call: Call,
	item: OrgItem,
): Promise<Record<string, string>> {
	const draft = item.draft;
	if (!draft) throw new Error("nothing to import");
	const reuse = async (
		list: string,
		match: (r: Record<string, unknown>) => boolean,
	) =>
		(await call<Record<string, unknown>[]>("GET", list)).find(match)?.id as
			| string
			| undefined;
	switch (draft.kind) {
		case "registry": {
			const id =
				(
					await call<{ registries: { id: string; url: string }[] }>(
						"GET",
						"/registries",
					)
				).registries.find((r) => r.url === draft.input.url)?.id ??
				(await call("POST", "/registries", draft.input)).id;
			return { id };
		}
		case "s3Destination": {
			const id =
				(await reuse("/s3-destinations", (r) => r.name === draft.input.name)) ??
				(await call("POST", "/s3-destinations", draft.input)).id;
			return { id };
		}
		case "sshKey": {
			const id =
				(await reuse("/ssh-keys", (r) => r.name === draft.input.name)) ??
				(await call("POST", "/ssh-keys", draft.input)).id;
			return { id };
		}
		case "gitProvider": {
			// The list route asks each provider's API for its state; the row is all we need.
			const [found] = await deps.db
				.select({ id: gitProvider.id })
				.from(gitProvider)
				.where(
					and(
						eq(gitProvider.organizationId, organizationId),
						eq(gitProvider.kind, "github"),
						eq(gitProvider.name, draft.input.name),
					),
				);
			const id =
				found?.id ??
				(
					await call("POST", "/git-providers", {
						name: draft.input.name,
						provider: { kind: "github", ...draft.input.config },
					})
				).id;
			return { id };
		}
		case "notificationChannel": {
			const id =
				(await reuse(
					"/notification-channels",
					(r) => r.name === draft.input.name && r.kind === draft.input.kind,
				)) ?? (await call("POST", "/notification-channels", draft.input)).id;
			const rules = await call<{ channelId: string }[]>(
				"GET",
				"/notification-rules",
			);
			if (draft.events.length && !rules.some((r) => r.channelId === id))
				await call("POST", "/notification-rules", {
					events: draft.events,
					scope: {},
					channelId: id,
				});
			return { id };
		}
	}
}

/** Kinds LogiStack names its environments by; anything else is `custom`. */
const kindOf = (name: string): EnvironmentKind =>
	(environmentKinds as readonly string[]).includes(name.toLowerCase()) &&
	name.toLowerCase() !== "custom"
		? (name.toLowerCase() as EnvironmentKind)
		: "custom";

async function environmentFor(
	call: Call,
	folderId: string,
	item: InventoryItem,
): Promise<string> {
	const projects = await call<{ id: string; slug: string }[]>(
		"GET",
		`/projects?folderId=${folderId}`,
	);
	const prj =
		projects.find((p) => p.slug === slugify(item.project)) ??
		(await call<{ id: string }>("POST", "/projects", {
			name: item.project,
			folderId,
		}));
	const envs = await call<{ id: string; slug: string }[]>(
		"GET",
		`/projects/${prj.id}/environments`,
	);
	return (
		envs.find((e) => e.slug === slugify(item.environment))?.id ??
		(
			await call("POST", `/projects/${prj.id}/environments`, {
				name: item.environment,
				kind: kindOf(item.environment),
			})
		).id
	);
}

async function importService(
	deps: Deps,
	call: Call,
	organizationId: string,
	environmentId: string,
	draft: ServiceDraft,
	created: Created,
): Promise<string> {
	const target = (kind: OrgItem["kind"], sourceId: string) =>
		created.get(key(kind, sourceId))?.id;
	const spec = structuredClone(draft.spec);
	if (
		spec.kind === "application" &&
		spec.source.type === "git" &&
		draft.gitProvider
	) {
		// `dokployId` on Dokploy plans stored before COOL-1.
		const id = target(
			"gitProvider",
			draft.gitProvider.sourceId ??
				(draft.gitProvider as { dokployId?: string }).dokployId ??
				"",
		);
		if (id) spec.source.gitProviderId = id;
	}
	const [existing] = await deps.db
		.select({ id: service.id })
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(
			and(
				eq(project.organizationId, organizationId),
				eq(service.importedFrom, draft.importedFrom),
			),
		);
	const id =
		existing?.id ??
		(
			await call("POST", `/environments/${environmentId}/services`, {
				name: draft.name,
				slug: draft.slug,
				spec,
				importedFrom: draft.importedFrom,
				...(draft.mounts.length && { mounts: draft.mounts }),
				...(draft.adoptedVolumes.length && {
					adoptedVolumes: draft.adoptedVolumes,
				}),
			})
		).id;

	// The full service-scope set: the source's values win, and a key the API minted that the source
	// has no value for keeps its stored one.
	const current = await call<{ key: string; scope: string }[]>(
		"GET",
		`/env-vars?scope=service&scopeId=${id}`,
	);
	await call("PUT", `/services/${id}/env-vars`, {
		variables: [
			...draft.env.map((e) => ({ ...e, isBuildTime: false })),
			...current
				.filter((c) => !draft.env.some((e) => e.key === c.key))
				.map((c) => ({ key: c.key, isSecret: true, isBuildTime: false })),
		],
	});

	const domains = await call<{ hostname: string; pathPrefix: string | null }[]>(
		"GET",
		`/services/${id}/domains`,
	);
	for (const d of draft.domains)
		if (
			!domains.some(
				(x) =>
					x.hostname === d.hostname &&
					(x.pathPrefix ?? null) === (d.pathPrefix ?? null),
			)
		)
			await call("POST", `/services/${id}/domains`, d);

	if (draft.basicAuth.length)
		await call("PUT", `/services/${id}/basic-auth`, {
			users: draft.basicAuth,
		});

	if (draft.backups.length) {
		const { policies } = await call<{
			policies: { s3DestinationId: string; cron: string; target: string }[];
		}>("GET", `/services/${id}/backups`);
		for (const b of draft.backups) {
			const s3DestinationId = target("s3Destination", b.destination);
			if (!s3DestinationId)
				throw new Error(`backup destination ${b.destination} was not imported`);
			if (
				policies.some(
					(p) =>
						p.target === "database" &&
						p.s3DestinationId === s3DestinationId &&
						p.cron === b.cron,
				)
			)
				continue;
			await call("POST", `/services/${id}/backup-policies`, {
				target: "database",
				s3DestinationId,
				cron: b.cron,
				retention: b.retention,
				enabled: b.enabled,
			});
		}
	}
	return id;
}

/** Moves an item and tells the wizard: `migration.item_changed` on `migration:<id>`. */
async function move(
	deps: Deps,
	organizationId: string,
	row: {
		id: string;
		migrationId: string;
		kind: string;
		sourceId: string;
		status: MigrationItemStatus;
	},
	event: MigrationItemEvent,
	patch: { targets?: Record<string, string>; lastError?: string | null } = {},
) {
	const next = migrationItemTransition(row.status, event);
	if (!next.ok)
		throw new Error(
			`migration item ${row.id}: ${next.error.event} from ${next.error.from}`,
		);
	await deps.db
		.update(migrationItem)
		.set({ status: next.state, ...patch })
		.where(eq(migrationItem.id, row.id));
	await deps.bus.publishEvent(
		envelope(
			"migration.item_changed",
			organizationId,
			{ type: "migration", id: row.migrationId },
			{
				itemId: row.id,
				kind: row.kind,
				sourceId: row.sourceId,
				status: next.state,
				error: patch.lastError ?? null,
			},
		),
	);
}

const running = new Set<string>();

/**
 * Imports every `planned` or `failed` item, in order. An item that fails is marked `failed` with
 * the cause and the import goes on; running it again retries only those.
 */
export async function runImport(deps: Deps, migrationId: string) {
	// shortcut: one api process runs imports; take a row lease once the api has replicas.
	if (running.has(migrationId)) return;
	running.add(migrationId);
	try {
		const [mig] = await deps.db
			.select()
			.from(migration)
			.where(eq(migration.id, migrationId));
		if (!mig) throw new Error(`migration ${migrationId} not found`);
		await deps.db
			.update(migration)
			.set({ status: "importing" })
			.where(eq(migration.id, migrationId));
		const call = await client(deps, mig.organizationId, mig.source);
		const rows = await deps.db
			.select()
			.from(migrationItem)
			.where(eq(migrationItem.migrationId, migrationId))
			.orderBy(asc(migrationItem.position));
		const created: Created = new Map(
			rows.map((r) => [key(r.kind, r.sourceId), r.targets]),
		);
		let folderId: string | undefined;
		for (const row of rows.filter((r) => importable(r.status))) {
			const plan = JSON.parse(
				await decrypt(deps.masterKey, row.planEncrypted),
			) as Plan;
			try {
				let targets: Record<string, string>;
				if (plan.type === "org")
					targets = await importOrg(deps, mig.organizationId, call, plan.item);
				else {
					folderId ??= await ensureFolder(call, folderName(mig.source));
					const environmentId = await environmentFor(call, folderId, plan.item);
					targets = { ...row.targets };
					for (const draft of plan.item.services) {
						const serviceId = await importService(
							deps,
							call,
							mig.organizationId,
							environmentId,
							draft,
							created,
						);
						targets[draft.slug] = serviceId;
						if (draft.bridge)
							await deps.db
								.insert(migrationBridge)
								.values({ serviceId, migrationId, ...draft.bridge })
								.onConflictDoUpdate({
									target: migrationBridge.serviceId,
									set: { migrationId, ...draft.bridge },
								});
						// Saved per service, so a crash keeps what is done.
						await deps.db
							.update(migrationItem)
							.set({ targets })
							.where(eq(migrationItem.id, row.id));
					}
				}
				created.set(key(row.kind, row.sourceId), targets);
				await move(
					deps,
					mig.organizationId,
					row,
					{ type: "imported" },
					{ targets, lastError: null },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("warn", "migration item failed", {
					migrationId,
					item: row.id,
					error: message,
				});
				await move(
					deps,
					mig.organizationId,
					row,
					{ type: "import_failed" },
					{ lastError: message },
				);
			}
		}
		await deps.db
			.update(migration)
			.set({ status: "imported" })
			.where(eq(migration.id, migrationId));
	} finally {
		running.delete(migrationId);
	}
}

async function ensureFolder(call: Call, name: string): Promise<string> {
	const tree = await call<{ id: string; name: string }[]>("GET", "/folders");
	return (
		tree.find((f) => f.name === name)?.id ??
		(await call("POST", "/folders", { name })).id
	);
}

/** On api start: finishes imports a restart interrupted. */
export async function resumeImports(deps: Deps) {
	const rows = await deps.db
		.select({ id: migration.id })
		.from(migration)
		.where(inArray(migration.status, ["importing"]));
	for (const { id } of rows)
		void runImport(deps, id).catch((error) =>
			log("error", "migration import failed", {
				migrationId: id,
				error: String(error),
			}),
		);
}
