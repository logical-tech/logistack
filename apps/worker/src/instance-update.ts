import { UPDATE_TARGETS } from "@logistack/contracts";
import { compareVersions } from "@logistack/core";
import { instanceSettings, instanceUpdate, organization } from "@logistack/db";
import { LABEL_KIND, managedLabels, type ServiceSpec } from "@logistack/docker";
import { type Deps, latestRelease } from "@logistack/providers";
import { eq, sql } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Config } from "./config.ts";
import { type Ctx, scope } from "./ctx.ts";
import { pendingSteps, type UpdateTarget } from "./update.ts";

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

const updaterPrefix = (ctx: Ctx) => `${scope(ctx).namePrefix}ls-update-`;

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
	const labels = {
		...managedLabels({ resource: updateId, kind: "system", org: "system" }),
		...scope(ctx).labels,
	};
	const { Command: _, ...container } = worker.TaskTemplate.ContainerSpec;
	return {
		Name: `${updaterPrefix(ctx)}${updateId.slice(updateId.indexOf("_") + 1)}`,
		Labels: labels,
		TaskTemplate: {
			...worker.TaskTemplate,
			ContainerSpec: {
				...container,
				Labels: labels,
				// The image's entrypoint loads the secrets into the environment, then runs this.
				Args: ["bun", "apps/worker/src/update-runner.ts", updateId],
			},
			RestartPolicy: { Condition: "none" },
			Placement: { Constraints: [`node.id==${nodeId}`] },
		},
		Mode: { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } },
	};
}

/** Starts the updater for each queued run. A run that cannot start fails with the reason. */
export async function startQueuedUpdates(ctx: Ctx): Promise<void> {
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

/** Daily: tells every organization once per release that a newer one is out. */
export async function checkForUpdate(ctx: Ctx, deps: Deps = {}): Promise<void> {
	const [s] = await ctx.db
		.select({
			on: instanceSettings.autoCheckUpdates,
			url: instanceSettings.publicUrl,
		})
		.from(instanceSettings);
	if (!s?.on) return;
	const latest = await latestRelease(deps);
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
