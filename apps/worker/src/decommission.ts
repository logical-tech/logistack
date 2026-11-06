/**
 * Decommissions the source platform once every item is on LogiStack or left there on purpose
 * (MIG-7, COOL-6):
 *
 * 1. Archives it under `LS_MIGRATION_ARCHIVE_DIR/<stamp>/`, in a one-shot Swarm job on this node
 *    that runs the source's own Postgres image (so `pg_dump` matches the server) with its
 *    password as a Swarm secret: Dokploy's own (or its env before 0.26.6), or the one install.sh
 *    made from Coolify's `.env`. It writes the dump, a tarball of the source's directory
 *    (`/etc/dokploy`, or `/data/coolify` without its local backups) and `inventory.json`, and
 *    checks the dump and the tarball before anything is removed.
 * 2. Detaches the migrated services from the bridge network, and Coolify's containers from
 *    LogiStack's overlay.
 * 3. Removes the source's own services or containers and its proxy, and the sources the cutovers
 *    stopped, by exact name or container id. Items staying on the source and every volume are
 *    left alone.
 * 4. Removes the bridge network (and Coolify's own networks) if nothing uses it any more.
 *
 * A failure before step 2 leaves the source exactly as it was.
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
import { bridgeNetwork, detachPlainContainers } from "./coolify.ts";
import type { Ctx } from "./ctx.ts";
import { scope } from "./ctx.ts";
import { svcName } from "./load.ts";
import { sourceSettings } from "./migration-source.ts";
import { waitForJob } from "./swarm-job.ts";

const ARCHIVE_TIMEOUT_MS = 30 * 60_000;

const ARCHIVE_SCRIPT = `set -eu
dir="/archive/$STAMP"
mkdir -p "$dir"
chmod 700 "$dir"
if [ -n "\${PGPASSWORD_FILE:-}" ]; then PGPASSWORD="$(cat "$PGPASSWORD_FILE")"; export PGPASSWORD; fi
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$dir/$DUMP"
pg_restore -l "$dir/$DUMP" >/dev/null
if [ -n "\${TAR_EXCLUDE:-}" ]; then set -- "--exclude=$TAR_EXCLUDE"; else set --; fi
tar -czf "$dir/$TARBALL" "$@" -C /src .
tar -tzf "$dir/$TARBALL" >/dev/null
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

/** What the archive job dumps and packs, per source. */
type ArchiveSource = {
	image: string;
	host: string;
	user: string;
	database: string;
	/** A Swarm secret holding the password, or (Dokploy before 0.26.6) the password itself. */
	password:
		| { secret: { SecretID: string; SecretName: string } }
		| { value: string };
	root: string;
	exclude?: string;
	networkId: string;
	files: [dump: string, tarball: string];
};

async function dokployArchive(ctx: Ctx): Promise<ArchiveSource> {
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
	return {
		image: pg.Spec.TaskTemplate.ContainerSpec.Image,
		host: ctx.cfg.LS_DOKPLOY_POSTGRES,
		user,
		database: env.POSTGRES_DB || user,
		// shortcut: before 0.26.6 Dokploy keeps the password in its service env; it is copied into
		// the job's env (never argv) for the minutes the job lives.
		password: secret
			? { secret: { SecretID: secret.SecretID, SecretName: secret.SecretName } }
			: { value: env.POSTGRES_PASSWORD as string },
		root: ctx.cfg.LS_DOKPLOY_ROOT,
		networkId: network.Id,
		files: ["dokploy.dump", "etc-dokploy.tar.gz"],
	};
}

async function coolifyArchive(ctx: Ctx): Promise<ArchiveSource> {
	const name = ctx.cfg.LS_COOLIFY_DB;
	const db = await ctx.docker.containers.inspect(name).catch((e) => {
		if (notFound(e)) return undefined;
		throw e;
	});
	if (!db?.State.Running)
		throw new Error(`${name} is not running: nothing to archive from`);
	const env = Object.fromEntries(
		(db.Config.Env ?? []).map((e) => [
			e.slice(0, e.indexOf("=")),
			e.slice(e.indexOf("=") + 1),
		]),
	);
	const [secret] = (
		await ctx.docker.secrets.list({ name: [ctx.cfg.LS_COOLIFY_DB_SECRET] })
	).filter((s) => s.Spec.Name === ctx.cfg.LS_COOLIFY_DB_SECRET);
	if (!secret)
		throw new Error(
			`no Swarm secret ${ctx.cfg.LS_COOLIFY_DB_SECRET} with Coolify's database password; re-run install.sh`,
		);
	// A Coolify upgrade recreates coolify-db without LogiStack's overlay; the job reaches it there.
	const net = await bridgeNetwork(ctx);
	if (
		!Object.values(db.NetworkSettings.Networks).some(
			(n) => n.NetworkID === net.Id,
		)
	)
		await ctx.docker.networks.connect(net.Id, db.Id);
	const user = env.POSTGRES_USER || "coolify";
	return {
		image: db.Config.Image,
		host: name,
		user,
		database: env.POSTGRES_DB || user,
		password: { secret: { SecretID: secret.ID, SecretName: secret.Spec.Name } },
		root: ctx.cfg.LS_COOLIFY_ROOT,
		// Coolify's local database dumps can be large and are listed, not copied.
		exclude: "./backups",
		networkId: net.Id,
		files: ["coolify.dump", "data-coolify.tar.gz"],
	};
}

/** Runs the archive job and returns the archive's path. */
async function archive(
	ctx: Ctx,
	mig: typeof migration.$inferSelect,
	inventory: unknown,
	src: ArchiveSource,
): Promise<string> {
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
					Image: src.image,
					Labels: labels,
					Command: ["sh", "-c", ARCHIVE_SCRIPT],
					Env: [
						`STAMP=${stamp}`,
						`PGHOST=${src.host}`,
						`PGUSER=${src.user}`,
						`PGDATABASE=${src.database}`,
						`DUMP=${src.files[0]}`,
						`TARBALL=${src.files[1]}`,
						...(src.exclude ? [`TAR_EXCLUDE=${src.exclude}`] : []),
						...("secret" in src.password
							? ["PGPASSWORD_FILE=/run/secrets/source_pg_password"]
							: [`PGPASSWORD=${src.password.value}`]),
					],
					Secrets:
						"secret" in src.password
							? [
									{
										...src.password.secret,
										File: {
											Name: "source_pg_password",
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
							Source: src.root,
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
				Networks: [{ Target: src.networkId }],
			},
		});
		await waitForJob(ctx.docker, name, {
			what: "archive job",
			timeoutMs: ARCHIVE_TIMEOUT_MS,
		});
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

async function removeContainerNamed(ctx: Ctx, name: string) {
	const [c] = (await ctx.docker.containers.list({ name: [name] }, true)).filter(
		(x) => x.Names.includes(`/${name}`),
	);
	return c ? removeContainer(ctx, c.Id) : false;
}

const csv = (v: string) =>
	v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

const networkExists = (ctx: Ctx, name: string) =>
	ctx.docker.networks.inspect(name).then(
		(n) => n.Name === name,
		(e) => {
			if (notFound(e)) return false;
			throw e;
		},
	);

/** A network by exact name, removed only when nothing uses it; `in use` is the reason kept. */
async function removeNetwork(ctx: Ctx, idOrName: string) {
	return ctx.docker.networks.remove(idOrName).then(
		() => undefined,
		(e: unknown) =>
			notFound(e) ? undefined : e instanceof Error ? e.message : String(e),
	);
}

export async function decommission(ctx: Ctx, migrationId: string) {
	const [mig] = await ctx.db
		.select()
		.from(migration)
		.where(eq(migration.id, migrationId));
	if (!mig) throw new Error(`migration ${migrationId} not found`);
	if (mig.status === "decommissioned") return mig.decommission;
	const from = sourceSettings(ctx.cfg, mig.source);
	const items = await ctx.db
		.select()
		.from(migrationItem)
		.where(eq(migrationItem.migrationId, migrationId));
	const blocker = decommissionBlocker(
		items,
		mig.proxyState?.result?.status === "switched",
		mig.source,
	);
	if (blocker) throw new Error(`cannot remove ${from.label} yet: ${blocker}`);

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
			const src =
				mig.source === "coolify"
					? await coolifyArchive(ctx)
					: await dokployArchive(ctx);
			const path = await archive(ctx, mig, inventory, src);
			state.archive = { path, files: [...src.files, "inventory.json"] };
			await save();
		}
		const removed = new Set(state.removed ?? []);
		const kept: NonNullable<DecommissionState["kept"]> = [];

		const network = await ctx.docker.networks
			.inspect(from.network)
			.catch((e) => {
				if (notFound(e)) return undefined;
				throw e;
			});
		const bridged = await ctx.db
			.select({ id: migrationBridge.serviceId })
			.from(migrationBridge)
			.where(eq(migrationBridge.migrationId, migrationId));
		if (network) {
			for (const s of bridged)
				await detach(ctx, svcName(ctx, s.id), network.Id);
			if (mig.source === "coolify")
				await detachPlainContainers(ctx, network.Id);
		}
		// Nothing bridges any more: the next deploy of a moved service leaves the source behind.
		await ctx.db
			.delete(migrationBridge)
			.where(eq(migrationBridge.migrationId, migrationId));

		if (mig.source === "coolify") {
			for (const name of [...csv(ctx.cfg.LS_COOLIFY_CONTAINERS), from.proxy])
				if (await removeContainerNamed(ctx, name)) removed.add(name);
		} else {
			for (const name of csv(ctx.cfg.LS_DOKPLOY_SERVICES))
				if (await removeService(ctx, name)) removed.add(name);
			if (await removeService(ctx, from.proxy)) removed.add(from.proxy);
			if (await removeContainerNamed(ctx, from.proxy)) removed.add(from.proxy);
		}

		for (const i of items) {
			if (i.status === "skipped") {
				kept.push({
					name: i.name,
					reason:
						mig.source === "coolify"
							? "stays as it is, now without Coolify to manage it"
							: "stays on Dokploy",
				});
				continue;
			}
			for (const name of Object.keys(i.sourceState?.services ?? {}))
				if (await removeService(ctx, name)) removed.add(name);
			for (const id of i.sourceState?.containers ?? [])
				if (await removeContainer(ctx, id))
					removed.add(`${i.name} (${id.slice(0, 12)})`);
			// A one-click service or compose app had its own network, named after its uuid.
			if (
				mig.source === "coolify" &&
				(await networkExists(ctx, i.sourceId)) &&
				(await removeNetwork(ctx, i.sourceId)) === undefined
			)
				removed.add(i.sourceId);
		}

		const networks =
			mig.source === "coolify"
				? [ctx.cfg.LS_COOLIFY_SOURCE_NETWORK, from.network]
				: [from.network];
		for (const name of networks) {
			if (!(await networkExists(ctx, name))) continue;
			const left = await removeNetwork(ctx, name);
			if (left === undefined) removed.add(name);
			else
				kept.push({
					name,
					reason:
						name === from.network
							? "still in use; re-run install.sh to detach LogiStack's api, then remove it"
							: "still in use by containers left on it",
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
