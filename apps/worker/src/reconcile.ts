import type { CrashLoop, ObservedState } from "@logistack/contracts";
import { isTerminal, scaledReplicas } from "@logistack/core";
import {
	deployment,
	environment,
	mount,
	project,
	service,
	serviceAutoscale,
	serviceStatus,
} from "@logistack/db";
import {
	DockerError,
	type Filters,
	LABEL_DISPOSABLE,
	LABEL_KIND,
	LABEL_RESOURCE,
	managedFilters,
	managedLabels,
	type Service,
	type Task,
	type UpdateState,
} from "@logistack/docker";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
	desiredSpec,
	ensureEnvNetwork,
	inspectService,
	upsertService,
} from "./apply.ts";
import { pausedServices } from "./backups.ts";
import { log, withLock } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import { loadService, svcName } from "./load.ts";
import { enqueueDeploy } from "./queues.ts";

const STARTING = new Set<Task["Status"]["State"]>([
	"new",
	"allocated",
	"pending",
	"assigned",
	"accepted",
	"preparing",
	"ready",
	"starting",
]);

/** Pure: the observed state shown next to the desired one. */
export function observe(o: {
	exists: boolean;
	desired: number;
	tasks: Pick<Task, "DesiredState" | "Status">[];
	updateState?: UpdateState;
}): { observed: ObservedState; running: number } {
	const live = o.tasks.filter((t) => t.DesiredState === "running");
	const running = live.filter((t) => t.Status.State === "running").length;
	if (!o.exists) return { observed: "unknown", running: 0 };
	if (o.desired === 0) return { observed: "stopped", running };
	if (running >= o.desired) return { observed: "running", running };
	if (live.some((t) => STARTING.has(t.Status.State)))
		return { observed: "starting", running };
	if (o.updateState?.startsWith("rollback") || o.updateState === "paused")
		return { observed: "unhealthy", running };
	return { observed: "failed", running };
}

const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_FAILURES = 3;

/**
 * Pure: the crash loop Swarm's task history shows at `now`. It starts at `CRASH_FAILURES`
 * failed or rejected tasks inside the window and lasts until the window holds none, so a
 * service hovering at the edge does not flap. `since` carries over from `prev`.
 */
export function crashLoop(
	tasks: Pick<Task, "Status">[],
	prev: CrashLoop | null,
	now: number,
): CrashLoop | null {
	const failed = tasks
		.filter(
			(t) =>
				(t.Status.State === "failed" || t.Status.State === "rejected") &&
				now - Date.parse(t.Status.Timestamp) < CRASH_WINDOW_MS,
		)
		.sort(
			(a, b) => Date.parse(b.Status.Timestamp) - Date.parse(a.Status.Timestamp),
		);
	const last = failed[0];
	if (!last || failed.length < (prev ? 1 : CRASH_FAILURES)) return null;
	return {
		since: prev?.since ?? new Date(now).toISOString(),
		failures: failed.length,
		reason: last.Status.Err || last.Status.Message,
		exitCode: last.Status.ContainerStatus?.ExitCode ?? null,
	};
}

const scopedFilters = (ctx: Ctx): Filters => {
	const f = managedFilters();
	for (const [k, v] of Object.entries(scope(ctx).labels))
		f.label?.push(`${k}=${v}`);
	return f;
};

const desiredReplicas = (
	row: typeof service.$inferSelect,
	scaled: number | undefined,
) =>
	row.desiredState === "stopped"
		? 0
		: row.spec.kind === "application"
			? (scaled ?? row.spec.replicas)
			: 1;

async function writeStatus(
	ctx: Ctx,
	row: typeof service.$inferSelect,
	organizationId: string,
	svc: Service | undefined,
	scaled: number | undefined,
) {
	const name = svcName(ctx, row.id);
	const tasks = svc ? await ctx.docker.tasks.list({ service: [name] }) : [];
	const desired = desiredReplicas(row, scaled);
	const { observed, running } = observe({
		exists: !!svc,
		desired,
		tasks,
		...(svc?.UpdateStatus ? { updateState: svc.UpdateStatus.State } : {}),
	});
	const taskView = tasks
		.filter((t) => t.DesiredState === "running")
		.map((t) => ({
			id: t.ID,
			slot: t.Slot ?? null,
			nodeId: t.NodeID ?? null,
			state: t.Status.State,
			message: t.Status.Message,
			error: t.Status.Err ?? null,
			at: t.Status.Timestamp,
		}));
	const [prev] = await ctx.db
		.select()
		.from(serviceStatus)
		.where(eq(serviceStatus.serviceId, row.id));
	const loop =
		desired > 0 ? crashLoop(tasks, prev?.crashLoop ?? null, Date.now()) : null;
	const next = {
		observed,
		replicasRunning: running,
		replicasDesired: desired,
		tasks: taskView,
		crashLoop: loop,
		observedAt: new Date(),
	};
	await ctx.db
		.insert(serviceStatus)
		.values({ serviceId: row.id, ...next })
		.onConflictDoUpdate({ target: serviceStatus.serviceId, set: next });
	const wasLooping = !!prev?.crashLoop;
	if (wasLooping !== !!loop)
		await ctx.bus.publish(
			"service.crash_loop",
			organizationId,
			{ type: "service", id: row.id },
			{
				state: loop ? "firing" : "resolved",
				service: row.name,
				...(loop && {
					reason: loop.reason,
					failures: loop.failures,
					exitCode: loop.exitCode,
				}),
			},
		);
	if (
		prev?.observed !== observed ||
		prev.replicasRunning !== running ||
		prev.replicasDesired !== desired
	)
		await ctx.bus.publish(
			"service.status_changed",
			organizationId,
			{ type: "service", id: row.id },
			{ observed, replicasRunning: running, replicasDesired: desired },
		);
}

async function reconcileService(
	ctx: Ctx,
	row: typeof service.$inferSelect,
	organizationId: string,
	busy: boolean,
	scaled: number | undefined,
) {
	const name = svcName(ctx, row.id);
	let svc = await inspectService(ctx, name);
	// A deployment in flight owns the service; only observe it.
	if (!busy) {
		const [last] = await ctx.db
			.select()
			.from(deployment)
			.where(
				and(eq(deployment.serviceId, row.id), eq(deployment.status, "healthy")),
			)
			.orderBy(desc(deployment.createdAt))
			.limit(1);
		if (last) {
			// Drift repair patches the live spec; only a recreate needs external secrets read.
			const sc = await loadService(ctx, row.id, {
				external: svc ? "placeholder" : "resolve",
			});
			if (sc && !svc) {
				await upsertService(
					ctx,
					sc.registry?.auth,
					await desiredSpec(ctx, sc, last),
				);
				log("warn", "recreated missing service", { serviceId: row.id, name });
				svc = await inspectService(ctx, name);
			} else if (sc && svc) {
				await ensureEnvNetwork(ctx, organizationId, row.environmentId);
				const kind = row.spec.kind === "database" ? "db" : "service";
				const labels = {
					...managedLabels({ resource: row.id, kind, org: organizationId }),
					...scope(ctx).labels,
					"logistack.environment": row.environmentId,
				};
				const replicas = desiredReplicas(row, scaled);
				const actual = svc.Spec.Labels ?? {};
				const labelDrift = Object.entries(labels).some(
					([k, v]) => actual[k] !== v,
				);
				const mode = svc.Spec.Mode;
				const replicaDrift =
					!!mode &&
					"Replicated" in mode &&
					mode.Replicated.Replicas !== replicas;
				if (labelDrift || replicaDrift) {
					// Patch onto the live spec: drift repair must never start a rollout of its own.
					await upsertService(ctx, sc.registry?.auth, svc.Spec, (current) => ({
						...current.Spec,
						Labels: { ...current.Spec.Labels, ...labels },
						Mode: { Replicated: { Replicas: replicas } },
					}));
					log("warn", "fixed service drift", {
						serviceId: row.id,
						labelDrift,
						replicaDrift,
					});
					svc = await inspectService(ctx, name);
				}
			}
		}
	}
	await writeStatus(ctx, row, organizationId, svc, scaled);
}

/** One reconcile pass over every service with a desired state. Idempotent; one replica at a time. */
export async function reconcilePass(ctx: Ctx): Promise<boolean> {
	return withLock(ctx.bus.redis, "ls:lock:reconcile", 120_000, async () => {
		const rows = await ctx.db
			.select({
				service,
				organizationId: project.organizationId,
				autoscale: serviceAutoscale,
			})
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.leftJoin(serviceAutoscale, eq(serviceAutoscale.serviceId, service.id))
			.where(ne(service.kind, "compose"));
		const pending = rows.length
			? await ctx.db
					.select({
						serviceId: deployment.serviceId,
						status: deployment.status,
					})
					.from(deployment)
					.where(
						inArray(
							deployment.serviceId,
							rows.map((r) => r.service.id),
						),
					)
			: [];
		const busy = new Set(
			pending.filter((d) => !isTerminal(d.status)).map((d) => d.serviceId),
		);
		// A backup or restore holding a service at zero replicas owns it until it ends.
		const paused = await pausedServices(
			ctx,
			rows.map((r) => r.service.id),
		);
		for (const r of rows) {
			try {
				await reconcileService(
					ctx,
					r.service,
					r.organizationId,
					busy.has(r.service.id) || paused.has(r.service.id),
					scaledReplicas(r.autoscale),
				);
			} catch (e) {
				log("error", "reconcile failed", {
					serviceId: r.service.id,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		// A deploy job lost with Redis or a missed event: queue it again (same job id, so no duplicate).
		for (const id of busy) await enqueueDeploy(ctx.queues, id);
	});
}

type Orphan = { key: string; remove: () => Promise<unknown>; data: boolean };

/**
 * Managed objects with no DB row, removed once orphaned for longer than the grace period.
 * Volumes hold user data: they are reported, never removed automatically, except a preview's
 * disposable ones.
 */
export async function sweepOrphans(
	ctx: Ctx,
	now = Date.now(),
): Promise<string[]> {
	const removed: string[] = [];
	await withLock(ctx.bus.redis, "ls:lock:orphans", 120_000, async () => {
		const filters = scopedFilters(ctx);
		const services = await ctx.docker.services.list(filters);
		const ids = (
			kinds: string[],
			labels: Record<string, string> | null | undefined,
		) =>
			labels && kinds.includes(labels[LABEL_KIND] ?? "")
				? [labels[LABEL_RESOURCE] ?? ""]
				: [];
		const existing = async (
			table: typeof service | typeof environment | typeof mount,
			wanted: string[],
		) =>
			new Set(
				wanted.length
					? (
							await ctx.db
								.select({ id: table.id })
								.from(table)
								.where(inArray(table.id, wanted))
						).map((r) => r.id)
					: [],
			);

		const svcIds = services.flatMap((s) =>
			ids(["service", "db"], s.Spec.Labels),
		);
		const liveServices = await existing(service, svcIds);
		const orphans: Orphan[] = [];
		for (const s of services)
			for (const id of ids(["service", "db"], s.Spec.Labels))
				if (!liveServices.has(id))
					orphans.push({
						key: `service:${s.Spec.Name}`,
						remove: () => ctx.docker.services.remove(s.ID),
						data: false,
					});

		// Configs and secrets are versioned by content hash: one no service references is stale.
		const referenced = new Set(
			services.flatMap((s) =>
				[s.Spec, s.PreviousSpec].flatMap((sp) => [
					...(sp?.TaskTemplate.ContainerSpec.Configs ?? []).map(
						(c) => c.ConfigName,
					),
					...(sp?.TaskTemplate.ContainerSpec.Secrets ?? []).map(
						(c) => c.SecretName,
					),
				]),
			),
		);
		const files = [
			...(await ctx.docker.configs.list(filters)).map((c) => ({
				name: c.Spec.Name,
				labels: c.Spec.Labels,
				remove: () => ctx.docker.configs.remove(c.ID),
			})),
			...(await ctx.docker.secrets.list(filters)).map((c) => ({
				name: c.Spec.Name,
				labels: c.Spec.Labels,
				remove: () => ctx.docker.secrets.remove(c.ID),
			})),
		];
		for (const f of files)
			if (ids(["config", "secret"], f.labels).length && !referenced.has(f.name))
				orphans.push({ key: `file:${f.name}`, remove: f.remove, data: false });

		const networks = await ctx.docker.networks.list(filters);
		const liveEnvs = await existing(
			environment,
			networks.flatMap((n) => ids(["network"], n.Labels)),
		);
		for (const n of networks)
			for (const id of ids(["network"], n.Labels))
				if (!liveEnvs.has(id))
					orphans.push({
						key: `network:${n.Name}`,
						remove: () => ctx.docker.networks.remove(n.Id),
						data: false,
					});

		const volumes = await ctx.docker.volumes.list(filters);
		const volIds = volumes.flatMap((v) => ids(["volume"], v.Labels));
		const liveMounts = await existing(mount, volIds);
		const liveVolServices = await existing(service, volIds);
		for (const v of volumes)
			for (const id of ids(["volume"], v.Labels))
				if (!liveMounts.has(id) && !liveVolServices.has(id))
					orphans.push({
						key: `volume:${v.Name}`,
						remove: () => ctx.docker.volumes.remove(v.Name),
						// shortcut: lists this node's volumes only; a preview volume on another node stays until removed by hand.
						data: v.Labels?.[LABEL_DISPOSABLE] !== "true",
					});

		const seenKey = `ls:orphans:${ctx.cfg.LS_NAME_PREFIX || "prod"}`;
		const seen = (await ctx.bus.redis.send("HGETALL", [seenKey])) as Record<
			string,
			string
		> | null;
		const keys = new Set(orphans.map((o) => o.key));
		const gone = Object.keys(seen ?? {}).filter((k) => !keys.has(k));
		if (gone.length) await ctx.bus.redis.send("HDEL", [seenKey, ...gone]);
		for (const o of orphans) {
			await ctx.bus.redis.send("HSETNX", [seenKey, o.key, String(now)]);
			const first = Number(seen?.[o.key] ?? now);
			if (now - first < ctx.cfg.LS_ORPHAN_GRACE_MS) continue;
			if (o.data) {
				log("warn", "orphaned volume kept (holds data, remove it by hand)", {
					key: o.key,
				});
				continue;
			}
			try {
				await o.remove();
				await ctx.bus.redis.send("HDEL", [seenKey, o.key]);
				removed.push(o.key);
				log("warn", "removed orphaned object", {
					key: o.key,
					orphanedForMs: now - first,
				});
			} catch (e) {
				// In use (a network with tasks still draining): retried on the next sweep.
				if (!(e instanceof DockerError)) throw e;
			}
		}
	});
	return removed;
}
