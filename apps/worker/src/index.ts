import {
	BACKUP_QUEUE,
	type BackupJob,
	type EventEnvelope,
	MIGRATION_QUEUE,
	type MigrationJob,
	SCHEDULE_QUEUE,
	type ScheduleJob,
} from "@logistack/contracts";
import { importMasterKey } from "@logistack/core";
import { backupPolicy, createDb, deployment, schedule } from "@logistack/db";
import { createDockerClient, type DockerEvent } from "@logistack/docker";
import { coalesce } from "@logistack/proxy";
import { type Job, Worker } from "bullmq";
import { eq, notInArray } from "drizzle-orm";
import { ensureStackDbNetwork } from "./apply.ts";
import { processBackupJob } from "./backups.ts";
import { createBus, log, setLogLevel } from "./bus.ts";
import { checkCertificates } from "./certs.ts";
import { CHECKS_POLL_MS, pollChecks } from "./checks.ts";
import { loadCleanup, runCleanup } from "./cleanup.ts";
import { reportCommitStatus } from "./commit-status.ts";
import { type Config, loadConfig } from "./config.ts";
import { unfreeze } from "./coolify.ts";
import type { Ctx } from "./ctx.ts";
import { decommission } from "./decommission.ts";
import { abortAll, cancelRunning, processService, terminal } from "./deploy.ts";
import { checkForUpdate } from "./instance-update.ts";
import { syncLocalRegistry } from "./local-registry.ts";
import { cutOver, rollBack } from "./migration.ts";
import { startMonitoring } from "./monitoring.ts";
import { createNodeRunner } from "./node-runner.ts";
import { notifier } from "./notify.ts";
import { listenForSyncRequests, syncProxy } from "./proxy.ts";
import { switchProxy } from "./proxy-switch.ts";
import {
	createQueues,
	enqueueDeploy,
	enqueueProxySync,
	enqueueReconcile,
	redisConnection,
} from "./queues.ts";
import { reconcilePass, sweepOrphans } from "./reconcile.ts";
import { pruneImages } from "./retention.ts";
import {
	type RunQueues,
	syncAllSchedulers,
	syncCleanupScheduler,
} from "./schedulers.ts";
import { createScheduleRunner } from "./schedules.ts";
import { syncTunnels } from "./tunnels.ts";

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
		masterKey: await importMasterKey(cfg.LOGISTACK_MASTER_KEY),
		queues: createQueues(connection),
		nodes: await createNodeRunner(cfg.REDIS_URL),
	};
	const failed = (queue: string) => (job: Job | undefined, err: Error) =>
		log("error", "job failed", { queue, jobId: job?.id, error: err.message });

	const schedules = await createScheduleRunner(ctx);
	const proxySync = coalesce(async () => {
		await syncProxy(ctx);
		// After Caddy: a tunnel hostname should already route when Cloudflare starts sending it.
		await syncTunnels(ctx).catch((e: unknown) =>
			log("warn", "tunnel sync failed", { error: String(e) }),
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
				else if (job.name === "update-check") await checkForUpdate(ctx);
				else if (job.name === "cleanup") await runCleanup(ctx);
				else if (job.name === "checks") await pollChecks(ctx);
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
	// Not tied to the reconcile interval: a deployment awaiting checks must always be able to move on.
	await ctx.queues.maintenance.upsertJobScheduler(
		"checks-every",
		{ every: CHECKS_POLL_MS },
		{ name: "checks" },
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
			"retention-every",
			{ every: 3_600_000 },
			{ name: "retention" },
		);
		await ctx.queues.maintenance.upsertJobScheduler(
			"update-check-every",
			{ every: 86_400_000 },
			{ name: "update-check" },
		);
	}

	const notify = notifier(ctx);
	ctx.bus.onEvent(notify);
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

	// Boot: anything left mid-flight by a dead worker is resumed (deploying) or failed (building).
	const stranded = await ctx.db
		.selectDistinct({ serviceId: deployment.serviceId })
		.from(deployment)
		.where(notInArray(deployment.status, terminal));
	for (const s of stranded) await enqueueDeploy(ctx.queues, s.serviceId);
	await enqueueProxySync(ctx.queues, "boot");
	await ensureStackDbNetwork(ctx).catch((e) =>
		log("error", "could not attach the database network", {
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
