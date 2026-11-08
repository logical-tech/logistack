import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type DeploymentStatus,
	deploymentStatuses,
	type EventType,
} from "@logistack/contracts";
import {
	compileService,
	type DeploymentEvent,
	deploymentContextEnv,
	encrypt,
	isTerminal,
	missingPlatforms,
	platformsOfArchs,
	resolveBuildPlatforms,
	secretMasker,
	specSnapshot,
	transition,
} from "@logistack/core";
import { deployment, environment, project, service } from "@logistack/db";
import { and, asc, eq, inArray, not } from "drizzle-orm";
import {
	desiredInput,
	inspectService,
	type RolloutResult,
	upsertService,
	waitForRollout,
} from "./apply.ts";
import {
	buildkitAddr,
	buildPlan,
	clone,
	type LogLine,
	loadImage,
	pushImage,
	run,
} from "./build.ts";
import { dockerConfig, probeBuildkit } from "./build-platforms.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { runDeployGates } from "./gates.ts";
import { probeImageShell } from "./image-shell.ts";
import {
	deploymentContext,
	imageRef,
	loadService,
	type ServiceContext,
	svcName,
} from "./load.ts";
import { runRelease } from "./release.ts";
import { convertLegacySecrets } from "./secrets.ts";

export type DeploymentRow = typeof deployment.$inferSelect;
type Patch = Partial<
	Pick<
		DeploymentRow,
		| "startedAt"
		| "finishedAt"
		| "error"
		| "warning"
		| "commitSha"
		| "commitMessage"
		| "imageRef"
		| "platforms"
		| "logPath"
		| "supersededBy"
	>
>;

export type QueuePlan =
	| { kind: "idle" }
	| { kind: "resume"; deployment: DeploymentRow }
	| { kind: "run"; deployment: DeploymentRow; supersede: DeploymentRow[] };

/**
 * Pure: what to do next with a service's non-terminal deployments. One in flight is resumed
 * first (a running deployment is only ever cancelled explicitly); otherwise the newest queued
 * one runs and every older queued one is superseded by it. Deployments awaiting checks belong
 * to the checks poller until it queues them.
 */
export function planQueue(pending: readonly DeploymentRow[]): QueuePlan {
	const live = pending.filter(
		(d) => !isTerminal(d.status) && d.status !== "awaiting_checks",
	);
	const inFlight = live.find((d) => d.status !== "queued");
	if (inFlight) return { kind: "resume", deployment: inFlight };
	const queued = live
		.filter((d) => d.status === "queued")
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	const newest = queued.at(-1);
	if (!newest) return { kind: "idle" };
	return { kind: "run", deployment: newest, supersede: queued.slice(0, -1) };
}

/** The row moved under us (cancelled through the API, or another writer); stop without writing. */
export class Interrupted extends Error {
	override name = "Interrupted";
}

export type Steps = {
	clone(): Promise<Patch>;
	build(): Promise<Patch>;
	push(): Promise<void>;
	/** The pre-deploy command; throws when it fails, before Swarm sees the new spec. */
	release(): Promise<void>;
	deploy(): Promise<RolloutResult>;
};

export type AbortReason = "cancel" | "shutdown";

/**
 * Drives one deployment through `core.transition`, one step result at a time. `advance`
 * persists a transition and returns the new state. Aborting with "cancel" cancels a build;
 * "shutdown" fails a build but leaves a rollout in `deploying` for the next worker to resume.
 */
export async function drive(o: {
	status: DeploymentStatus;
	source: "git" | "image";
	push: boolean;
	release: boolean;
	steps: Steps;
	advance: (e: DeploymentEvent, patch?: Patch) => Promise<DeploymentStatus>;
	signal: AbortSignal;
	onState?: (s: DeploymentStatus) => void;
}): Promise<DeploymentStatus> {
	let state = o.status;
	const go = async (e: DeploymentEvent, patch?: Patch) => {
		state = await o.advance(e, patch);
		o.onState?.(state);
	};
	try {
		const { release } = o;
		if (state === "queued") {
			await go({ type: "start", source: o.source, release });
			if (o.source === "git") {
				await go({ type: "cloned" }, await o.steps.clone());
				await go(
					{ type: "built", push: o.push, release },
					await o.steps.build(),
				);
				if (o.push) {
					await o.steps.push();
					await go({ type: "pushed", release });
				}
			}
			if (release) {
				await o.steps.release();
				await go({ type: "released" });
			}
		}
		if (state !== "deploying")
			throw new Error(`interrupted: the worker stopped during ${state}`);
		const result = await o.steps.deploy();
		if (result.ok)
			await go(
				{ type: "healthy" },
				{
					finishedAt: new Date(),
					...(result.warning ? { warning: result.warning } : {}),
				},
			);
		else
			await go(
				{ type: "fail" },
				{ error: result.error, finishedAt: new Date() },
			);
	} catch (e) {
		if (e instanceof Interrupted) return state;
		const reason = o.signal.aborted
			? (o.signal.reason as AbortReason)
			: undefined;
		if (reason === "shutdown" && state === "deploying") return state;
		const cancel = reason === "cancel" && state !== "deploying";
		const error =
			reason === "shutdown"
				? "interrupted: the worker shut down"
				: e instanceof Error
					? e.message
					: String(e);
		try {
			await go(cancel ? { type: "cancel" } : { type: "fail" }, {
				finishedAt: new Date(),
				...(cancel ? {} : { error }),
			});
		} catch (inner) {
			if (!(inner instanceof Interrupted)) throw inner;
		}
	}
	return state;
}

const eventFor: Partial<Record<DeploymentEvent["type"], EventType>> = {
	start: "deployment.started",
	healthy: "deployment.succeeded",
	fail: "deployment.failed",
	cancel: "deployment.cancelled",
	// contracts has no deployment.superseded; the payload's status tells them apart.
	supersede: "deployment.cancelled",
};

async function advance(
	ctx: Ctx,
	sc: ServiceContext,
	d: { id: string; status: DeploymentStatus },
	event: DeploymentEvent,
	patch: Patch = {},
): Promise<DeploymentStatus> {
	const r = transition(d.status, event);
	if (!r.ok)
		throw new Error(
			`deployment ${d.id}: illegal ${event.type} from ${d.status}`,
		);
	const rows = await ctx.db
		.update(deployment)
		.set({ status: r.state, ...patch })
		.where(and(eq(deployment.id, d.id), eq(deployment.status, d.status)))
		.returning({ id: deployment.id });
	if (!rows.length) throw new Interrupted();
	const from = d.status;
	d.status = r.state;
	const type = eventFor[event.type];
	if (type)
		await ctx.bus.publish(
			type,
			sc.organizationId,
			{ type: "deployment", id: d.id },
			{
				serviceId: sc.service.id,
				from,
				status: r.state,
				...(patch.error ? { error: patch.error } : {}),
				...(patch.supersededBy ? { supersededBy: patch.supersededBy } : {}),
			},
		);
	return r.state;
}

type Running = { controller: AbortController; state: DeploymentStatus };
const running = new Map<string, Running>();

/** Explicit cancel: aborts this deployment's child processes, only before Swarm owns the rollout. */
export function cancelRunning(deploymentId: string): boolean {
	const r = running.get(deploymentId);
	if (!r || r.state === "deploying" || isTerminal(r.state)) return false;
	r.controller.abort("cancel" satisfies AbortReason);
	return true;
}

export function abortAll(reason: AbortReason) {
	for (const r of running.values()) r.controller.abort(reason);
}

function deploymentLog(
	ctx: Ctx,
	id: string,
	secrets: Iterable<string>,
): { path: string; line: LogLine; flush: () => Promise<void> } {
	const mask = secretMasker(secrets);
	const path = join(ctx.cfg.LS_WORK_DIR, "logs", `${id}.log`);
	let chain = mkdir(join(ctx.cfg.LS_WORK_DIR, "logs"), {
		recursive: true,
	}).then(() => {});
	// The api replays from Redis (it does not mount the worker's volume); seq needs one line at a time.
	let published = Promise.resolve();
	return {
		path,
		line: (raw) => {
			const text = mask(raw);
			// Ordered appends without blocking the producer; a lost line must not fail a deploy.
			chain = chain.then(() => appendFile(path, `${text}\n`)).catch(() => {});
			published = published
				.then(() => ctx.bus.publishLog(id, text))
				.catch(() => {});
		},
		// A reader that sees a finished status replays the list once and stops: it must be complete.
		flush: () => Promise.all([chain, published]).then(() => {}),
	};
}

async function runDeployment(
	ctx: Ctx,
	sc: ServiceContext,
	d: DeploymentRow,
): Promise<DeploymentStatus> {
	const controller = new AbortController();
	const entry: Running = { controller, state: d.status };
	running.set(d.id, entry);
	const signal = controller.signal;
	const { path, line, flush } = deploymentLog(
		ctx,
		d.id,
		Object.values(sc.env).flatMap((v) => (v.isSecret ? [v.value] : [])),
	);
	const spec = sc.service.spec;
	// Queued with an image already (rollback, restart): reuse it instead of building.
	const source =
		spec.kind === "application" && spec.source.type === "git" && !d.imageRef
			? "git"
			: "image";
	const push = sc.registry !== null;
	const ref =
		d.imageRef ??
		(spec.kind === "application" && spec.source.type === "image"
			? spec.source.image
			: imageRef(ctx, sc, d.id));
	let checkout: string | undefined;
	// Cloned commits land in the row through advance(); `d` is the row as it was read.
	let commit = { commitSha: d.commitSha, commitMessage: d.commitMessage };
	const state = { id: d.id, status: d.status };
	let platforms = d.platforms;
	let imageShell = d.imageShell;
	let pushedByBuild = false;

	const target = () => ({
		id: d.id,
		imageRef: ref,
		gitRef: d.gitRef,
		platforms,
		imageShell,
		...commit,
	});
	const rollout = async (): Promise<RolloutResult> => {
		line(`==> deploying ${ref}`);
		const name = svcName(ctx, sc.service.id);
		const current = await inspectService(ctx, name);
		const label = (s?: {
			TaskTemplate: { ContainerSpec: { Labels?: Record<string, string> } };
		}) => s?.TaskTemplate.ContainerSpec.Labels?.["logistack.deployment"];
		const timeoutMs = ctx.cfg.LS_DEPLOY_TIMEOUT_MS;
		// Resuming: our spec is already applied, or Swarm already rolled it back.
		if (current && label(current.Spec) === d.id)
			return waitForRollout(
				ctx,
				name,
				{ created: false, before: undefined },
				{
					timeoutMs,
					signal,
					deploymentId: d.id,
				},
			);
		if (
			current &&
			label(current.PreviousSpec) === d.id &&
			current.UpdateStatus?.State.startsWith("rollback")
		)
			return {
				ok: false,
				error: `rolled back: ${current.UpdateStatus.Message ?? ""}`.trim(),
				rolledBack: true,
			};
		// Plugin deploy gates: after the resume checks, so an applied rollout is never asked again.
		const gate = await runDeployGates(ctx, sc, { ...d, ...commit }, ref, line);
		if (!gate.ok) {
			line(`==> failed: ${gate.error}`);
			return { ok: false, error: gate.error, rolledBack: false };
		}
		// Only the tcp and http checks need a shell; a command check runs as argv.
		if (
			spec.kind === "application" &&
			spec.healthcheck?.type !== "command" &&
			imageShell === null
		) {
			imageShell = await probeImageShell(ctx, sc, ref, signal);
			if (imageShell === false)
				line(
					"==> the image has no /bin/sh: no default healthcheck, the task counts as healthy once it runs",
				);
		}
		const input = await desiredInput(ctx, sc, target());
		const snapshot = specSnapshot(input, sc.env);
		await ctx.db
			.update(deployment)
			.set({
				imageShell,
				specSnapshotEncrypted: await encrypt(
					ctx.masterKey,
					JSON.stringify(snapshot),
				),
			})
			.where(eq(deployment.id, d.id));
		const applied = await upsertService(
			ctx,
			sc.registry?.auth,
			compileService(input),
		);
		const result = await waitForRollout(ctx, name, applied, {
			timeoutMs,
			signal,
			deploymentId: d.id,
		});
		line(result.ok ? "==> healthy" : `==> failed: ${result.error}`);
		return result;
	};

	const steps: Steps = {
		async clone() {
			if (spec.kind !== "application" || spec.source.type !== "git")
				throw new Error("not a git source");
			const ref = d.gitRef ?? spec.source.branch;
			line(`==> cloning ${spec.source.repository}#${ref}`);
			const c = await clone(ctx, spec.source, {
				deploymentId: d.id,
				ref,
				sha: d.commitSha,
				...(sc.git ? { auth: sc.git } : {}),
				log: line,
				signal,
			});
			checkout = c.dir;
			line(`==> commit ${c.commitSha} ${c.commitMessage}`);
			commit = { commitSha: c.commitSha, commitMessage: c.commitMessage };
			return commit;
		},
		async build() {
			if (
				spec.kind !== "application" ||
				spec.source.type !== "git" ||
				!checkout
			)
				throw new Error("nothing to build");
			const nodes = await ctx.docker.nodes.list();
			if (!push && nodes.length > 1)
				throw new Error(
					"a multi-node swarm needs a registry: configure one before building",
				);
			const supported = await probeBuildkit(ctx, signal);
			const native = platformsOfArchs([supported[0]?.split("/")[1] ?? ""])[0];
			if (!native)
				throw new Error(
					`BuildKit runs on ${supported[0] ?? "an unknown platform"}; LogiStack builds for linux/amd64 and linux/arm64`,
				);
			const targets = resolveBuildPlatforms({
				build: spec.build,
				swarm: platformsOfArchs(
					nodes.map((n) => n.Description.Platform.Architecture),
				),
				native,
			});
			const missing = missingPlatforms(supported).filter((p) =>
				targets.includes(p),
			);
			if (missing.length)
				throw new Error(
					`BuildKit cannot build ${missing.join(", ")}: set up cross-architecture emulation in Settings > Builds, or build for ${native} only`,
				);
			if (targets.length > 1 && !push)
				throw new Error(
					"a multi-platform build pushes a manifest list: configure a registry first",
				);
			line(
				`==> building ${ref} for ${targets.join(", ")} (${spec.build.type})`,
			);
			const plan = buildPlan({
				dir: checkout,
				appPath: spec.source.path,
				build: spec.build,
				buildEnv: Object.entries(sc.env)
					.filter(([, v]) => v.isBuildTime)
					.map(([key, v]) => ({ key, value: v.value, isSecret: v.isSecret })),
				context: deploymentContextEnv(
					deploymentContext(sc, { id: d.id, gitRef: d.gitRef, ...commit }),
				),
				imageRef: ref,
				railpackFrontend: ctx.cfg.LS_RAILPACK_FRONTEND,
				platforms: targets,
			});
			const auth = sc.registry?.auth;
			const config = `${checkout}.docker`;
			try {
				for (const [path, content] of Object.entries(plan.files ?? {})) {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, content);
				}
				if (plan.prepare)
					await run([...ctx.cfg.LS_RAILPACK, ...plan.prepare], {
						log: line,
						signal,
					});
				if (plan.pushes && auth) {
					await mkdir(config, { recursive: true, mode: 0o700 });
					await writeFile(join(config, "config.json"), dockerConfig(auth), {
						mode: 0o600,
					});
				}
				await run(
					[...ctx.cfg.LS_BUILDCTL, "--addr", buildkitAddr(ctx), ...plan.args],
					{
						log: line,
						signal,
						env: {
							...plan.env,
							...(plan.pushes && auth ? { DOCKER_CONFIG: config } : {}),
						},
						...(plan.pushes
							? {}
							: { stdout: (tar) => loadImage(ctx, tar, line, signal) }),
					},
				);
			} finally {
				await rm(checkout, { recursive: true, force: true });
				await rm(config, { recursive: true, force: true });
				for (const path of Object.keys(plan.files ?? {}))
					await rm(dirname(path), { recursive: true, force: true });
			}
			pushedByBuild = plan.pushes;
			platforms = targets;
			return { imageRef: ref, platforms };
		},
		async push() {
			if (pushedByBuild) {
				line(`==> ${ref} was pushed by BuildKit as a manifest list`);
				return;
			}
			line(`==> pushing ${ref}`);
			await pushImage(ctx, ref, sc.registry?.auth, line, signal);
		},
		async release() {
			if (spec.kind !== "application" || !spec.preDeploy) return;
			const input = await desiredInput(ctx, sc, target());
			const error = await runRelease(
				ctx,
				compileService(input),
				"pre",
				spec.preDeploy,
				{ registryAuth: sc.registry?.auth, line, signal },
			);
			if (error) throw new Error(error);
		},
		async deploy() {
			const result = await rollout();
			if (!result.ok || spec.kind !== "application" || !spec.postDeploy)
				return result;
			// The applied spec, also when resuming a rollout this worker did not start.
			const live = await inspectService(ctx, svcName(ctx, sc.service.id));
			const warning = live
				? await runRelease(ctx, live.Spec, "post", spec.postDeploy, {
						registryAuth: sc.registry?.auth,
						line,
						signal,
					})
				: "post-deploy skipped: the service disappeared";
			return warning ? { ok: true, warning } : result;
		},
	};

	try {
		return await drive({
			status: d.status,
			source,
			push,
			release: spec.kind === "application" && !!spec.preDeploy,
			steps,
			signal,
			onState: (s) => {
				entry.state = s;
			},
			advance: async (event, patch = {}) => {
				// A rollout logs its own failure; a build or release failure only reached the row.
				if (
					event.type === "fail" &&
					patch.error &&
					state.status !== "deploying"
				)
					line(`==> failed: ${patch.error}`);
				await flush();
				return advance(ctx, sc, state, event, {
					...patch,
					...(event.type === "start"
						? {
								startedAt: new Date(),
								logPath: path,
								...(source === "image" ? { imageRef: ref } : {}),
							}
						: {}),
				});
			},
		});
	} finally {
		running.delete(d.id);
	}
}

/** A service that cannot be loaded (unsupported kind, undecryptable secret) fails its pending deployments. */
async function failAll(ctx: Ctx, pending: DeploymentRow[], error: string) {
	for (const d of pending) {
		const r = transition(d.status, { type: "fail" });
		if (!r.ok) continue;
		await ctx.db
			.update(deployment)
			.set({ status: r.state, error, finishedAt: new Date() })
			.where(and(eq(deployment.id, d.id), eq(deployment.status, d.status)));
	}
	log("error", "service cannot be deployed", { error, count: pending.length });
}

export const terminal = deploymentStatuses.filter(isTerminal);

async function archived(ctx: Ctx, serviceId: string): Promise<boolean> {
	const [row] = await ctx.db
		.select({ archivedAt: project.archivedAt })
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(eq(service.id, serviceId));
	return Boolean(row?.archivedAt);
}

/** The `deploy` job: drains a service's deployments one at a time until none is pending. */
export async function processService(
	ctx: Ctx,
	serviceId: string,
): Promise<void> {
	for (;;) {
		const pending = await ctx.db
			.select()
			.from(deployment)
			.where(
				and(
					eq(deployment.serviceId, serviceId),
					not(inArray(deployment.status, terminal)),
				),
			)
			.orderBy(asc(deployment.createdAt));
		const plan = planQueue(pending);
		if (plan.kind === "idle") return;
		if (plan.kind === "run" && (await archived(ctx, serviceId))) {
			// Queued before the archive, or by a trigger that does not check it (git push, schedule).
			await failAll(
				ctx,
				pending.filter((d) => d.status === "queued"),
				"the project is archived; unarchive it to deploy",
			);
			return;
		}
		let sc: ServiceContext | null;
		try {
			await convertLegacySecrets(ctx);
			sc = await loadService(ctx, serviceId);
		} catch (e) {
			await failAll(ctx, pending, e instanceof Error ? e.message : String(e));
			return;
		}
		if (!sc) return; // deleted: cascades removed its deployments
		if (plan.kind === "run")
			for (const old of plan.supersede)
				await advance(
					ctx,
					sc,
					old,
					{ type: "supersede" },
					{
						supersededBy: plan.deployment.id,
						finishedAt: new Date(),
					},
				).catch((e) => {
					if (!(e instanceof Interrupted)) throw e;
				});
		const final = await runDeployment(ctx, sc, plan.deployment);
		log("info", "deployment finished", {
			deploymentId: plan.deployment.id,
			serviceId,
			status: final,
		});
		// Left in deploying by a shutdown: the next worker resumes it.
		if (!isTerminal(final)) return;
	}
}
