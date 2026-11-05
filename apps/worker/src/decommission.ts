/**
 * Decommissions Dokploy once every item is on LogiStack or left there on purpose (MIG-7):
 *
 * 1. Archives it under `LS_MIGRATION_ARCHIVE_DIR/<stamp>/`, in a one-shot Swarm job on this node
 *    that runs Dokploy's own Postgres image (so `pg_dump` matches the server) and reads the
 *    password the way `dokploy-postgres` does: its secret file, or its env on releases before
 *    0.26.6. It writes `dokploy.dump`, `etc-dokploy.tar.gz` and `inventory.json` and checks the
 *    dump and the tarball before anything is removed.
 * 2. Detaches the migrated services from `dokploy-network` (the MIG-3b bridge).
 * 3. Removes Dokploy's own services and Traefik, and the sources the cutovers stopped, by exact
 *    name or container id. Items staying on Dokploy and every volume are left alone.
 * 4. Removes `dokploy-network` if nothing uses it any more.
 *
 * A failure before step 2 leaves Dokploy exactly as it was.
 */

import { decommissionBlocker } from "@logistack/core";
import {
	type DecommissionState,
	migration,
	migrationBridge,
	migrationItem,
} from "@logistack/db";
import { DockerError, managedLabels, type Service } from "@logistack/docker";
import { and, eq } from "drizzle-orm";
import { inspectService } from "./apply.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { scope } from "./ctx.ts";
import { svcName } from "./load.ts";

const ARCHIVE_TIMEOUT_MS = 30 * 60_000;

const ARCHIVE_SCRIPT = `set -eu
dir="/archive/$STAMP"
mkdir -p "$dir"
chmod 700 "$dir"
if [ -n "\${PGPASSWORD_FILE:-}" ]; then PGPASSWORD="$(cat "$PGPASSWORD_FILE")"; export PGPASSWORD; fi
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$dir/dokploy.dump"
pg_restore -l "$dir/dokploy.dump" >/dev/null
tar -czf "$dir/etc-dokploy.tar.gz" -C /src .
tar -tzf "$dir/etc-dokploy.tar.gz" >/dev/null
cp /inventory.json "$dir/inventory.json"
chmod 600 "$dir"/*
echo archived`;

const envOf = (s: Service) =>
	Object.fromEntries(
		(s.Spec.TaskTemplate.ContainerSpec.Env ?? []).map((e) => {
			const i = e.indexOf("=");
			return [e.slice(0, i), e.slice(i + 1)];
		}),
	);

/** Ids, of tasks or containers, still in a non-final state. */
const live = [
	"new",
	"pending",
	"assigned",
	"accepted",
	"preparing",
	"starting",
	"running",
];

async function waitForJob(ctx: Ctx, name: string) {
	const deadline = Date.now() + ARCHIVE_TIMEOUT_MS;
	for (;;) {
		const [task] = await ctx.docker.tasks.list({ service: [name] });
		const state = task?.Status?.State;
		if (state === "complete") return;
		if (state && !live.includes(state)) {
			let logs = "";
			try {
				const dec = new TextDecoder();
				for await (const f of await ctx.docker.services.logs(name, {
					tail: 20,
				}))
					logs += dec.decode(f.data);
			} catch {}
			throw new Error(
				`archive job ${state}${task?.Status?.Err ? `: ${task.Status.Err}` : ""}${logs.trim() ? `\n${logs.replace(/[^\x20-\x7e\n]/g, "").trim()}` : ""}`,
			);
		}
		if (Date.now() > deadline) throw new Error("archive job timed out");
		await Bun.sleep(1_000);
	}
}

/** Runs the archive job and returns the archive's path. */
async function archive(
	ctx: Ctx,
	mig: typeof migration.$inferSelect,
	inventory: unknown,
): Promise<string> {
	const pg = await inspectService(ctx, ctx.cfg.LS_DOKPLOY_POSTGRES);
	if (!pg)
		throw new Error(
			`${ctx.cfg.LS_DOKPLOY_POSTGRES} is not running: nothing to archive from`,
		);
	const env = envOf(pg);
	const user = env.POSTGRES_USER || "postgres";
	const fileEnv = env.POSTGRES_PASSWORD_FILE;
	const secret = fileEnv
		? pg.Spec.TaskTemplate.ContainerSpec.Secrets?.find(
				(s) =>
					s.File.Name === fileEnv || `/run/secrets/${s.File.Name}` === fileEnv,
			)
		: undefined;
	if (fileEnv && !secret)
		throw new Error(
			`${ctx.cfg.LS_DOKPLOY_POSTGRES}: no secret behind POSTGRES_PASSWORD_FILE`,
		);
	if (!secret && !env.POSTGRES_PASSWORD)
		throw new Error(`${ctx.cfg.LS_DOKPLOY_POSTGRES}: no password to dump with`);
	const network = await ctx.docker.networks.inspect(ctx.cfg.LS_DOKPLOY_NETWORK);
	const self = (await ctx.docker.info()).Swarm.NodeID;

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const short = mig.id.slice(-8).toLowerCase();
	const name = `${ctx.cfg.LS_NAME_PREFIX}ls-mig-archive-${short}`;
	const labels = {
		...managedLabels({
			resource: mig.id,
			kind: "system",
			org: mig.organizationId,
		}),
		...scope(ctx).labels,
	};
	const configName = `${name}-${Date.now()}`;
	const config = await ctx.docker.configs.create({
		Name: configName,
		Labels: labels,
		Data: JSON.stringify(inventory, null, 2),
	});
	await ctx.docker.services.remove(name).catch(() => {});
	try {
		await ctx.docker.services.create({
			Name: name,
			Labels: labels,
			Mode: { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } },
			TaskTemplate: {
				ContainerSpec: {
					Image: pg.Spec.TaskTemplate.ContainerSpec.Image,
					Labels: labels,
					Command: ["sh", "-c", ARCHIVE_SCRIPT],
					Env: [
						`STAMP=${stamp}`,
						`PGHOST=${ctx.cfg.LS_DOKPLOY_POSTGRES}`,
						`PGUSER=${user}`,
						`PGDATABASE=${env.POSTGRES_DB || user}`,
						// shortcut: before 0.26.6 Dokploy keeps the password in its service env; it is
						// copied into this job's env (never argv) for the minutes the job lives.
						...(secret
							? ["PGPASSWORD_FILE=/run/secrets/dokploy_pg_password"]
							: [`PGPASSWORD=${env.POSTGRES_PASSWORD}`]),
					],
					Secrets: secret
						? [
								{
									SecretID: secret.SecretID,
									SecretName: secret.SecretName,
									File: {
										Name: "dokploy_pg_password",
										UID: "0",
										GID: "0",
										Mode: 0o400,
									},
								},
							]
						: [],
					Configs: [
						{
							ConfigID: config.ID,
							ConfigName: configName,
							File: {
								Name: "/inventory.json",
								UID: "0",
								GID: "0",
								Mode: 0o400,
							},
						},
					],
					Mounts: [
						{
							Type: "bind",
							Source: ctx.cfg.LS_DOKPLOY_ROOT,
							Target: "/src",
							ReadOnly: true,
						},
						{
							Type: "bind",
							Source: ctx.cfg.LS_MIGRATION_ARCHIVE_DIR,
							Target: "/archive",
						},
					],
				},
				RestartPolicy: { Condition: "none" },
				Placement: { Constraints: [`node.id==${self}`] },
				Networks: [{ Target: network.Id }],
			},
		});
		await waitForJob(ctx, name);
	} finally {
		await ctx.docker.services.remove(name).catch(() => {});
		// Swarm frees a config only once the task using it is gone.
		for (let i = 0; i < 20; i++) {
			const gone = await ctx.docker.configs.remove(config.ID).then(
				() => true,
				(e) => e instanceof DockerError && e.notFound,
			);
			if (gone) break;
			await Bun.sleep(500);
		}
	}
	return `${ctx.cfg.LS_MIGRATION_ARCHIVE_DIR}/${stamp}`;
}

/** Drops the Dokploy network from a LogiStack service's spec, if it is attached. */
async function detach(ctx: Ctx, name: string, networkId: string) {
	const svc = await inspectService(ctx, name);
	const nets = svc?.Spec.TaskTemplate.Networks ?? [];
	if (!svc || !nets.some((n) => n.Target === networkId)) return false;
	await ctx.docker.services.update(svc.ID, svc.Version.Index, {
		...svc.Spec,
		TaskTemplate: {
			...svc.Spec.TaskTemplate,
			Networks: nets.filter((n) => n.Target !== networkId),
		},
	});
	return true;
}

const notFound = (e: unknown) => e instanceof DockerError && e.notFound;

async function removeService(ctx: Ctx, name: string) {
	const svc = await inspectService(ctx, name);
	if (!svc) return false;
	await ctx.docker.services.remove(svc.ID).catch((e) => {
		if (!notFound(e)) throw e;
	});
	return true;
}

async function removeContainer(ctx: Ctx, id: string) {
	return ctx.docker.containers.remove(id, true).then(
		() => true,
		(e) => {
			if (notFound(e)) return false;
			throw e;
		},
	);
}

export async function decommission(ctx: Ctx, migrationId: string) {
	const [mig] = await ctx.db
		.select()
		.from(migration)
		.where(eq(migration.id, migrationId));
	if (!mig) throw new Error(`migration ${migrationId} not found`);
	if (mig.status === "decommissioned") return mig.decommission;
	const items = await ctx.db
		.select()
		.from(migrationItem)
		.where(eq(migrationItem.migrationId, migrationId));
	const blocker = decommissionBlocker(
		items,
		mig.proxyState?.result?.status === "switched",
		mig.source,
	);
	if (blocker) throw new Error(`cannot remove Dokploy yet: ${blocker}`);

	const state: DecommissionState = { ...(mig.decommission ?? {}) };
	delete state.result;
	const save = () =>
		ctx.db
			.update(migration)
			.set({ decommission: state })
			.where(eq(migration.id, migrationId));
	try {
		// Archived once: a retry after a failed removal keeps the first archive.
		if (!state.archive) {
			const inventory = items.map((i) => ({
				kind: i.kind,
				sourceId: i.sourceId,
				name: i.name,
				status: i.status,
				targets: i.targets,
			}));
			const path = await archive(ctx, mig, inventory);
			state.archive = {
				path,
				files: ["dokploy.dump", "etc-dokploy.tar.gz", "inventory.json"],
			};
			await save();
		}
		const removed = new Set(state.removed ?? []);
		const kept: NonNullable<DecommissionState["kept"]> = [];

		const network = await ctx.docker.networks
			.inspect(ctx.cfg.LS_DOKPLOY_NETWORK)
			.catch((e) => {
				if (notFound(e)) return undefined;
				throw e;
			});
		const bridged = await ctx.db
			.select({ id: migrationBridge.serviceId })
			.from(migrationBridge)
			.where(eq(migrationBridge.migrationId, migrationId));
		if (network)
			for (const s of bridged)
				await detach(ctx, svcName(ctx, s.id), network.Id);
		// Nothing bridges any more: the next deploy of a moved service leaves the source behind.
		await ctx.db
			.delete(migrationBridge)
			.where(eq(migrationBridge.migrationId, migrationId));

		for (const name of ctx.cfg.LS_DOKPLOY_SERVICES.split(",")
			.map((s) => s.trim())
			.filter(Boolean))
			if (await removeService(ctx, name)) removed.add(name);
		const traefik = ctx.cfg.LS_DOKPLOY_TRAEFIK;
		if (await removeService(ctx, traefik)) removed.add(traefik);
		const [tc] = (
			await ctx.docker.containers.list({ name: [traefik] }, true)
		).filter((c) => c.Names.includes(`/${traefik}`));
		if (tc && (await removeContainer(ctx, tc.Id))) removed.add(traefik);

		for (const i of items) {
			if (i.status === "skipped") {
				kept.push({ name: i.name, reason: "stays on Dokploy" });
				continue;
			}
			for (const name of Object.keys(i.sourceState?.services ?? {}))
				if (await removeService(ctx, name)) removed.add(name);
			for (const id of i.sourceState?.containers ?? [])
				if (await removeContainer(ctx, id))
					removed.add(`${i.name} (${id.slice(0, 12)})`);
		}

		if (network) {
			const left = await ctx.docker.networks.remove(network.Id).then(
				() => undefined,
				(e: unknown) =>
					notFound(e) ? undefined : e instanceof Error ? e.message : String(e),
			);
			if (left === undefined) removed.add(ctx.cfg.LS_DOKPLOY_NETWORK);
			else
				kept.push({
					name: ctx.cfg.LS_DOKPLOY_NETWORK,
					reason:
						"still in use; re-run install.sh to detach LogiStack's api, then remove it",
				});
		}
		state.removed = [...removed];
		state.kept = kept;
		state.result = { status: "done", at: new Date().toISOString() };
		await ctx.db
			.update(migration)
			.set({ decommission: state, status: "decommissioned" })
			.where(
				and(eq(migration.id, migrationId), eq(migration.status, mig.status)),
			);
		return state;
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		log("warn", "decommission failed", { migrationId, error });
		state.result = { status: "failed", at: new Date().toISOString(), error };
		await save();
		return state;
	}
}
