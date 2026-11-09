import {
	bridgeRouterLabels,
	type CompileServiceInput,
	compileService,
	orgNetworkName,
	serviceFiles,
} from "@logistack/core";
import { migration, migrationBridge, node, service } from "@logistack/db";
import {
	authForImage,
	DockerError,
	DockerVersionConflictError,
	LABEL_MANAGED,
	managedLabels,
	type RegistryAuth,
	type Service,
	type ServiceSpec,
	type Task,
} from "@logistack/docker";
import { and, eq, ne } from "drizzle-orm";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import { databaseTls } from "./db-access.ts";
import {
	compileInput,
	type DeploymentRef,
	envNetworkName,
	type ServiceContext,
} from "./load.ts";
import { sourceSettings } from "./migration-source.ts";

export const notFound = (e: unknown) => e instanceof DockerError && e.notFound;
const conflict = (e: unknown) => e instanceof DockerError && e.conflict;

/** Inspect, create when missing, and re-inspect when a concurrent create won the race. */
export async function ensure<T>(
	inspect: () => Promise<T | undefined>,
	create: () => Promise<unknown>,
): Promise<T> {
	const found = await inspect();
	if (found) return found;
	try {
		await create();
	} catch (e) {
		if (!conflict(e)) throw e;
	}
	const created = await inspect();
	if (!created) throw new Error("object vanished right after create");
	return created;
}

export async function ensureEnvNetwork(
	ctx: Ctx,
	organizationId: string,
	environmentId: string,
): Promise<string> {
	const name = envNetworkName(ctx, environmentId);
	const net = await ensure(
		() =>
			ctx.docker.networks.inspect(name).catch((e) => {
				if (notFound(e)) return undefined;
				throw e;
			}),
		() =>
			ctx.docker.networks.create({
				Name: name,
				Driver: "overlay",
				Attachable: true,
				Scope: "swarm",
				Labels: {
					...managedLabels({
						resource: environmentId,
						kind: "network",
						org: organizationId,
					}),
					...scope(ctx).labels,
				},
			}),
	);
	return net.Id;
}

/**
 * Installs from before the database explorer (ls-db) or game servers (ls-game) lack that network,
 * and the in-app updater only swaps images. On a stack install, create it as a stack network (so a
 * later `docker stack deploy` adopts it) and attach the api, then the worker itself; once attached
 * this is a no-op.
 */
export async function ensureStackNetwork(
	ctx: Ctx,
	name: string,
	/** No route out (the plugins overlay); the api and worker keep theirs through other networks. */
	opts: { internal?: boolean } = {},
): Promise<void> {
	const stack = ctx.cfg.LS_STACK_NAME;
	const names = [`${stack}_logistack-api`, `${stack}_logistack-worker`];
	if (!(await inspectService(ctx, names[0] as string))) return;
	const net = await ensure(
		() =>
			ctx.docker.networks.inspect(name).catch((e) => {
				if (notFound(e)) return undefined;
				throw e;
			}),
		() =>
			ctx.docker.networks.create({
				Name: name,
				Driver: "overlay",
				Attachable: true,
				Scope: "swarm",
				...(opts.internal ? { Internal: true } : {}),
				Labels: { "com.docker.stack.namespace": stack },
			}),
	);
	await attachServices(ctx, net.Id, name, names);
}

/**
 * The alias `docker stack deploy` gives a stack service on each of its networks (its name in the
 * stack file). With it, a redeploy that names the same network (install.sh keeps them) changes
 * nothing and restarts no task.
 */
const stackAlias = (ctx: Ctx, svcName: string) => {
	const prefix = `${ctx.cfg.LS_STACK_NAME}_`;
	return svcName.startsWith(prefix)
		? { Aliases: [svcName.slice(prefix.length)] }
		: {};
};

/** Adds the network to each named Swarm service that lacks it; a rolling update of each. */
export async function attachServices(
	ctx: Ctx,
	netId: string,
	name: string,
	names: string[],
) {
	for (const svcName of names) {
		const svc = await inspectService(ctx, svcName);
		const nets = svc?.Spec.TaskTemplate.Networks ?? [];
		if (!svc || nets.some((n) => n.Target === netId || n.Target === name))
			continue;
		log("info", "attaching service to a shared network", {
			service: svcName,
			network: name,
		});
		await upsertService(ctx, undefined, svc.Spec, (current) => ({
			...current.Spec,
			TaskTemplate: {
				...current.Spec.TaskTemplate,
				Networks: [
					...(current.Spec.TaskTemplate.Networks ?? []),
					{ Target: netId, ...stackAlias(ctx, svcName) },
				],
			},
		}));
	}
}

/**
 * An organization's own network of a kind, created on first use, with the control-plane services
 * that dial its members attached (a rolling update of each, once). Off a stack install (dev
 * machines, test harnesses) those services do not exist and `fallback` is used instead.
 */
async function ensureOrgNetwork(
	ctx: Ctx,
	kind: "db" | "ingress" | "storage" | "game",
	organizationId: string,
	services: string[],
	fallback?: string,
): Promise<string | undefined> {
	if (fallback && !(await inspectService(ctx, services[0] as string))) {
		const shared = await ctx.docker.networks.inspect(fallback).catch((e) => {
			if (notFound(e)) return undefined;
			throw e;
		});
		return shared?.Id;
	}
	const name = orgNetworkName(kind, organizationId, ctx.cfg.LS_NAME_PREFIX);
	const net = await ensure(
		() =>
			ctx.docker.networks.inspect(name).catch((e) => {
				if (notFound(e)) return undefined;
				throw e;
			}),
		() =>
			ctx.docker.networks.create({
				Name: name,
				Driver: "overlay",
				Attachable: true,
				Scope: "swarm",
				Labels: {
					...managedLabels({
						resource: organizationId,
						kind: "network",
						org: organizationId,
					}),
					...scope(ctx).labels,
				},
			}),
	);
	await attachServices(ctx, net.Id, name, services);
	return net.Id;
}

const apiService = (ctx: Ctx) => `${ctx.cfg.LS_STACK_NAME}_logistack-api`;
const workerService = (ctx: Ctx) => `${ctx.cfg.LS_STACK_NAME}_logistack-worker`;

/**
 * The organization's database network, with the api attached so the explorer reaches its
 * databases. Databases of other organizations are not on it.
 */
export async function ensureOrgDbNetwork(
	ctx: Ctx,
	organizationId: string,
): Promise<string> {
	return (await ensureOrgNetwork(ctx, "db", organizationId, [
		apiService(ctx),
	])) as string;
}

/** Its public services and the proxy, which reaches them by name. */
export const ensureOrgIngressNetwork = (ctx: Ctx, organizationId: string) =>
	ensureOrgNetwork(
		ctx,
		"ingress",
		organizationId,
		[ctx.cfg.LS_CADDY_SERVICE],
		ctx.cfg.LS_INGRESS_NETWORK,
	);

/** Its storage services, the api (object browser, keys) and the worker (backups to them). */
const ensureOrgStorageNetwork = (ctx: Ctx, organizationId: string) =>
	ensureOrgNetwork(
		ctx,
		"storage",
		organizationId,
		[apiService(ctx), workerService(ctx)],
		ctx.cfg.LS_STORAGE_NETWORK,
	);

/** Its game servers and the api, which dials their RCON and query ports. */
const ensureOrgGameNetwork = (ctx: Ctx, organizationId: string) =>
	ensureOrgNetwork(
		ctx,
		"game",
		organizationId,
		[apiService(ctx)],
		ctx.cfg.LS_GAME_NETWORK,
	);

/** Ids of the shared networks; they never change once created. */
const sharedIds = new Map<string, Promise<string | undefined>>();
const sharedId = (ctx: Ctx, name: string) => {
	let id = sharedIds.get(name);
	if (!id) {
		id = ctx.docker.networks
			.inspect(name)
			.then((n) => n.Id)
			.catch(() => undefined);
		sharedIds.set(name, id);
	}
	return id;
};

/**
 * Releases before per-organization networks put every tenant's public, storage and game services
 * on one shared network each. For a live service still on one: the targets to swap, shared (by id
 * or name) to its organization's own. Empty when there is nothing to move.
 */
export async function sharedNetworkMoves(
	ctx: Ctx,
	organizationId: string,
	targets: string[],
): Promise<Map<string, string>> {
	const moves = new Map<string, string>();
	const kinds = [
		[ctx.cfg.LS_INGRESS_NETWORK, ensureOrgIngressNetwork],
		[ctx.cfg.LS_STORAGE_NETWORK, ensureOrgStorageNetwork],
		[ctx.cfg.LS_GAME_NETWORK, ensureOrgGameNetwork],
	] as const;
	for (const [name, own] of kinds) {
		const id = await sharedId(ctx, name);
		if (!targets.some((t) => t === name || t === id)) continue;
		const to = await own(ctx, organizationId);
		if (!to || to === id) continue;
		moves.set(name, to);
		if (id) moves.set(id, to);
	}
	return moves;
}

/**
 * `docker stack deploy` resets the control-plane services to the stack file, which names none of
 * the organizations' networks: attach every existing one again (once per network, at boot).
 */
export async function reattachOrgNetworks(ctx: Ctx): Promise<void> {
	const nets = await ctx.docker.networks.list({
		label: [
			"logistack.managed=true",
			"logistack.kind=network",
			...Object.entries(scope(ctx).labels).map(([k, v]) => `${k}=${v}`),
		],
	});
	const prefix = `${ctx.cfg.LS_NAME_PREFIX}ls-`;
	for (const n of nets) {
		const kind = n.Name.startsWith(prefix)
			? n.Name.slice(prefix.length).split("-")[0]
			: undefined;
		const services =
			kind === "ingress"
				? [ctx.cfg.LS_CADDY_SERVICE]
				: kind === "storage"
					? [apiService(ctx), workerService(ctx)]
					: kind === "game" || kind === "db"
						? [apiService(ctx)]
						: [];
		if (services.length) await attachServices(ctx, n.Id, n.Name, services);
	}
}

async function ensureFiles(
	ctx: Ctx,
	input: CompileServiceInput,
): Promise<Record<string, string>> {
	const ids: Record<string, string> = {};
	for (const f of serviceFiles(input)) {
		// The engine's name filter matches substrings, so pick the exact name.
		const api = f.kind === "config" ? ctx.docker.configs : ctx.docker.secrets;
		const obj = await ensure(
			async () =>
				(await api.list({ name: [f.name] })).find(
					(o) => o.Spec.Name === f.name,
				),
			() => api.create({ Name: f.name, Labels: f.labels, Data: f.data }),
		);
		ids[f.name] = obj.ID;
	}
	return ids;
}

/**
 * Swarm creates a missing volume empty, so an adopted volume that is gone would silently look
 * like data loss: refuse to deploy instead. One of ours is never adopted.
 */
async function checkAdopted(ctx: Ctx, sc: ServiceContext): Promise<void> {
	for (const name of Object.values(sc.adoptedVolumes)) {
		// shortcut: checks this worker's node only; on a multi-node Swarm, ask the pinned node's agent.
		const v = (await ctx.docker.volumes.list({ name: [name] })).find(
			(v) => v.Name === name,
		);
		if (!v)
			throw new Error(
				`service ${sc.service.id}: adopted volume ${name} does not exist`,
			);
		if (v.Labels?.[LABEL_MANAGED])
			throw new Error(
				`service ${sc.service.id}: volume ${name} is managed by LogiStack and cannot be adopted`,
			);
	}
}

/** Stateful services stay on one node; an unpinned one is pinned to this worker's node and recorded. */
async function resolvePin(
	ctx: Ctx,
	sc: ServiceContext,
): Promise<string | undefined> {
	const stateful =
		sc.service.spec.kind === "database" ||
		sc.service.spec.kind === "storage" ||
		sc.service.spec.kind === "game" ||
		sc.mounts.some((m) => m.kind === "volume") ||
		(sc.service.spec.kind === "application" &&
			!!sc.service.spec.mounts?.length);
	if (!stateful) return undefined;
	if (sc.pinnedSwarmNodeId) return sc.pinnedSwarmNodeId;
	const swarmNodeId = (await ctx.docker.info()).Swarm.NodeID;
	const [row] = await ctx.db
		.select({ id: node.id })
		.from(node)
		.where(eq(node.swarmNodeId, swarmNodeId));
	if (row)
		await ctx.db
			.update(service)
			.set({ nodeId: row.id })
			.where(eq(service.id, sc.service.id));
	else
		log("warn", "stateful service pinned to a node with no node row", {
			serviceId: sc.service.id,
			swarmNodeId,
		});
	return swarmNodeId;
}

export async function inspectService(
	ctx: Ctx,
	name: string,
): Promise<Service | undefined> {
	try {
		return await ctx.docker.services.inspect(name);
	} catch (e) {
		if (notFound(e)) return undefined;
		throw e;
	}
}

/** The compiler input of a deployment, creating the networks, configs and secrets it references. */
export async function desiredInput(
	ctx: Ctx,
	sc: ServiceContext,
	deployment: DeploymentRef,
): Promise<CompileServiceInput> {
	const envNet = await ensureEnvNetwork(
		ctx,
		sc.organizationId,
		sc.service.environmentId,
	);
	const ingress = await ensureOrgIngressNetwork(ctx, sc.organizationId);
	if (!ingress)
		throw new Error(`network ${ctx.cfg.LS_INGRESS_NETWORK} not found`);
	const storage =
		sc.service.spec.kind === "storage"
			? await ensureOrgStorageNetwork(ctx, sc.organizationId)
			: undefined;
	if (sc.service.spec.kind === "storage" && !storage)
		throw new Error(`network ${ctx.cfg.LS_STORAGE_NETWORK} not found`);
	const db =
		sc.service.spec.kind === "database"
			? await ensureOrgDbNetwork(ctx, sc.organizationId)
			: undefined;
	const tls =
		sc.service.spec.kind === "database"
			? await databaseTls(ctx, sc.service.id)
			: undefined;
	// Optional too: without ls-game the server plays, only the panel's console and status can't reach it.
	const game =
		sc.service.spec.kind === "game"
			? await ensureOrgGameNetwork(ctx, sc.organizationId)
			: undefined;
	// Until the source platform is decommissioned, its proxy and its remaining services reach a
	// moved service by its old names on the source's network.
	const [moved] = await ctx.db
		.select({
			aliases: migrationBridge.aliases,
			routes: migrationBridge.routes,
			source: migration.source,
		})
		.from(migrationBridge)
		.innerJoin(migration, eq(migration.id, migrationBridge.migrationId))
		.where(
			and(
				eq(migrationBridge.serviceId, sc.service.id),
				ne(migration.status, "decommissioned"),
			),
		);
	const from = moved ? sourceSettings(ctx.cfg, moved.source) : undefined;
	const bridge = from
		? await ctx.docker.networks.inspect(from.network).catch((e) => {
				if (notFound(e)) return undefined;
				throw e;
			})
		: undefined;
	await checkAdopted(ctx, sc);
	const pin = await resolvePin(ctx, sc);
	const input = compileInput(sc, deployment, {
		networks: {
			environment: envNet,
			ingress,
			...(storage ? { storage } : {}),
			...(db ? { db } : {}),
			...(game ? { game } : {}),
			...(bridge ? { bridge: bridge.Id } : {}),
		},
		...(bridge && moved && from
			? {
					bridgeAliases: moved.aliases,
					...(moved.routes
						? {
								[from.router === "traefik-swarm"
									? "bridgeLabels"
									: "bridgeContainerLabels"]: bridgeRouterLabels(
									sc.service.id,
									from.network,
									sc.domains,
									from.router,
								),
							}
						: {}),
				}
			: {}),
		...(pin ? { pinNodeId: pin } : {}),
		...(tls ? { tls } : {}),
		scope: scope(ctx),
	});
	input.fileIds = await ensureFiles(ctx, input);
	return input;
}

export const desiredSpec = async (
	ctx: Ctx,
	sc: ServiceContext,
	deployment: DeploymentRef,
): Promise<ServiceSpec> =>
	compileService(await desiredInput(ctx, sc, deployment));

export type Applied = { created: boolean; before: Service | undefined };

/**
 * Creates or updates the Swarm service. A stale version re-inspects and retries the update;
 * it never falls back to create, which would race a concurrent writer into a duplicate.
 */
export async function upsertService(
	ctx: Ctx,
	registryAuth: RegistryAuth | undefined,
	spec: ServiceSpec,
	patch: (current: Service, desired: ServiceSpec) => ServiceSpec = (_c, d) => d,
): Promise<Applied> {
	registryAuth = authForImage(
		spec.TaskTemplate.ContainerSpec?.Image ?? "",
		registryAuth,
	);
	let before = await inspectService(ctx, spec.Name);
	if (!before) {
		try {
			await ctx.docker.services.create(spec, registryAuth);
			return { created: true, before: undefined };
		} catch (e) {
			if (!conflict(e)) throw e;
			before = await inspectService(ctx, spec.Name);
			if (!before) throw e;
		}
	}
	let current = before;
	for (let attempt = 1; ; attempt++) {
		try {
			await ctx.docker.services.update(
				current.ID,
				current.Version.Index,
				patch(current, spec),
				registryAuth ? { registryAuth } : {},
			);
			return { created: false, before };
		} catch (e) {
			if (!(e instanceof DockerVersionConflictError) || attempt >= 5) throw e;
			current = await ctx.docker.services.inspect(current.ID);
		}
	}
}

export type RolloutResult =
	| { ok: true; warning?: string }
	| { ok: false; error: string; rolledBack: boolean };

const runningTasks = async (ctx: Ctx, name: string): Promise<Task[]> =>
	(await ctx.docker.tasks.list({ service: [name] })).filter(
		(t) => t.DesiredState === "running",
	);

/**
 * Waits until Swarm reports the rollout converged. Updates are read from `UpdateStatus`
 * (rollback detection, docs/spikes/docker.md §2); a fresh create has no UpdateStatus, so it
 * waits for every replica of the new spec to be running (healthy, when it has a healthcheck).
 */
export async function waitForRollout(
	ctx: Ctx,
	name: string,
	applied: Applied,
	o: { timeoutMs: number; signal?: AbortSignal; deploymentId: string },
): Promise<RolloutResult> {
	const deadline = Date.now() + o.timeoutMs;
	const previousStart = applied.before?.UpdateStatus?.StartedAt;
	for (;;) {
		o.signal?.throwIfAborted();
		const svc = await inspectService(ctx, name);
		if (!svc)
			return { ok: false, error: "service disappeared", rolledBack: false };
		const status = svc.UpdateStatus;
		const ours = status && status.StartedAt !== previousStart;
		if (ours) {
			switch (status.State) {
				case "completed":
					return { ok: true };
				case "rollback_completed":
					return {
						ok: false,
						error: `rolled back: ${status.Message ?? "update failed"}`,
						rolledBack: true,
					};
				case "paused":
				case "rollback_paused":
					return {
						ok: false,
						error: `rollout ${status.State}: ${status.Message ?? ""}`.trim(),
						rolledBack: status.State === "rollback_paused",
					};
			}
		} else if (applied.created || !applied.before) {
			const want =
				svc.Spec.Mode && "Replicated" in svc.Spec.Mode
					? svc.Spec.Mode.Replicated.Replicas
					: 1;
			const tasks = (await runningTasks(ctx, name)).filter(
				(t) =>
					t.Spec.ContainerSpec.Labels?.["logistack.deployment"] ===
					o.deploymentId,
			);
			if (tasks.filter((t) => t.Status.State === "running").length >= want)
				return { ok: true };
			const failed = (await ctx.docker.tasks.list({ service: [name] })).filter(
				(t) => t.Status.State === "failed" || t.Status.State === "rejected",
			);
			if (failed.length >= 3)
				return {
					ok: false,
					error: `tasks keep failing: ${failed[0]?.Status.Err ?? failed[0]?.Status.Message}`,
					rolledBack: false,
				};
		}
		if (Date.now() > deadline)
			return {
				ok: false,
				error: "timed out waiting for the rollout",
				rolledBack: false,
			};
		await Bun.sleep(1_000);
	}
}
