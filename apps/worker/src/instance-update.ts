import { UPDATE_TARGETS } from "@logistack/contracts";
import { compareVersions } from "@logistack/core";
import { instanceSettings, instanceUpdate, organization } from "@logistack/db";
import {
	type DockerClient,
	LABEL_KIND,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";
import { type Deps, latestRelease } from "@logistack/providers";
import { eq, inArray, sql } from "drizzle-orm";
import { type Bus, log } from "./bus.ts";
import type { Config } from "./config.ts";
import { type Ctx, scope } from "./ctx.ts";
import { resume } from "./drain.ts";
import { waitForJob } from "./swarm-job.ts";
import {
	pendingSteps,
	type UpdateReport,
	type UpdateResult,
	type UpdateTarget,
} from "./update.ts";

type Row = typeof instanceUpdate.$inferSelect;

/** A run whose updater has not written for this long is dead (node reboot, OOM). */
const STALE = "30 minutes";
const NOTIFIED_KEY = "ls:update:notified";

export const stackTargets = (cfg: Config, version: string): UpdateTarget[] =>
	UPDATE_TARGETS.map((t) => ({
		step: t.step,
		service: `${cfg.LS_STACK_NAME}_${t.step}`,
		image: `${cfg.LS_UPDATE_REGISTRY}/${t.image}:${version}`,
	}));

const updaterPrefix = (ctx: Pick<Ctx, "cfg">) =>
	`${scope(ctx).namePrefix}ls-update-`;
const shortId = (updateId: string) => updateId.slice(updateId.indexOf("_") + 1);
const jobLabels = (ctx: Pick<Ctx, "cfg">, updateId: string) => ({
	...managedLabels({ resource: updateId, kind: "system", org: "system" }),
	...scope(ctx).labels,
});
const jobMode = { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } };

/** Takes the oldest queued run; replicas never both take one. Fails runs whose updater went quiet. */
async function claim(ctx: Ctx): Promise<Row | undefined> {
	await ctx.db.execute(sql`
		update instance_update set state = 'failed', error = 'the updater stopped reporting', updated_at = now()
		where state = 'running' and updated_at < now() - ${STALE}::interval`);
	const rows = await ctx.db.execute<{ id: string }>(sql`
		update instance_update set state = 'running', updated_at = now()
		where id = (
			select id from instance_update where state = 'queued'
			order by created_at limit 1 for update skip locked
		)
		returning id`);
	const id = rows[0]?.id;
	if (!id) return undefined;
	const [row] = await ctx.db
		.select()
		.from(instanceUpdate)
		.where(eq(instanceUpdate.id, id));
	return row;
}

/**
 * The updater is a one-shot Swarm job cloned from the worker's own task (image, secrets, ls-control,
 * docker socket) and pinned to this node, where that image already is. It outlives the worker it
 * replaces, so the sequence never depends on a process that the sequence itself stops.
 */
export function updaterSpec(
	ctx: Ctx,
	worker: ServiceSpec,
	updateId: string,
	nodeId: string,
): ServiceSpec {
	const labels = jobLabels(ctx, updateId);
	const { Command: _, ...container } = worker.TaskTemplate.ContainerSpec;
	return {
		Name: `${updaterPrefix(ctx)}${shortId(updateId)}`,
		Labels: labels,
		TaskTemplate: {
			...worker.TaskTemplate,
			ContainerSpec: {
				...container,
				Labels: labels,
				// The image's entrypoint loads the secrets into the environment, then runs this.
				Args: ["bun", "apps/worker/src/update-runner.ts", updateId],
				// The worker's check reads a heartbeat that only the worker writes.
				Healthcheck: { Test: ["NONE"] },
			},
			RestartPolicy: { Condition: "none" },
			Placement: { Constraints: [`node.id==${nodeId}`] },
		},
		Mode: jobMode,
	};
}

/**
 * The migration job: the new release's api image, with the api service's secrets and networks,
 * running only `install/migrate.ts`. Pinned to the updater's node, where the image was fetched.
 */
export function migrateSpec(
	ctx: Pick<Ctx, "cfg">,
	api: ServiceSpec,
	image: string,
	updateId: string,
	nodeId: string,
): ServiceSpec {
	const labels = jobLabels(ctx, updateId);
	const { Command: _, ...container } = api.TaskTemplate.ContainerSpec;
	return {
		Name: `${updaterPrefix(ctx)}migrate-${shortId(updateId)}`,
		Labels: labels,
		TaskTemplate: {
			...api.TaskTemplate,
			ContainerSpec: {
				...container,
				Image: image,
				Labels: labels,
				Args: ["bun", "install/migrate.ts"],
				// The api image's check asks a server this job never starts.
				Healthcheck: { Test: ["NONE"] },
			},
			RestartPolicy: { Condition: "none" },
			Placement: { Constraints: [`node.id==${nodeId}`] },
		},
		Mode: jobMode,
	};
}

/** Runs the migration job to completion. Migrations apply in one transaction, so a failure leaves the old schema. */
export async function migrate(
	ctx: Pick<Ctx, "cfg">,
	docker: Pick<DockerClient, "services" | "tasks" | "info">,
	updateId: string,
	image: string,
	report: UpdateReport,
): Promise<UpdateResult> {
	const api = await docker.services.inspect(
		`${ctx.cfg.LS_STACK_NAME}_logistack-api`,
	);
	const spec = migrateSpec(
		ctx,
		api.Spec,
		image,
		updateId,
		(await docker.info()).Swarm.NodeID,
	);
	await docker.services.remove(spec.Name).catch(() => {});
	await report.line(`Migrating the database with ${image}`);
	await docker.services.create(spec);
	try {
		await waitForJob(docker, spec.Name, {
			what: "the migration job",
			timeoutMs: ctx.cfg.LS_UPDATE_TIMEOUT_MS,
		});
	} catch (e) {
		return {
			ok: false,
			error: `${e instanceof Error ? e.message : String(e)}\nNo service was changed.`,
		};
	}
	await report.line("Database migrated");
	return { ok: true };
}

/** Tells every organization how an update ended. */
export async function notifyOutcome(
	db: Ctx["db"],
	bus: Pick<Bus, "publish">,
	run: { id: string; fromVersion: string; toVersion: string },
	result: UpdateResult,
	publicUrl: string | null,
): Promise<void> {
	const url = publicUrl
		? `${publicUrl.replace(/\/$/, "")}/settings/updates`
		: undefined;
	for (const org of await db.select({ id: organization.id }).from(organization))
		await bus.publish(
			result.ok ? "instance.update_succeeded" : "instance.update_failed",
			org.id,
			{ type: "instance", id: run.id },
			{
				name: `v${run.toVersion}`,
				version: run.toVersion,
				current: result.ok ? run.toVersion : run.fromVersion,
				message: result.ok
					? `Every service runs ${run.toVersion}.`
					: `Still on ${run.fromVersion}: ${result.error}`,
				...(url ? { url } : {}),
			},
		);
}

/** Starts the updater for each queued run. A run that cannot start fails with the reason. */
export async function startQueuedUpdates(ctx: Ctx): Promise<void> {
	await resumeIfIdle(ctx);
	for (let row = await claim(ctx); row; row = await claim(ctx)) {
		try {
			const worker = await ctx.docker.services.inspect(
				`${ctx.cfg.LS_STACK_NAME}_logistack-worker`,
			);
			const nodeId = (await ctx.docker.info()).Swarm.NodeID;
			// Finished updaters of earlier runs; a job service never removes itself.
			for (const old of await ctx.docker.services.list({
				label: ["logistack.managed=true", `${LABEL_KIND}=system`],
				name: [updaterPrefix(ctx)],
			}))
				if (old.Spec.Name.startsWith(updaterPrefix(ctx)))
					await ctx.docker.services.remove(old.ID);
			const spec = updaterSpec(ctx, worker.Spec, row.id, nodeId);
			await ctx.db
				.update(instanceUpdate)
				.set({
					steps: pendingSteps(stackTargets(ctx.cfg, row.toVersion)),
					log: [`Starting the updater ${spec.Name}`],
				})
				.where(eq(instanceUpdate.id, row.id));
			await ctx.docker.services.create(spec);
			log("info", "updater started", { id: row.id, to: row.toVersion });
		} catch (e) {
			const error = `could not start the updater: ${e instanceof Error ? e.message : String(e)}`;
			await ctx.db
				.update(instanceUpdate)
				.set({ state: "failed", error })
				.where(eq(instanceUpdate.id, row.id));
			log("error", "updater not started", { id: row.id, error });
		}
	}
}

/**
 * An updater that died while draining leaves the queues paused. With no run active, nothing
 * should hold them, so the worker resumes them on every tick; resuming a running queue is a no-op.
 */
async function resumeIfIdle(ctx: Ctx) {
	const active = await ctx.db.$count(
		instanceUpdate,
		inArray(instanceUpdate.state, ["queued", "running"]),
	);
	if (!active) await resume(ctx.queues);
}

/** Daily: tells every organization once per release that a newer one is out. */
export async function checkForUpdate(ctx: Ctx, deps: Deps = {}): Promise<void> {
	const [s] = await ctx.db
		.select({
			on: instanceSettings.autoCheckUpdates,
			beta: instanceSettings.betaUpdates,
			url: instanceSettings.publicUrl,
		})
		.from(instanceSettings);
	if (!s?.on) return;
	const latest = await latestRelease(deps, { beta: s.beta });
	const current = ctx.cfg.LOGISTACK_VERSION;
	if (!latest || compareVersions(latest.version, current) <= 0) return;
	if ((await ctx.bus.redis.get(NOTIFIED_KEY)) === latest.version) return;
	const url = s.url
		? `${s.url.replace(/\/$/, "")}/settings/updates`
		: latest.url;
	for (const org of await ctx.db
		.select({ id: organization.id })
		.from(organization))
		await ctx.bus.publish(
			"instance.update_available",
			org.id,
			{ type: "instance", id: "singleton" },
			{
				name: `v${latest.version}`,
				version: latest.version,
				current,
				message: `LogiStack ${latest.version} is available; this instance runs ${current}.`,
				url,
			},
		);
	await ctx.bus.redis.set(NOTIFIED_KEY, latest.version);
	log("info", "update available", { current, latest: latest.version });
}
