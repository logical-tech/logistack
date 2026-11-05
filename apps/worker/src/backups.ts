import {
	type BackupJob,
	backupRunChannel,
	type DatabaseEngine,
	LIVE_CHANNEL,
	type LiveMessage,
} from "@logistack/contracts";
import {
	DUMP_EXTENSION,
	databaseImage,
	decrypt,
	dockerName,
	dumpScript,
	newId,
	restoreScript,
	storageEngineDefs,
} from "@logistack/core";
import {
	adoptedVolume,
	backupPolicy,
	backupRun,
	environment,
	instanceSettings,
	node,
	project,
	s3Destination,
	service,
} from "@logistack/db";
import {
	LABEL_KIND,
	LABEL_MANAGED,
	LABEL_ORG,
	LABEL_RESOURCE,
	type Mount,
} from "@logistack/docker";
import {
	instantiate,
	type S3Destination,
	s3Destination as s3Provider,
	selectForDeletion,
} from "@logistack/providers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { upsertService } from "./apply.ts";
import {
	judgeSanity,
	readyScript,
	sanityScript,
	VERIFY_DATA_DIR,
	VERIFY_ENV,
	VOLUME_EXTENSION,
	verifyRestoreScript,
	volumeBackupScript,
	volumeRestoreScript,
} from "./backup-scripts.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { svcName } from "./load.ts";
import { feed, tail } from "./node-runner.ts";
import { publicAddress } from "./ssrf.ts";

// Backups, verify restores and restores. Every byte goes node -> agent -> bridge -> this
// process -> S3 multipart (or back), hashed on the way; nothing touches the control plane's disk.

const JOB_TIMEOUT_S = 6 * 3600;
const PAUSE_KEY = (serviceId: string) => `ls:backup:paused:${serviceId}`;

type Policy = typeof backupPolicy.$inferSelect;
type Run = typeof backupRun.$inferSelect;
type ServiceRow = typeof service.$inferSelect;

const body = (id: string) => id.slice(id.indexOf("_") + 1);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export async function publishLive(ctx: Ctx, msg: LiveMessage) {
	await ctx.bus.redis.publish(LIVE_CHANNEL, JSON.stringify(msg));
}

/** Publishes at most every 500 ms, plus the final call. */
function progress(ctx: Ctx, runId: string, total: number | null) {
	let last = 0;
	return (phase: string, bytes: number, done = false) => {
		const now = Date.now();
		if (!done && now - last < 500) return;
		last = now;
		void publishLive(ctx, {
			kind: "progress",
			channel: backupRunChannel(runId),
			phase,
			bytes,
			total,
			done,
		}).catch(() => {});
	};
}

/** The destination with its secret decrypted; the endpoint must pass the SSRF policy. */
export async function openDestination(
	ctx: Ctx,
	id: string,
): Promise<S3Destination> {
	const [d] = await ctx.db
		.select()
		.from(s3Destination)
		.where(eq(s3Destination.id, id));
	if (!d) throw new Error(`S3 destination ${id} is gone`);
	const config = {
		endpoint: d.endpoint,
		region: d.region,
		bucket: d.bucket,
		prefix: d.prefix,
		accessKeyId: d.accessKeyId,
		secretAccessKey: await decrypt(ctx.masterKey, d.secretEncrypted),
		forcePathStyle: d.forcePathStyle,
	};
	// A LogiStack storage service: the endpoint is derived from its id on the storage network, never read from the row.
	if (d.storageServiceId) {
		const [svc] = await ctx.db
			.select({ spec: service.spec })
			.from(service)
			.where(eq(service.id, d.storageServiceId));
		if (svc?.spec.kind !== "storage")
			throw new Error(`S3 destination ${id}: its storage service is gone`);
		const port = storageEngineDefs[svc.spec.engine].s3Port;
		return instantiate(s3Provider, {
			...config,
			endpoint: `http://${svcName(ctx, d.storageServiceId)}:${port}`,
			forcePathStyle: true,
		});
	}
	const url = new URL(d.endpoint);
	const [settings] = await ctx.db
		.select({ allow: instanceSettings.allowPrivateHosts })
		.from(instanceSettings);
	if (url.protocol !== "https:" && !settings?.allow)
		throw new Error("only https S3 endpoints are allowed");
	// shortcut: checked, not pinned; Bun's S3Client takes no custom fetch.
	await publicAddress(ctx, url.hostname);
	return instantiate(s3Provider, config);
}

/** The service's oldest running task and its node; Swarm marks a task running only once healthy. */
export async function locateTask(
	ctx: Ctx,
	serviceId: string,
): Promise<{ nodeId: string; taskId: string } | undefined> {
	const tasks = await ctx.docker.tasks
		.list({ service: [svcName(ctx, serviceId)], "desired-state": ["running"] })
		.catch(() => []);
	const t = tasks
		.filter((t) => t.Status.State === "running" && t.NodeID)
		.sort((a, b) => (a.CreatedAt < b.CreatedAt ? -1 : 1))[0];
	return t?.NodeID ? { nodeId: t.NodeID, taskId: t.ID } : undefined;
}

async function waitForTask(ctx: Ctx, serviceId: string, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const t = await locateTask(ctx, serviceId);
		if (t) return t;
		if (Date.now() > deadline)
			throw new Error(
				`service ${serviceId} has no running task after ${timeoutMs / 1000}s`,
			);
		await Bun.sleep(1000);
	}
}

/** Where the volume's data lives: the running task's node, else the node the service is pinned to. */
async function volumeNode(ctx: Ctx, svc: ServiceRow): Promise<string> {
	const t = await locateTask(ctx, svc.id);
	if (t) return t.nodeId;
	const live = await ctx.docker.services
		.inspect(svcName(ctx, svc.id))
		.catch(() => undefined);
	const pinned = live?.Spec.TaskTemplate.Placement?.Constraints?.find((c) =>
		c.startsWith("node.id=="),
	);
	if (pinned) return pinned.slice("node.id==".length);
	if (svc.nodeId) {
		const [n] = await ctx.db
			.select({ swarm: node.swarmNodeId })
			.from(node)
			.where(eq(node.id, svc.nodeId));
		if (n) return n.swarm;
	}
	throw new Error("cannot tell which node holds the volume");
}

/** Docker name of the volume a policy reads: a mount's, or a database's data directory. */
/** The Docker volume of an owner (mount or service id): the adopted one, else the one we name. */
async function volumeDockerName(ctx: Ctx, volumeOwnerId: string) {
	const [adopted] = await ctx.db
		.select({ name: adoptedVolume.volumeName })
		.from(adoptedVolume)
		.where(eq(adoptedVolume.ownerId, volumeOwnerId));
	return (
		adopted?.name ??
		`${ctx.cfg.LS_NAME_PREFIX}${dockerName("vol", volumeOwnerId)}`
	);
}

function labels(ctx: Ctx, orgId: string, resource: string, kind: string) {
	return {
		[LABEL_MANAGED]: "true",
		[LABEL_RESOURCE]: resource,
		[LABEL_KIND]: kind,
		[LABEL_ORG]: orgId,
		...ctx.cfg.LS_SCOPE_LABELS,
	};
}

/** Scales the service to zero for `fn`, keeping the reconciler off it, then back. */
async function paused<T>(
	ctx: Ctx,
	svc: ServiceRow,
	runId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const name = svcName(ctx, svc.id);
	const live = await ctx.docker.services.inspect(name).catch(() => undefined);
	const mode = live?.Spec.Mode;
	const replicas =
		mode && "Replicated" in mode ? (mode.Replicated.Replicas ?? 1) : 0;
	if (!live || replicas === 0) return fn();
	await ctx.bus.redis.send("SET", [
		PAUSE_KEY(svc.id),
		runId,
		"PX",
		String(JOB_TIMEOUT_S * 1000),
	]);
	const scale = (n: number) =>
		upsertService(ctx, undefined, live.Spec, (current) => ({
			...current.Spec,
			Mode: { Replicated: { Replicas: n } },
		}));
	try {
		await scale(0);
		for (let i = 0; i < 120; i++) {
			const tasks = await ctx.docker.tasks.list({ service: [name] });
			if (!tasks.some((t) => t.Status.State === "running")) break;
			await Bun.sleep(500);
		}
		return await fn();
	} finally {
		await scale(replicas).catch((e) =>
			log("error", "could not scale the service back after a backup", {
				serviceId: svc.id,
				error: errMsg(e),
			}),
		);
		await ctx.bus.redis.del(PAUSE_KEY(svc.id));
	}
}

/** Services a backup or restore paused; the reconciler leaves their replica count alone. */
export async function pausedServices(
	ctx: Ctx,
	ids: string[],
): Promise<Set<string>> {
	if (!ids.length) return new Set();
	const vals = (await ctx.bus.redis.send("MGET", ids.map(PAUSE_KEY))) as (
		| string
		| null
	)[];
	return new Set(ids.filter((_, i) => vals[i]));
}

/**
 * A one-off Swarm service pinned to `nodeId`, for work that needs stdin streamed into a
 * container the agent can exec into: a verify database, or a volume restore.
 */
async function withHelper<T>(
	ctx: Ctx,
	o: {
		runId: string;
		orgId: string;
		kind: string;
		nodeId: string;
		image: string;
		env?: string[];
		mounts: Mount[];
		command?: string[];
	},
	fn: (swarmServiceId: string) => Promise<T>,
): Promise<T> {
	const name = `${ctx.cfg.LS_NAME_PREFIX}ls-${o.kind}-${body(o.runId)}`;
	const l = labels(ctx, o.orgId, o.runId, o.kind);
	const { ID } = await ctx.docker.services.create({
		Name: name,
		Labels: l,
		TaskTemplate: {
			ContainerSpec: {
				Image: o.image,
				Labels: l,
				Env: o.env ?? [],
				Mounts: o.mounts,
				...(o.command ? { Command: o.command } : {}),
			},
			Placement: { Constraints: [`node.id==${o.nodeId}`] },
			RestartPolicy: { Condition: "none" },
		},
		Mode: { Replicated: { Replicas: 1 } },
	});
	try {
		const deadline = Date.now() + 180_000;
		for (;;) {
			const tasks = await ctx.docker.tasks.list({ service: [ID] });
			if (tasks.some((t) => t.Status.State === "running")) break;
			const dead = tasks.find((t) =>
				["failed", "rejected", "complete", "shutdown"].includes(t.Status.State),
			);
			if (dead)
				throw new Error(
					`${o.kind} container did not start: ${dead.Status.Err ?? dead.Status.Message}`,
				);
			if (Date.now() > deadline)
				throw new Error(`${o.kind} container not running after 180s`);
			await Bun.sleep(500);
		}
		return await fn(ID);
	} finally {
		await ctx.docker.services.remove(ID).catch(() => {});
	}
}

/** Runs a short script in a container and returns stdout; throws with stderr on a non-zero exit. */
async function script(
	ctx: Ctx,
	nodeId: string,
	target:
		| { kind: "task"; taskId: string }
		| { kind: "service"; serviceId: string },
	text: string,
	timeoutSec = 300,
): Promise<string> {
	const job = ctx.nodes.runJob(nodeId, {
		kind: "exec",
		target,
		cmd: ["sh"],
		script: text,
		timeoutSec,
	});
	let out = "";
	let err = "";
	const dec = new TextDecoder();
	for await (const c of job)
		if (c.stream === "stdout") out += dec.decode(c.data, { stream: true });
		else err += dec.decode(c.data, { stream: true });
	const r = await job.result;
	if (r.exitCode !== 0)
		throw new Error(
			`exit ${r.exitCode}: ${tail(err.trim() || out.trim(), 600)}`,
		);
	return out;
}

type Loaded = {
	policy: Policy;
	svc: ServiceRow;
	orgId: string;
};

async function load(ctx: Ctx, policyId: string): Promise<Loaded | undefined> {
	const [row] = await ctx.db
		.select({
			policy: backupPolicy,
			svc: service,
			orgId: project.organizationId,
		})
		.from(backupPolicy)
		.innerJoin(service, eq(service.id, backupPolicy.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(eq(backupPolicy.id, policyId));
	return row;
}

const engineOf = (svc: ServiceRow): DatabaseEngine => {
	if (svc.spec.kind !== "database")
		throw new Error(`service ${svc.id} is not a database`);
	return svc.spec.engine;
};
const engineImage = (svc: ServiceRow) => {
	if (svc.spec.kind !== "database") throw new Error("not a database");
	return databaseImage(svc.spec.engine, svc.spec.version);
};

function stamp(d: Date) {
	return d.toISOString().replace(/[:.]/g, "-");
}

/** Dumps or archives, streaming into a multipart upload; returns size and checksum. */
async function backup(ctx: Ctx, l: Loaded, run: Run) {
	const { policy, svc } = l;
	const dest = await openDestination(ctx, policy.s3DestinationId);
	const isVolume = policy.target === "volume";
	const ext = isVolume ? VOLUME_EXTENSION : DUMP_EXTENSION[engineOf(svc)];
	const key = `backups/${policy.id}/${stamp(run.startedAt)}-${run.id}.${ext}`;
	const tick = progress(ctx, run.id, null);

	const start = async () => {
		if (!isVolume) {
			const t = await locateTask(ctx, svc.id);
			if (!t) throw new Error("the database has no running task to dump");
			return ctx.nodes.runJob(t.nodeId, {
				kind: "exec",
				target: { kind: "task", taskId: t.taskId },
				cmd: ["sh"],
				script: dumpScript(engineOf(svc)),
				timeoutSec: JOB_TIMEOUT_S,
				outputLimitBytes: Number.MAX_SAFE_INTEGER,
			});
		}
		const nodeId = await volumeNode(ctx, svc);
		return ctx.nodes.runJob(nodeId, {
			kind: "container",
			image: ctx.cfg.LS_BACKUP_TOOLS_IMAGE,
			containerName: `${ctx.cfg.LS_NAME_PREFIX}ls-bkp-${body(run.id)}`,
			labels: labels(ctx, l.orgId, run.id, "backup"),
			mounts: [
				{
					type: "volume",
					source: await volumeDockerName(ctx, policy.volumeName ?? ""),
					target: "/data",
					readOnly: true,
				},
			],
			script: volumeBackupScript,
			timeoutSec: JOB_TIMEOUT_S,
			outputLimitBytes: Number.MAX_SAFE_INTEGER,
		});
	};

	const go = async () => {
		const job = await start();
		const hash = new Bun.CryptoHasher("sha256");
		let size = 0;
		let stderr = "";
		const dec = new TextDecoder();
		const it = job[Symbol.asyncIterator]();
		const stream = new ReadableStream<Uint8Array>({
			async pull(c) {
				for (;;) {
					const { value, done } = await it.next();
					if (done) return c.close();
					if (value.stream === "stderr") {
						stderr = tail(stderr + dec.decode(value.data, { stream: true }));
						continue;
					}
					hash.update(value.data);
					size += value.data.byteLength;
					tick("uploading", size);
					c.enqueue(value.data);
					return;
				}
			},
			async cancel() {
				await it.return?.();
			},
		});
		try {
			await dest.upload(key, stream, {
				contentType: "application/octet-stream",
			});
			const r = await job.result;
			if (r.exitCode !== 0)
				throw new Error(
					`dump exited with ${r.exitCode}: ${stderr.trim() || "no output on stderr"}`,
				);
			if (size === 0) throw new Error("the dump was empty");
		} catch (e) {
			await dest.delete(key).catch(() => {});
			throw e;
		}
		tick("done", size, true);
		return { key, size, checksum: `sha256:${hash.digest("hex")}`, dest };
	};
	return isVolume && policy.pauseService ? paused(ctx, svc, run.id, go) : go();
}

/** Deletes what the policy no longer keeps under its own prefix; returns the deleted keys. */
export async function applyRetention(
	ctx: Ctx,
	policy: Policy,
	dest: S3Destination,
	now = new Date(),
): Promise<string[]> {
	const objects = await dest.list(`backups/${policy.id}/`);
	const doomed = selectForDeletion(objects, policy.retention, now);
	for (const o of doomed) {
		await dest.delete(o.key);
		await ctx.db
			.update(backupRun)
			.set({ prunedAt: now })
			.where(
				and(eq(backupRun.policyId, policy.id), eq(backupRun.objectKey, o.key)),
			);
	}
	return doomed.map((o) => o.key);
}

async function sourceRun(ctx: Ctx, policyId: string, id?: string) {
	const [r] = await ctx.db
		.select()
		.from(backupRun)
		.where(
			id
				? eq(backupRun.id, id)
				: and(
						eq(backupRun.policyId, policyId),
						eq(backupRun.kind, "backup"),
						eq(backupRun.status, "succeeded"),
						isNull(backupRun.prunedAt),
					),
		)
		.orderBy(desc(backupRun.startedAt))
		.limit(1);
	if (!r?.objectKey || r.prunedAt)
		throw new Error(
			"no backup to read: none succeeded yet, or retention deleted it",
		);
	return r as Run & { objectKey: string };
}

/** Restores the newest backup into a throwaway database on the service's node and queries it. */
async function verify(ctx: Ctx, l: Loaded, run: Run, sourceId?: string) {
	const { svc, policy } = l;
	const engine = engineOf(svc);
	const src = await sourceRun(ctx, policy.id, sourceId);
	await ctx.db
		.update(backupRun)
		.set({ sourceRunId: src.id })
		.where(eq(backupRun.id, run.id));
	const dest = await openDestination(ctx, policy.s3DestinationId);
	const nodeId =
		(await locateTask(ctx, svc.id))?.nodeId ?? (await volumeNode(ctx, svc));
	const tick = progress(ctx, run.id, src.sizeBytes);
	return withHelper(
		ctx,
		{
			runId: run.id,
			orgId: l.orgId,
			kind: "vfy",
			nodeId,
			image: engineImage(svc),
			env: VERIFY_ENV[engine],
			mounts: [{ Type: "tmpfs", Target: VERIFY_DATA_DIR[engine] }],
		},
		async (helperId) => {
			const target = { kind: "service" as const, serviceId: helperId };
			tick("starting", 0, true);
			await script(ctx, nodeId, target, readyScript(engine), 200);
			const exec = ctx.nodes.exec(
				nodeId,
				{ target, cmd: ["sh", "-c", verifyRestoreScript(engine)], stdin: true },
				{ timeoutMs: JOB_TIMEOUT_S * 1000 },
			);
			await feed(exec, dest.download(src.objectKey), (b) =>
				tick("restoring", b),
			);
			const sanity = judgeSanity(
				engine,
				await script(ctx, nodeId, target, sanityScript(engine)),
			);
			if (!sanity.ok) throw new Error(sanity.detail);
			tick("done", src.sizeBytes ?? 0, true);
			return sanity.detail;
		},
	);
}

async function restore(ctx: Ctx, l: Loaded, run: Run, job: BackupJob) {
	const { policy } = l;
	const src = await sourceRun(ctx, policy.id, job.sourceRunId);
	const dest = await openDestination(ctx, policy.s3DestinationId);
	const tick = progress(ctx, run.id, src.sizeBytes);
	const targetId = job.targetServiceId ?? policy.serviceId;
	const [target] = await ctx.db
		.select()
		.from(service)
		.where(eq(service.id, targetId));
	if (!target) throw new Error("the target service is gone");

	if (policy.target === "database") {
		tick("waiting for the database", 0, true);
		const t = await waitForTask(ctx, target.id, 10 * 60_000);
		const engine = engineOf(target);
		await script(
			ctx,
			t.nodeId,
			{ kind: "task", taskId: t.taskId },
			readyScript(engine),
			200,
		);
		const exec = ctx.nodes.exec(
			t.nodeId,
			{
				target: { kind: "task", taskId: t.taskId },
				cmd: ["sh", "-c", restoreScript(engine)],
				stdin: true,
			},
			{ timeoutMs: JOB_TIMEOUT_S * 1000 },
		);
		await feed(exec, dest.download(src.objectKey), (b) => tick("restoring", b));
		tick("done", src.sizeBytes ?? 0, true);
		return `Restored into ${target.name}`;
	}

	const nodeId = await volumeNode(ctx, target);
	const volume = job.newVolume
		? `${ctx.cfg.LS_NAME_PREFIX}ls-vol-${body(run.id)}`
		: await volumeDockerName(ctx, policy.volumeName ?? "");
	const write = () =>
		withHelper(
			ctx,
			{
				runId: run.id,
				orgId: l.orgId,
				kind: "rst",
				nodeId,
				image: ctx.cfg.LS_BACKUP_TOOLS_IMAGE,
				command: ["sleep", String(JOB_TIMEOUT_S)],
				mounts: [
					{
						Type: "volume",
						Source: volume,
						Target: "/data",
						VolumeOptions: {
							Labels: labels(
								ctx,
								l.orgId,
								job.newVolume ? run.id : (policy.volumeName ?? ""),
								"volume",
							),
						},
					},
				],
			},
			async (helperId) => {
				const exec = ctx.nodes.exec(
					nodeId,
					{
						target: { kind: "service", serviceId: helperId },
						cmd: ["sh", "-c", volumeRestoreScript],
						stdin: true,
					},
					{ timeoutMs: JOB_TIMEOUT_S * 1000 },
				);
				await feed(exec, dest.download(src.objectKey), (b) =>
					tick("restoring", b),
				);
			},
		);
	// Writing over a live volume would race the service; a new volume has no writer.
	if (job.newVolume) await write();
	else await paused(ctx, target, run.id, write);
	tick("done", src.sizeBytes ?? 0, true);
	return job.newVolume
		? `Restored into volume ${volume}`
		: `Restored ${target.name}'s volume`;
}

/** The row for this job: the api's (run now, restore) or a new one for a scheduler tick. */
async function claimRow(ctx: Ctx, job: BackupJob): Promise<Run> {
	if (job.runId) {
		const [r] = await ctx.db
			.select()
			.from(backupRun)
			.where(eq(backupRun.id, job.runId));
		if (r) return r;
	}
	const [r] = await ctx.db
		.insert(backupRun)
		.values({
			id: job.runId ?? newId("bkr"),
			policyId: job.policyId,
			kind: job.kind,
			sourceRunId: job.sourceRunId ?? null,
			targetServiceId: job.targetServiceId ?? null,
		})
		.onConflictDoNothing()
		.returning();
	if (r) return r;
	const [again] = await ctx.db
		.select()
		.from(backupRun)
		.where(eq(backupRun.id, job.runId ?? ""));
	if (!again) throw new Error("backup run row vanished");
	return again;
}

/** BullMQ processor for the `backup` queue. Never throws: the outcome lives on the run row. */
export async function processBackupJob(
	ctx: Ctx,
	job: BackupJob,
	updateData?: (d: BackupJob) => Promise<void>,
): Promise<Run | undefined> {
	const l = await load(ctx, job.policyId);
	if (!l) return;
	if (!job.runId && !l.policy.enabled) return;
	if (!job.runId) {
		job = { ...job, runId: newId("bkr") };
		// A stalled job that runs again then finds its row instead of starting a second one.
		await updateData?.(job);
	}
	const run = await claimRow(ctx, job);
	if (run.status !== "running") return run;
	const started = Date.now();
	let patch: Partial<Run>;
	try {
		if (job.kind === "backup") {
			const { key, size, checksum, dest } = await backup(ctx, l, run);
			patch = {
				status: "succeeded",
				objectKey: key,
				sizeBytes: size,
				checksum,
			};
			const pruned = await applyRetention(ctx, l.policy, dest).catch((e) => {
				log("warn", "retention failed", {
					policyId: l.policy.id,
					error: errMsg(e),
				});
				return [];
			});
			if (pruned.length)
				patch.detail = `Retention deleted ${pruned.length} older backup${pruned.length === 1 ? "" : "s"}`;
		} else if (job.kind === "verify") {
			patch = {
				status: "succeeded",
				detail: await verify(ctx, l, run, job.sourceRunId),
			};
		} else {
			patch = { status: "succeeded", detail: await restore(ctx, l, run, job) };
		}
	} catch (e) {
		patch = { status: "failed", error: tail(errMsg(e), 4000) };
		void publishLive(ctx, {
			kind: "progress",
			channel: backupRunChannel(run.id),
			phase: "failed",
			bytes: 0,
			total: null,
			done: true,
		}).catch(() => {});
	}
	const [done] = await ctx.db
		.update(backupRun)
		.set({ ...patch, finishedAt: new Date() })
		.where(eq(backupRun.id, run.id))
		.returning();
	await ctx.bus
		.publish(
			patch.status === "succeeded" ? "backup.succeeded" : "backup.failed",
			l.orgId,
			{ type: "backup_run", id: run.id },
			{
				serviceId: l.svc.id,
				serviceName: l.svc.name,
				policyId: l.policy.id,
				kind: job.kind,
				sizeBytes: patch.sizeBytes ?? null,
				error: patch.error ?? null,
				durationMs: Date.now() - started,
			},
		)
		.catch(() => {});
	log(
		patch.status === "succeeded" ? "info" : "warn",
		`backup ${job.kind} ${patch.status}`,
		{
			runId: run.id,
			policyId: l.policy.id,
			error: patch.error,
		},
	);
	return done;
}
