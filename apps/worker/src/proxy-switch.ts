/**
 * Hands ports 80/443 from the source platform's proxy (Dokploy's or Coolify's Traefik) to Caddy
 * (MIG-4), as one worker job:
 *
 * 1. Saves what Traefik is (a container with its restart policy, or a service with its replicas)
 *    and which nodes wait for ingress, before anything changes.
 * 2. Imports Traefik's still-valid certificates for the migrated hostnames into Caddy's storage,
 *    read from `acme.json` through the Docker API (the daemon reads it as root; it is mode 600).
 * 3. Stops Traefik for good: a container also loses its restart policy, or a reboot would bring
 *    it back onto 80/443.
 * 4. Labels the waiting nodes for ingress and waits for Caddy to run there.
 * 5. Probes every migrated hostname over HTTPS, and reports; a failed probe does not undo the
 *    switch (DNS or a certificate still being issued are not Caddy being down).
 *
 * If Caddy does not run within `LS_PROXY_SWITCH_TIMEOUT_MS`, the nodes go back to `pending` and
 * Traefik starts again as it was. Traefik is found by its exact name only.
 */

import {
	domain,
	migration,
	migrationItem,
	type ProxySwitchState,
} from "@logistack/db";
import { firstTarFile } from "@logistack/docker";
import { and, eq, inArray } from "drizzle-orm";
import { planAcmeImport, storeInCaddy } from "./acme-import.ts";
import { log } from "./bus.ts";
import { caddyStorageKey } from "./caddy-storage.ts";
import { CADDY_PREFIX } from "./certs.ts";
import { freeze } from "./coolify.ts";
import type { Ctx } from "./ctx.ts";
import { scale, unlessAlready, waitStopped } from "./migration.ts";
import { sourceSettings } from "./migration-source.ts";
import { syncProxy } from "./proxy.ts";

export type Probe = (
	hostname: string,
) => Promise<{ ok: boolean; detail: string }>;

/** Any HTTPS answer with a certificate the system trusts counts; the status code is the app's. */
export const httpsProbe: Probe = async (hostname) => {
	try {
		const res = await fetch(`https://${hostname}/`, {
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		return { ok: true, detail: `HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, detail: e instanceof Error ? e.message : String(e) };
	}
};

async function save(ctx: Ctx, migrationId: string, state: ProxySwitchState) {
	await ctx.db
		.update(migration)
		.set({ proxyState: state })
		.where(eq(migration.id, migrationId));
}

/** Hostnames of the services this migration has cut over. */
async function migratedHostnames(ctx: Ctx, migrationId: string) {
	const items = await ctx.db
		.select({ targets: migrationItem.targets })
		.from(migrationItem)
		.where(
			and(
				eq(migrationItem.migrationId, migrationId),
				eq(migrationItem.status, "cut_over"),
			),
		);
	const ids = items.flatMap((i) => Object.values(i.targets));
	if (!ids.length) return [];
	const rows = await ctx.db
		.select({ hostname: domain.hostname })
		.from(domain)
		.where(inArray(domain.serviceId, ids));
	return [...new Set(rows.map((r) => r.hostname))];
}

async function findTraefik(
	ctx: Ctx,
	name: string,
): Promise<ProxySwitchState["traefik"]> {
	// shortcut: a proxy container is looked for on the worker's own daemon only, which is where
	// Dokploy and Coolify run it on a single-node server; ask the node's agent once multi-node matters.
	const [container] = (
		await ctx.docker.containers.list({ name: [name] }, true)
	).filter((c) => c.Names.includes(`/${name}`));
	if (container) {
		const c = await ctx.docker.containers.inspect(container.Id);
		return {
			kind: "container",
			id: c.Id,
			restartPolicy: c.HostConfig.RestartPolicy.Name || "no",
			running: c.State.Running,
		};
	}
	const [svc] = (await ctx.docker.services.list({ name: [name] })).filter(
		(s) => s.Spec.Name === name,
	);
	if (svc) {
		const mode = svc.Spec.Mode;
		return {
			kind: "service",
			name,
			replicas: mode && "Replicated" in mode ? mode.Replicated.Replicas : 1,
		};
	}
	return undefined;
}

/** A container of Traefik's, to read `acme.json` from: the container itself, or a service task. */
async function traefikContainer(ctx: Ctx, t: ProxySwitchState["traefik"]) {
	if (!t) return undefined;
	if (t.kind === "container") return t.id;
	const [task] = await ctx.docker.containers.list(
		{ label: [`com.docker.swarm.service.name=${t.name}`] },
		true,
	);
	return task?.Id;
}

async function importCertificates(
	ctx: Ctx,
	migrationId: string,
	t: ProxySwitchState["traefik"],
	acmePath: string,
): Promise<NonNullable<ProxySwitchState["certificates"]>> {
	try {
		const id = await traefikContainer(ctx, t);
		if (!id)
			return {
				imported: [],
				skipped: [],
				error: "no Traefik container to read acme.json from",
			};
		const file = firstTarFile(
			await ctx.docker.containers.archive(id, acmePath),
		);
		if (!file)
			return {
				imported: [],
				skipped: [],
				error: `${acmePath} is not a file`,
			};
		const plan = planAcmeImport(
			new TextDecoder().decode(file),
			await migratedHostnames(ctx, migrationId),
			new Date(),
		);
		const imported = await storeInCaddy(
			ctx.bus.redis,
			plan,
			new Date(),
			CADDY_PREFIX,
			await caddyStorageKey(ctx),
		);
		return { imported, skipped: plan.skipped };
	} catch (e) {
		// Caddy then issues the certificates itself: slower, never wrong.
		return {
			imported: [],
			skipped: [],
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

async function stopTraefik(ctx: Ctx, t: ProxySwitchState["traefik"]) {
	if (!t) return;
	if (t.kind === "service") {
		await scale(ctx, t.name, 0);
		await waitStopped(ctx, t.name);
		return;
	}
	await ctx.docker.containers.setRestartPolicy(t.id, { Name: "no" });
	await ctx.docker.containers.stop(t.id).catch(unlessAlready);
}

async function startTraefik(ctx: Ctx, t: ProxySwitchState["traefik"]) {
	if (!t) return;
	if (t.kind === "service") return scale(ctx, t.name, t.replicas);
	await ctx.docker.containers.setRestartPolicy(t.id, {
		Name: t.restartPolicy as "no",
	});
	if (t.running) await ctx.docker.containers.start(t.id).catch(unlessAlready);
}

async function labelNodes(ctx: Ctx, nodes: string[], value: string) {
	const key = ctx.cfg.LS_INGRESS_LABEL;
	for (const id of nodes) {
		const node = await ctx.docker.nodes.inspect(id);
		if (node.Spec.Labels?.[key] === value) continue;
		await ctx.docker.nodes.update(id, node.Version.Index, {
			...node.Spec,
			Labels: { ...node.Spec.Labels, [key]: value },
		});
	}
}

/** Until Caddy has a running task on every node, or the deadline passes. */
async function waitForCaddy(ctx: Ctx, nodes: string[], deadline: number) {
	for (;;) {
		const tasks = await ctx.docker.tasks.list({
			service: [ctx.cfg.LS_CADDY_SERVICE],
			"desired-state": ["running"],
		});
		const up = new Set(
			tasks.filter((t) => t.Status?.State === "running").map((t) => t.NodeID),
		);
		if (nodes.every((n) => up.has(n))) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(1_000);
	}
}

/**
 * Caddy starts with no routes. The periodic sync would wait for Swarm to report its task running,
 * seconds after the container is up: MIG-8 measured ~6 s of 404 that way. Push as soon as the task
 * is starting, and again every half second until a Caddy takes it.
 */
async function firstSync(ctx: Ctx, deadline: number) {
	while (Date.now() < deadline) {
		const r = await syncProxy(ctx, { starting: true }).catch((e: unknown) => ({
			instances: 0,
			failures: [String(e)],
		}));
		if (
			("skipped" in r && r.skipped) ||
			(r.instances > 0 && !r.failures.length)
		)
			return;
		await Bun.sleep(500);
	}
	log("warn", "proxy switch: Caddy took no config before the deadline");
}

export async function switchProxy(
	ctx: Ctx,
	migrationId: string,
	probe: Probe = httpsProbe,
): Promise<ProxySwitchState> {
	const [mig] = await ctx.db
		.select()
		.from(migration)
		.where(eq(migration.id, migrationId));
	if (!mig) throw new Error(`migration ${migrationId} not found`);
	const state: ProxySwitchState = { ...(mig.proxyState ?? {}) };
	if (state.result?.status === "switched") return state;

	// What to restore is saved once, before anything changes; a re-run keeps the first answer.
	const from = sourceSettings(ctx.cfg, mig.source);
	state.traefik ??= await findTraefik(ctx, from.proxy);
	state.nodes ??= (
		await ctx.docker.nodes.list({
			"node.label": [`${ctx.cfg.LS_INGRESS_LABEL}=pending`],
		})
	).map((n) => n.ID);
	delete state.result;
	await save(ctx, migrationId, state);
	if (!state.nodes.length)
		throw new Error(
			`no node is labelled ${ctx.cfg.LS_INGRESS_LABEL}=pending: ingress is already on, or install.sh ran without --no-ingress`,
		);

	state.certificates = await importCertificates(
		ctx,
		migrationId,
		state.traefik,
		from.acmePath,
	);
	await save(ctx, migrationId, state);

	// Coolify's scheduler restarts a stopped proxy; it stays frozen from here (normally since the
	// first cutover already).
	if (mig.source === "coolify") await freeze(ctx, migrationId);
	await stopTraefik(ctx, state.traefik);
	await labelNodes(ctx, state.nodes, "true");
	const deadline = Date.now() + ctx.cfg.LS_PROXY_SWITCH_TIMEOUT_MS;
	await firstSync(ctx, deadline);
	if (!(await waitForCaddy(ctx, state.nodes, deadline))) {
		const error = `Caddy did not start on ${state.nodes.length} node(s) within ${ctx.cfg.LS_PROXY_SWITCH_TIMEOUT_MS / 1000} s; Traefik is back`;
		log("warn", "proxy switch fell back to Traefik", { migrationId });
		await labelNodes(ctx, state.nodes, "pending");
		await waitStopped(ctx, ctx.cfg.LS_CADDY_SERVICE);
		await startTraefik(ctx, state.traefik);
		state.result = { status: "fell_back", at: new Date().toISOString(), error };
		await save(ctx, migrationId, state);
		return state;
	}

	const probes = [];
	for (const hostname of await migratedHostnames(ctx, migrationId))
		probes.push({ hostname, ...(await probe(hostname)) });
	state.result = { status: "switched", at: new Date().toISOString(), probes };
	await save(ctx, migrationId, state);
	return state;
}
