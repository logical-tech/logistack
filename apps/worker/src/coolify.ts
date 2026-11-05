/**
 * What a Coolify migration needs around the shared cutover (COOL-5), all by exact name or
 * Coolify's own labels:
 *
 * - Freeze: Coolify's control plane (`coolify`) is stopped with restart policy `no` from the first
 *   cutover, after its state is saved on the migration. Otherwise its scheduler restarts the proxy
 *   after the switch and a git push redeploys a container next to the moved service. Unfreezing
 *   restores the saved policy and running state.
 * - Bridge: Coolify runs plain containers on local bridges, which Swarm services cannot join, so
 *   the bridge runs the other way: Coolify's proxy and its containers join LogiStack's attachable
 *   overlay, where moved services answer under the old container names. Idempotent: a Coolify
 *   redeploy or upgrade recreates containers without the attachment, so every cutover repairs it.
 */
import type { FreezeState } from "@logistack/db";
import { migration } from "@logistack/db";
import { DockerError } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import { unlessAlready } from "./migration.ts";

const notFound = (e: unknown) => e instanceof DockerError && e.notFound;
const names = (csv: string) =>
	csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/** A container by its exact name, or undefined. */
async function containerNamed(ctx: Ctx, name: string) {
	return ctx.docker.containers.inspect(name).catch((e) => {
		if (notFound(e)) return undefined;
		throw e;
	});
}

export async function freeze(ctx: Ctx, migrationId: string) {
	const [mig] = await ctx.db
		.select({ freeze: migration.freeze })
		.from(migration)
		.where(eq(migration.id, migrationId));
	let state = mig?.freeze ?? undefined;
	if (!state) {
		const containers: FreezeState["containers"] = [];
		for (const name of names(ctx.cfg.LS_COOLIFY_CONTROL)) {
			const c = await containerNamed(ctx, name);
			if (c)
				containers.push({
					id: c.Id,
					name,
					restartPolicy: c.HostConfig.RestartPolicy.Name || "no",
					running: c.State.Running,
				});
		}
		state = { containers, frozenAt: new Date().toISOString() };
		// Saved before anything changes, so unfreezing after a crash restores what was.
		await ctx.db
			.update(migration)
			.set({ freeze: state })
			.where(eq(migration.id, migrationId));
	}
	for (const c of state.containers) {
		await ctx.docker.containers
			.setRestartPolicy(c.id, { Name: "no" })
			.catch((e) => {
				if (!notFound(e)) throw e;
			});
		await ctx.docker.containers.stop(c.id).catch((e) => {
			if (!notFound(e)) unlessAlready(e);
		});
	}
	return state;
}

export async function unfreeze(ctx: Ctx, migrationId: string) {
	const [mig] = await ctx.db
		.select({ freeze: migration.freeze })
		.from(migration)
		.where(eq(migration.id, migrationId));
	for (const c of mig?.freeze?.containers ?? []) {
		await ctx.docker.containers
			.setRestartPolicy(c.id, {
				Name: c.restartPolicy as
					| "no"
					| "always"
					| "unless-stopped"
					| "on-failure",
			})
			.catch((e) => {
				if (!notFound(e)) throw e;
			});
		if (c.running)
			await ctx.docker.containers.start(c.id).catch((e) => {
				if (!notFound(e)) unlessAlready(e);
			});
	}
	await ctx.db
		.update(migration)
		.set({ freeze: null })
		.where(eq(migration.id, migrationId));
}

/** The bridge overlay; created with LogiStack's labels when install.sh's is missing. */
export async function bridgeNetwork(ctx: Ctx) {
	const name = ctx.cfg.LS_COOLIFY_NETWORK;
	const found = await ctx.docker.networks.inspect(name).catch((e) => {
		if (notFound(e)) return undefined;
		throw e;
	});
	if (found) return found;
	await ctx.docker.networks
		.create({
			Name: name,
			Driver: "overlay",
			Attachable: true,
			Labels: {
				"logistack.managed": "true",
				"logistack.kind": "migration-bridge",
				"logistack.resource": "coolify",
				...scope(ctx).labels,
			},
		})
		.catch((e) => {
			// A concurrent creator won; inspect below finds it.
			if (!(e instanceof DockerError && e.status === 409)) throw e;
		});
	return ctx.docker.networks.inspect(name);
}

/**
 * Joins Coolify's proxy and every running Coolify-managed container to the bridge, so names
 * resolve both ways and the old proxy reaches moved services.
 */
export async function ensureBridge(ctx: Ctx) {
	const net = await bridgeNetwork(ctx);
	const running = await ctx.docker.containers.list({
		label: [ctx.cfg.LS_COOLIFY_MANAGED_LABEL],
		status: ["running"],
	});
	const proxy = await containerNamed(ctx, ctx.cfg.LS_COOLIFY_PROXY);
	// The proxy first: Traefik may route a container without `traefik.docker.network` through any
	// of its networks, so once a container joins, the proxy must already reach the overlay.
	const ids = new Set([
		...(proxy?.State.Running ? [proxy.Id] : []),
		...running.map((c) => c.Id),
	]);
	for (const id of ids) {
		const c = await containerNamed(ctx, id);
		if (
			!c ||
			Object.values(c.NetworkSettings.Networks).some(
				(n) => n.NetworkID === net.Id,
			)
		)
			continue;
		await ctx.docker.networks.connect(net.Id, id).catch((e) => {
			// Already connected (a race with another cutover), or gone since the listing.
			if (e instanceof DockerError && (e.status === 403 || e.notFound)) return;
			throw e;
		});
		log("info", "joined the Coolify bridge", { container: c.Name });
	}
	return net;
}

/** Disconnects every plain container from the bridge (decommission); Swarm tasks stay. */
export async function detachPlainContainers(ctx: Ctx, networkId: string) {
	const attached = await ctx.docker.containers.list(
		{ network: [networkId] },
		true,
	);
	for (const c of attached) {
		if (c.Labels?.["com.docker.swarm.task.id"]) continue;
		await ctx.docker.networks.disconnect(networkId, c.Id, true).catch((e) => {
			if (!notFound(e)) throw e;
		});
	}
}
