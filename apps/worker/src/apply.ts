import {
	type CompileServiceInput,
	compileService,
	serviceFiles,
} from "@logistack/core";
import { node, service } from "@logistack/db";
import {
	DockerError,
	DockerVersionConflictError,
	managedLabels,
	type RegistryAuth,
	type Service,
	type ServiceSpec,
	type Task,
} from "@logistack/docker";
import { eq } from "drizzle-orm";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import { envNetworkName, type ServiceContext } from "./load.ts";

const notFound = (e: unknown) => e instanceof DockerError && e.notFound;
const conflict = (e: unknown) => e instanceof DockerError && e.conflict;

/** Inspect, create when missing, and re-inspect when a concurrent create won the race. */
async function ensure<T>(
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

/** Stateful services stay on one node; an unpinned one is pinned to this worker's node and recorded. */
async function resolvePin(
	ctx: Ctx,
	sc: ServiceContext,
): Promise<string | undefined> {
	const stateful =
		sc.service.spec.kind === "database" ||
		sc.service.spec.kind === "storage" ||
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

/** Compiles the desired spec, creating the networks, configs and secrets it references. */
export async function desiredSpec(
	ctx: Ctx,
	sc: ServiceContext,
	deployment: { id: string; imageRef: string | null },
): Promise<ServiceSpec> {
	const envNet = await ensureEnvNetwork(
		ctx,
		sc.organizationId,
		sc.service.environmentId,
	);
	const ingress = await ctx.docker.networks.inspect(ctx.cfg.LS_INGRESS_NETWORK);
	const storage =
		sc.service.spec.kind === "storage"
			? await ctx.docker.networks.inspect(ctx.cfg.LS_STORAGE_NETWORK)
			: undefined;
	// Optional: without ls-db (dev machines, test harnesses) the database deploys, the explorer just can't reach it.
	const db =
		sc.service.spec.kind === "database"
			? await ctx.docker.networks.inspect(ctx.cfg.LS_DB_NETWORK).catch((e) => {
					if (notFound(e)) return undefined;
					throw e;
				})
			: undefined;
	const input: CompileServiceInput = {
		service: {
			id: sc.service.id,
			organizationId: sc.organizationId,
			environmentId: sc.service.environmentId,
			slug: sc.service.slug,
			desiredState: sc.service.desiredState,
			spec: sc.service.spec,
		},
		deploymentId: deployment.id,
		...(deployment.imageRef ? { image: deployment.imageRef } : {}),
		env: Object.fromEntries(
			Object.entries(sc.env).map(([k, v]) => [k, v.value]),
		),
		mounts: sc.mounts,
		domains: sc.domains,
		networks: {
			environment: envNet,
			ingress: ingress.Id,
			...(storage ? { storage: storage.Id } : {}),
			...(db ? { db: db.Id } : {}),
		},
		fileIds: {},
		scope: scope(ctx),
	};
	const pin = await resolvePin(ctx, sc);
	if (pin) input.pinNodeId = pin;
	input.fileIds = await ensureFiles(ctx, input);
	return compileService(input);
}

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
	| { ok: true }
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
