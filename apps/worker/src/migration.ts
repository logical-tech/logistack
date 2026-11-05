/**
 * Cutover and rollback of one migration item: the source's containers stop, the imported LogiStack
 * services deploy, and if one is not healthy everything goes back as it was.
 *
 * The source is found only through the item's stored `SourceDescriptor`: Swarm services by exact
 * name or stack label, containers by the source's own labels. What was running is saved on the
 * item before anything stops, so a rollback after a crash still knows what to start.
 *
 * Order: a service with adopted volumes stops the source first, so two processes never write one
 * volume. A stateless one deploys first and stops the source after, so it is never down: both
 * answer on the source's network under the same name meanwhile (see the bridge in `apply.ts`).
 */

import type { MigrationSource } from "@logistack/contracts";
import {
	decrypt,
	dokployDescriptor,
	isTerminal,
	type MigrationItemEvent,
	migrationItemTransition,
	type SourceDescriptor,
	sourceProfiles,
} from "@logistack/core";
import {
	deployment,
	gitProvider,
	instanceSettings,
	type MigrationSourceState,
	migration,
	migrationItem,
	service,
} from "@logistack/db";
import { DockerError, type Service } from "@logistack/docker";
import { githubConfig, pointGitHubAppHook } from "@logistack/providers";
import { eq, inArray } from "drizzle-orm";
import { inspectService } from "./apply.ts";
import { log } from "./bus.ts";
import { ensureBridge, freeze } from "./coolify.ts";
import type { Ctx } from "./ctx.ts";
import { svcName } from "./load.ts";
import { enqueueDeploy } from "./queues.ts";

/** The part of the stored plan (`apps/server/src/migration/import.ts`) the cutover reads. */
type Plan =
	| { type: "org"; item: { kind: string } }
	| {
			type: "service";
			item: {
				kind: string;
				appName: string;
				/** Absent on Dokploy plans stored before COOL-1. */
				source?: SourceDescriptor;
				services: {
					slug: string;
					running: boolean;
					adoptedVolumes: unknown[];
					domains: unknown[];
				}[];
			};
	  };

type Item = typeof migrationItem.$inferSelect & {
	organizationId: string;
	source: MigrationSource;
};

const STOP_WAIT_MS = 120_000;

async function load(ctx: Ctx, itemId: string) {
	const [row] = await ctx.db
		.select({
			item: migrationItem,
			organizationId: migration.organizationId,
			source: migration.source,
		})
		.from(migrationItem)
		.innerJoin(migration, eq(migration.id, migrationItem.migrationId))
		.where(eq(migrationItem.id, itemId));
	if (!row) throw new Error(`migration item ${itemId} not found`);
	const item: Item = {
		...row.item,
		organizationId: row.organizationId,
		source: row.source,
	};
	const plan = JSON.parse(
		await decrypt(ctx.masterKey, item.planEncrypted),
	) as Plan;
	return { item, plan };
}

/** Moves an item and tells the wizard: `migration.item_changed` on `migration:<id>`. */
async function move(
	ctx: Ctx,
	item: Item,
	event: MigrationItemEvent,
	lastError: string | null,
) {
	const next = migrationItemTransition(item.status, event);
	if (!next.ok)
		throw new Error(
			`migration item ${item.id}: cannot ${next.error.event} from ${next.error.from}`,
		);
	await ctx.db
		.update(migrationItem)
		.set({ status: next.state, lastError })
		.where(eq(migrationItem.id, item.id));
	await ctx.bus.publish(
		"migration.item_changed",
		item.organizationId,
		{ type: "migration", id: item.migrationId },
		{
			itemId: item.id,
			kind: item.kind,
			sourceId: item.sourceId,
			status: next.state,
			error: lastError,
		},
	);
}

/**
 * Points an imported GitHub App's webhook at this instance. Until then GitHub still delivers to
 * Dokploy: run it once LogiStack answers on its public URL (after the proxy switch, MIG-4).
 */
async function moveGitHubHook(ctx: Ctx, providerId: string) {
	const [gp] = await ctx.db
		.select()
		.from(gitProvider)
		.where(eq(gitProvider.id, providerId));
	if (gp?.kind !== "github")
		throw new Error("the GitHub provider was not imported");
	const [settings] = await ctx.db
		.select({ publicUrl: instanceSettings.publicUrl })
		.from(instanceSettings);
	if (!settings?.publicUrl) throw new Error("the instance has no public URL");
	const config = githubConfig.parse(
		JSON.parse(await decrypt(ctx.masterKey, gp.configEncrypted)),
	);
	await pointGitHubAppHook(
		config,
		`${settings.publicUrl.replace(/\/+$/, "")}/api/webhooks/git/${providerId}`,
	);
}

/** The item's descriptor; Dokploy plans from before descriptors get theirs from `appName`. */
const descriptorOf = (plan: Extract<Plan, { type: "service" }>) =>
	plan.item.source ??
	dokployDescriptor(
		plan.item.kind,
		plan.item.appName,
		plan.item.services.some((s) => s.domains?.length),
	);

/** The source's Swarm services, by exact name or stack label. */
async function sourceServices(ctx: Ctx, d: SourceDescriptor) {
	const named = d.services?.length
		? (await ctx.docker.services.list({ name: d.services })).filter((s) =>
				// The name filter matches prefixes; only the exact names are the source's.
				d.services?.includes(s.Spec.Name),
			)
		: [];
	const stacked = d.stack
		? await ctx.docker.services.list({
				label: [`com.docker.stack.namespace=${d.stack}`],
			})
		: [];
	return [
		...named,
		...stacked.filter((s) => !named.some((n) => n.ID === s.ID)),
	];
}

async function sourceContainers(ctx: Ctx, d: SourceDescriptor) {
	return d.containerLabels?.length
		? ctx.docker.containers.list({ label: d.containerLabels }, true)
		: [];
}

/** Replicas of a replicated service; undefined for global or job modes, which cannot be scaled. */
const replicasOf = (s: Service): number | undefined => {
	const mode = s.Spec.Mode;
	if (!mode) return 1;
	return "Replicated" in mode ? mode.Replicated.Replicas : undefined;
};

/** Sets a Swarm service's replicas, retrying on a stale version. */
export async function scale(ctx: Ctx, name: string, replicas: number) {
	for (let attempt = 0; ; attempt++) {
		const svc = await inspectService(ctx, name);
		if (!svc) return;
		const current = replicasOf(svc);
		if (current === undefined)
			throw new Error(
				`${name} is not a replicated service and cannot be scaled`,
			);
		if (current === replicas) return;
		try {
			await ctx.docker.services.update(svc.ID, svc.Version.Index, {
				...svc.Spec,
				Mode: { Replicated: { Replicas: replicas } },
			});
			return;
		} catch (e) {
			if (attempt < 3 && e instanceof DockerError && e.status === 500) continue;
			throw e;
		}
	}
}

/** Until no task of the service runs, or `STOP_WAIT_MS` passes. */
export async function waitStopped(ctx: Ctx, name: string) {
	const deadline = Date.now() + STOP_WAIT_MS;
	while (Date.now() < deadline) {
		const tasks = await ctx.docker.tasks.list({ service: [name] });
		if (
			!tasks.some((t) =>
				[
					"running",
					"starting",
					"preparing",
					"assigned",
					"accepted",
					"pending",
				].includes(t.Status?.State ?? ""),
			)
		)
			return;
		await Bun.sleep(500);
	}
	throw new Error(`${name} did not stop within ${STOP_WAIT_MS / 1000} s`);
}

/** 304: the container already is in the state asked for. */
export const unlessAlready = (e: unknown) => {
	if (!(e instanceof DockerError && e.status === 304)) throw e;
};

/** Saves what runs on the source, once: a retried cutover finds it already stopped. */
async function saveSource(
	ctx: Ctx,
	item: Item,
	plan: Extract<Plan, { type: "service" }>,
): Promise<MigrationSourceState> {
	if (item.sourceState) return item.sourceState;
	const d = descriptorOf(plan);
	const state: MigrationSourceState = {
		services: Object.fromEntries(
			(await sourceServices(ctx, d)).map((s) => {
				const replicas = replicasOf(s);
				if (replicas === undefined)
					throw new Error(`${s.Spec.Name} is not a replicated service`);
				return [s.Spec.Name, replicas];
			}),
		),
		containers: (await sourceContainers(ctx, d))
			.filter((c) => c.State === "running")
			.map((c) => c.Id),
	};
	await ctx.db
		.update(migrationItem)
		.set({ sourceState: state })
		.where(eq(migrationItem.id, item.id));
	return state;
}

async function stopSource(ctx: Ctx, state: MigrationSourceState) {
	for (const name of Object.keys(state.services)) {
		await scale(ctx, name, 0);
		await waitStopped(ctx, name);
	}
	for (const id of state.containers)
		await ctx.docker.containers.stop(id).catch(unlessAlready);
}

async function restoreSource(ctx: Ctx, state: MigrationSourceState) {
	for (const [name, replicas] of Object.entries(state.services))
		await scale(ctx, name, replicas);
	for (const id of state.containers)
		await ctx.docker.containers.start(id).catch(unlessAlready);
}

/** Queues a deployment and waits for it; anything but healthy throws with its error. */
async function deploy(ctx: Ctx, serviceId: string) {
	await ctx.db
		.update(service)
		.set({ desiredState: "running" })
		.where(eq(service.id, serviceId));
	const [d] = await ctx.db
		.insert(deployment)
		.values({ serviceId, trigger: "api" })
		.returning({ id: deployment.id });
	if (!d) throw new Error("deployment not created");
	await enqueueDeploy(ctx.queues, serviceId);
	const deadline = Date.now() + ctx.cfg.LS_DEPLOY_TIMEOUT_MS + 60_000;
	for (;;) {
		const [row] = await ctx.db
			.select()
			.from(deployment)
			.where(eq(deployment.id, d.id));
		if (row && isTerminal(row.status)) {
			if (row.status === "healthy") return;
			throw new Error(
				`deployment ${d.id} ${row.status}${row.error ? `: ${row.error}` : ""}`,
			);
		}
		if (Date.now() > deadline)
			throw new Error(`deployment ${d.id} did not finish`);
		await Bun.sleep(1_000);
	}
}

/** Stops the imported services: desired state first, so the reconciler does not bring them back. */
async function stopTargets(ctx: Ctx, ids: string[]) {
	if (!ids.length) return;
	await ctx.db
		.update(service)
		.set({ desiredState: "stopped" })
		.where(inArray(service.id, ids));
	for (const id of ids) {
		const name = svcName(ctx, id);
		await scale(ctx, name, 0);
		await waitStopped(ctx, name);
	}
}

const stateful = (plan: Extract<Plan, { type: "service" }>) =>
	plan.item.services.some((s) => s.adoptedVolumes.length > 0);

const targetsOf = (item: Item, plan: Extract<Plan, { type: "service" }>) =>
	plan.item.services.map((s) => {
		const id = item.targets[s.slug];
		if (!id) throw new Error(`${s.slug} was not imported`);
		return { id, running: s.running };
	});

async function rollBackItem(
	ctx: Ctx,
	item: Item,
	plan: Extract<Plan, { type: "service" }>,
) {
	const ids = plan.item.services
		.map((s) => item.targets[s.slug])
		.filter((id): id is string => !!id);
	const state = item.sourceState ?? { services: {}, containers: [] };
	if (stateful(plan)) {
		await stopTargets(ctx, ids);
		await restoreSource(ctx, state);
	} else {
		await restoreSource(ctx, state);
		await stopTargets(ctx, ids);
	}
}

export async function cutOver(ctx: Ctx, itemId: string) {
	const { item, plan } = await load(ctx, itemId);
	if (item.status === "cut_over") return;
	// Organization resources have nothing to switch; the GitHub webhook moves in MIG-3c.
	if (plan.type === "org") {
		if (plan.item.kind !== "gitProvider")
			return move(ctx, item, { type: "cut_over" }, null);
		// The provider works either way; only pushes keep going to the source until it is reconnected.
		const why = await moveGitHubHook(ctx, item.targets.id ?? "").then(
			() => null,
			(e) =>
				`the GitHub App's webhook still points at ${sourceProfiles[item.source].label} (${e instanceof Error ? e.message : String(e)}); reconnect the provider in LogiStack`,
		);
		return move(ctx, item, { type: "cut_over" }, why);
	}
	const targets = targetsOf(item, plan);
	if (item.source === "coolify") {
		// Before anything moves: Coolify must not bring back what the cutover stops, and the bridge
		// must carry the old names before the new service deploys onto it.
		await freeze(ctx, item.migrationId);
		await ensureBridge(ctx);
	}
	const state = await saveSource(ctx, { ...item }, plan);
	const fresh = { ...item, sourceState: state };
	try {
		const up = async () => {
			for (const t of targets)
				if (t.running) await deploy(ctx, t.id);
				else
					await ctx.db
						.update(service)
						.set({ desiredState: "stopped" })
						.where(eq(service.id, t.id));
		};
		if (stateful(plan)) {
			await stopSource(ctx, state);
			await up();
		} else {
			await up();
			if (descriptorOf(plan).routedByLabels)
				await Bun.sleep(ctx.cfg.LS_BRIDGE_SETTLE_MS);
			await stopSource(ctx, state);
		}
		await move(ctx, item, { type: "cut_over" }, null);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		log("warn", "cutover failed, rolling back", { itemId, error: cause });
		try {
			await rollBackItem(ctx, fresh, plan);
		} catch (e) {
			// The item stays where it was, with both errors, for a person to look at.
			const both = `${cause}; rollback failed: ${e instanceof Error ? e.message : String(e)}`;
			await ctx.db
				.update(migrationItem)
				.set({ lastError: both })
				.where(eq(migrationItem.id, item.id));
			throw new Error(both);
		}
		await move(ctx, item, { type: "rolled_back" }, cause);
	}
}

/** A person asked to go back to the source. */
export async function rollBack(ctx: Ctx, itemId: string) {
	const { item, plan } = await load(ctx, itemId);
	if (item.status === "rolled_back") return;
	if (plan.type === "service") await rollBackItem(ctx, item, plan);
	await move(ctx, item, { type: "rolled_back" }, null);
}
