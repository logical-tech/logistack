import {
	BACKUP_QUEUE,
	type BackupJob,
	DBOPS_QUEUE,
	type DbOpsJob,
	type EventEnvelope,
	MIGRATION_QUEUE,
	type MigrationJob,
	SCAN_QUEUE,
	SCHEDULE_QUEUE,
	type ScanJob,
	type ScheduleJob,
} from "@logistack/contracts";
import { loadMasterKeys } from "@logistack/core";
import {
	backupPolicy,
	createDb,
	deployment,
	patchPolicy,
	schedule,
} from "@logistack/db";
import { createDockerClient, type DockerEvent } from "@logistack/docker";
import { coalesce } from "@logistack/proxy";
import { type Job, Worker } from "bullmq";
import { eq, notInArray } from "drizzle-orm";
import { ensureStackNetwork } from "./apply.ts";
import { processBackupJob } from "./backups.ts";
import { installEmulation, probeBuildkit } from "./build-platforms.ts";
import { createBus, log, setLogLevel, withLock } from "./bus.ts";
import { caddyStorageKey } from "./caddy-storage.ts";
import { checkCertificates } from "./certs.ts";
import { CHECKS_POLL_MS, pollChecks } from "./checks.ts";
import { loadCleanup, runCleanup } from "./cleanup.ts";
import { reportCommitStatus } from "./commit-status.ts";
import { type Config, loadConfig } from "./config.ts";
import { unfreeze } from "./coolify.ts";
import type { Ctx } from "./ctx.ts";
import { reconcileDbAccess } from "./db-access.ts";
import { runUpgrade } from "./db-upgrade.ts";
import { decommission } from "./decommission.ts";
import { abortAll, cancelRunning, processService, terminal } from "./deploy.ts";
import { recheckExternalSecrets } from "./external-secrets.ts";
import { checkForUpdate, renewSponsorKey } from "./instance-update.ts";
import { syncLocalRegistry } from "./local-registry.ts";
import { rotateMasterKey } from "./master-key.ts";
import { cutOver, rollBack } from "./migration.ts";
import { startMonitoring } from "./monitoring.ts";
import { createNodeRunner } from "./node-runner.ts";
import { notifier } from "./notify.ts";
import { queueWindowRun, scanAll } from "./patching.ts";
import { reconcilePlugins } from "./plugins.ts";
import { expirePreviews } from "./previews.ts";
import { listenForSyncRequests, syncProxy } from "./proxy.ts";
import { switchProxy } from "./proxy-switch.ts";
import {
	createQueues,
	enqueueDeploy,
	enqueueProxySync,
	enqueueReconcile,
	enqueueScan,
	redisConnection,
} from "./queues.ts";
import { reconcilePass, sweepOrphans } from "./reconcile.ts";
import { pruneImages } from "./retention.ts";
import {
	type RunQueues,
	syncAllSchedulers,
	syncCleanupScheduler,
	syncPatchWindow,
} from "./schedulers.ts";
import { createScheduleRunner } from "./schedules.ts";
import { convertLegacySecrets } from "./secrets.ts";
import { syncTailscale } from "./tailscale.ts";
import { syncTunnels } from "./tunnels.ts";
import {
	UPTIME_TICK_MS,
	UPTIME_TICK_SCHEDULER,
	uptimeWorker,
} from "./uptime.ts";
import { processScanJob } from "./vulnscan.ts";
import { WORK_CHANNEL, workRecurrenceJob } from "./work-recurrence.ts";

export type RunningWorker = { ctx: Ctx; stop(): Promise<void> };

/** Same path as the worker target's HEALTHCHECK in the Dockerfile. */
const HEARTBEAT = "/tmp/logistack-worker.alive";

async function onEvent(ctx: Ctx, e: EventEnvelope) {
	switch (e.type) {
		case "deployment.queued": {
			let serviceId = e.payload.serviceId;
			if (typeof serviceId !== "string") {
				const [d] = await ctx.db
					.select({ serviceId: deployment.serviceId })
					.from(deployment)
					.where(eq(deployment.id, e.resource.id));
				serviceId = d?.serviceId;
			}
			if (typeof serviceId === "string")
				await enqueueDeploy(ctx.queues, serviceId);
			return;
		}
		case "deployment.cancelled":
			cancelRunning(e.resource.id);
			return;
		case "deployment.succeeded":
			await enqueueProxySync(ctx.queues, "deployment succeeded");
			// Its own queue, after the fact: a scan never holds up a deploy.
			if (typeof e.payload.serviceId === "string")
				await enqueueScan(ctx.queues, e.payload.serviceId);
			return;
	}
}

/** Follows Docker events, reconnecting after errors, until `signal` aborts. */
async function followDocker(ctx: Ctx, signal: AbortSignal) {
	while (!signal.aborted) {
		try {
			for await (const ev of ctx.docker.events({
				filters: { type: ["service", "container"] },
				signal,
			}) as AsyncIterable<DockerEvent>) {
				const swarmService =
					ev.Actor.Attributes["com.docker.swarm.service.name"];
				if (
					ev.Type === "container" &&
					ev.Action === "start" &&
					swarmService === ctx.cfg.LS_CADDY_SERVICE
				)
					await enqueueProxySync(ctx.queues, "caddy task started");
				if (
					ev.Type === "service" &&
					["create", "update", "remove"].includes(ev.Action)
				)
					await enqueueReconcile(ctx.queues, `service ${ev.Action}`);
			}
		} catch (e) {
			if (signal.aborted) return;
			log("warn", "docker events stream broke, reconnecting", {
				error: e instanceof Error ? e.message : String(e),
			});
			await Bun.sleep(2_000);
		}
	}
}

export async function startWorker(cfg: Config): Promise<RunningWorker> {
	setLogLevel(cfg.LOG_LEVEL);
	const connection = redisConnection(cfg.REDIS_URL);
	const ctx: Ctx = {
		cfg,
		db: createDb(cfg.DATABASE_URL, { onnotice: () => {} }),
		docker: createDockerClient({ socketPath: cfg.DOCKER_SOCKET }),
		bus: await createBus(cfg.REDIS_URL),
		...(await loadMasterKeys(
			cfg.LOGISTACK_MASTER_KEY,
			cfg.LOGISTACK_MASTER_KEY_PREVIOUS,
		)),
		queues: createQueues(connection),
		nodes: await createNodeRunner(cfg.REDIS_URL),
	};
	const failed = (queue: string) => (job: Job | undefined, err: Error) =>
		log("error", "job failed", { queue, jobId: job?.id, error: err.message });

	const schedules = await createScheduleRunner(ctx);
	const notify = notifier(ctx);
	const proxySync = coalesce(async () => {
		await syncProxy(ctx);
		// After Caddy: a tunnel hostname should already route when Cloudflare starts sending it.
		await syncTunnels(ctx).catch((e: unknown) =>
			log("warn", "tunnel sync failed", { error: String(e) }),
		);
		await syncTailscale(ctx).catch((e: unknown) =>
			log("warn", "tailscale sync failed", { error: String(e) }),
		);
	}, cfg.LS_PROXY_COALESCE_MS);
	const workers = [
		new Worker<{ serviceId: string }>(
			"deploy",
			(job) => processService(ctx, job.data.serviceId),
			{ connection, concurrency: cfg.LS_CONCURRENCY },
		),
		// High concurrency so jobs arriving within one window share a single coalesced push.
		new Worker("proxy", () => proxySync(undefined), {
			connection,
			concurrency: 16,
		}),
		new Worker(
			"reconcile",
			async () => {
				await reconcilePass(ctx);
				await syncLocalRegistry(ctx);
			},
			{
				connection,
				concurrency: 1,
			},
		),
		new Worker(
			"maintenance",
			async (job) => {
				if (job.name === "certificates") await checkCertificates(ctx);
				else if (job.name === "retention") await pruneImages(ctx);
				else if (job.name === "update-check")
					await Promise.all([checkForUpdate(ctx), renewSponsorKey(ctx)]);
				else if (job.name === "cleanup") await runCleanup(ctx);
				else if (job.name === "checks") await pollChecks(ctx);
				else if (job.name === "previews") await expirePreviews(ctx);
				else if (job.name === "external-secrets")
					log("info", "external secrets checked", {
						...(await recheckExternalSecrets(ctx)),
					});
				else if (job.name === "buildkit-probe") await probeBuildkit(ctx);
				else if (job.name === "binfmt-install") await installEmulation(ctx);
				else if (job.name === "db-access") await reconcileDbAccess(ctx);
				else if (job.name === "plugins") await reconcilePlugins(ctx);
				else if (job.name === "work-recurrence")
					await workRecurrenceJob(ctx.db, (m) => {
						void ctx.bus.redis.publish(WORK_CHANNEL, JSON.stringify(m));
					});
				else if (job.name === "patch-scan")
					await withLock(ctx.bus.redis, "ls:lock:patch-scan", 3_600_000, () =>
						scanAll(ctx),
					);
				else if (job.name === "patch-window")
					await queueWindowRun(ctx, job.data.organizationId);
				else await sweepOrphans(ctx);
			},
			{
				connection,
				concurrency: 1,
			},
		),
		new Worker<BackupJob>(
			BACKUP_QUEUE,
			async (job) => {
				await processBackupJob(ctx, job.data, (d) => job.updateData(d));
			},
			{ connection, concurrency: cfg.LS_RUN_CONCURRENCY },
		),
		new Worker<ScheduleJob>(
			SCHEDULE_QUEUE,
			async (job) => {
				await schedules.process(job.data, (d) => job.updateData(d));
			},
			{ connection, concurrency: cfg.LS_RUN_CONCURRENCY },
		),
		// One scan at a time per worker: Trivy is heavy and its cache volume is shared.
		new Worker<ScanJob & { force?: boolean }>(
			SCAN_QUEUE,
			(job) => processScanJob(ctx, job.data),
			{ connection, concurrency: 1 },
		),
		uptimeWorker(ctx, connection, cfg.LS_UPTIME_CONCURRENCY),
		new Worker("notify", (job) => notify.retry(job.data), {
			connection,
			concurrency: 8,
		}),
		// Upgrades run for hours; one per service is enforced by the api, several services may run.
		new Worker<DbOpsJob>(
			DBOPS_QUEUE,
			(job) => runUpgrade(ctx, job.data.upgradeId),
			{
				connection,
				concurrency: cfg.LS_RUN_CONCURRENCY,
				// shortcut: a dead worker must not replay a half-done upgrade, so it fails as stalled and its row stays running; add a boot check once upgrades get long enough to matter.
				maxStalledCount: 0,
			},
		),
		// One cutover at a time: the wizard moves services in order, databases first.
		new Worker<MigrationJob>(
			MIGRATION_QUEUE,
			async (job) => {
				const d = job.data;
				if (d.action === "switch_proxy") await switchProxy(ctx, d.migrationId);
				else if (d.action === "decommission")
					await decommission(ctx, d.migrationId);
				else if (d.action === "unfreeze") await unfreeze(ctx, d.migrationId);
				else if (d.action === "cutover") await cutOver(ctx, d.itemId);
				else await rollBack(ctx, d.itemId);
			},
			{ connection, concurrency: 1 },
		),
	];
	for (const w of workers) w.on("failed", failed(w.name));

	// Postgres is the source of truth for every backup and schedule cron; converge BullMQ to it.
	await syncAllSchedulers(
		{ backup: ctx.queues.backup, schedule: ctx.queues.schedule } as RunQueues,
		await ctx.db.select().from(backupPolicy),
		await ctx.db.select().from(schedule),
	);
	await syncCleanupScheduler(ctx.queues, await loadCleanup(ctx.db));
	for (const p of await ctx.db.select().from(patchPolicy))
		await syncPatchWindow(ctx.queues, p.organizationId, p);
	// Not tied to the reconcile interval: a deployment awaiting checks must always be able to move on.
	await ctx.queues.maintenance.upsertJobScheduler(
		"checks-every",
		{ every: CHECKS_POLL_MS },
		{ name: "checks" },
	);
	await ctx.queues.maintenance.upsertJobScheduler(
		"work-recurrence-every",
		{ every: 3_600_000 },
		{ name: "work-recurrence" },
	);
	// Port forwards must close at their expiry whatever the reconcile interval is.
	await ctx.queues.maintenance.upsertJobScheduler(
		"db-access-every",
		{ every: 30_000 },
		{ name: "db-access" },
	);
	await ctx.queues.maintenance.upsertJobScheduler(
		"plugins-every",
		{ every: 30_000 },
		{ name: "plugins" },
	);

	// Uptime checks are due whatever the reconcile interval; Postgres says which.
	await ctx.queues.uptime.upsertJobScheduler(
		UPTIME_TICK_SCHEDULER,
		{ every: UPTIME_TICK_MS },
		{
			name: "tick",
			data: { name: "tick" },
			opts: { removeOnComplete: true, removeOnFail: 50 },
		},
	);

	if (cfg.LS_RECONCILE_INTERVAL_MS > 0) {
		const every = cfg.LS_RECONCILE_INTERVAL_MS;
		await ctx.queues.reconcile.upsertJobScheduler("reconcile-every", { every });
		await ctx.queues.proxy.upsertJobScheduler("proxy-every", { every });
		await ctx.queues.maintenance.upsertJobScheduler("orphans-every", {
			every: Math.max(every, 60_000),
		});
		await ctx.queues.maintenance.upsertJobScheduler(
			"certificates-every",
			{ every: 15 * 60_000 },
			{ name: "certificates" },
		);
		await ctx.queues.maintenance.upsertJobScheduler(
			"previews-every",
			{ every: 15 * 60_000 },
			{ name: "previews" },
		);
		// Re-reads external secrets so a value changed in the provider shows as a pending change.
		await ctx.queues.maintenance.upsertJobScheduler(
			"external-secrets-every",
			{ every: 15 * 60_000 },
			{ name: "external-secrets" },
		);
		await ctx.queues.maintenance.upsertJobScheduler(
			"retention-every",
			{ every: 3_600_000 },
			{ name: "retention" },
		);
		await ctx.queues.scan.upsertJobScheduler(
			"scan-daily",
			{ every: 86_400_000 },
			{ name: "all", data: { all: true } },
		);
		await ctx.queues.maintenance.upsertJobScheduler(
			"patch-scan-every",
			{ every: 6 * 3_600_000 },
			{ name: "patch-scan" },
		);
		await ctx.queues.maintenance.upsertJobScheduler(
			"update-check-every",
			{ every: 86_400_000 },
			{ name: "update-check" },
		);
	}

	ctx.bus.onEvent(notify.onEvent);
	const stopSyncRequests = await listenForSyncRequests(ctx);

	ctx.bus.onEvent((e) => {
		reportCommitStatus(ctx, e).catch((err) =>
			log("warn", "commit status not reported", {
				deploymentId: e.resource.id,
				error: String(err),
			}),
		);
		onEvent(ctx, e).catch((err) =>
			log("error", "event handler failed", {
				type: e.type,
				error: String(err),
			}),
		);
	});
	const events = new AbortController();
	void followDocker(ctx, events.signal);
	const stopMonitoring = await startMonitoring(ctx);

	// A master key rotation: re-encrypt to the new key before anything writes more under the old one.
	if (cfg.LOGISTACK_MASTER_KEY_PREVIOUS) {
		// Pinned under the previous key's derivation before anything re-derives it.
		await caddyStorageKey(ctx).catch(() => undefined);
		await rotateMasterKey(
			ctx.db,
			cfg.LOGISTACK_MASTER_KEY,
			cfg.LOGISTACK_MASTER_KEY_PREVIOUS,
		)
			.then((r) =>
				log(
					r.unreadable ? "error" : "info",
					r.unreadable
						? "master key rotation left values that neither key opens"
						: "master key rotation finished: LOGISTACK_MASTER_KEY_PREVIOUS can be removed",
					r,
				),
			)
			.catch((e) =>
				log("error", "master key rotation failed", {
					error: e instanceof Error ? e.message : String(e),
				}),
			);
	}
	// Secret variables from before managed secrets become secrets plus references.
	await convertLegacySecrets(ctx)
		.then((n) => n && log("info", "converted secret variables", { count: n }))
		.catch((e) =>
			log("error", "secret conversion failed", {
				error: e instanceof Error ? e.message : String(e),
			}),
		);
	// Boot: anything left mid-flight by a dead worker is resumed (deploying) or failed (building).
	const stranded = await ctx.db
		.selectDistinct({ serviceId: deployment.serviceId })
		.from(deployment)
		.where(notInArray(deployment.status, terminal));
	for (const s of stranded) await enqueueDeploy(ctx.queues, s.serviceId);
	await enqueueProxySync(ctx.queues, "boot");
	for (const name of [ctx.cfg.LS_DB_NETWORK, ctx.cfg.LS_GAME_NETWORK])
		await ensureStackNetwork(ctx, name).catch((e) =>
			log("error", "could not attach a shared network", {
				network: name,
				error: e instanceof Error ? e.message : String(e),
			}),
		);
	log("info", "worker started", { resumed: stranded.length });

	return {
		ctx,
		async stop() {
			abortAll("shutdown");
			events.abort();
			await stopMonitoring();
			stopSyncRequests();
			schedules.close();
			await Promise.all(workers.map((w) => w.close()));
			await Promise.all(Object.values(ctx.queues).map((q) => q.close()));
			ctx.bus.close();
			ctx.nodes.close();
			await ctx.db.$client.end();
			log("info", "worker stopped");
		},
	};
}

if (import.meta.main) {
	const running = await startWorker(loadConfig());
	// The image's HEALTHCHECK reads this file's age: a started worker with a live event loop.
	const beat = () => Bun.write(HEARTBEAT, String(Date.now()));
	await beat();
	setInterval(beat, 5_000);
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await running.stop();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
