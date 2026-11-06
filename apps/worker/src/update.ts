import type {
	UpdateStep,
	UpdateStepState,
	UpdateSteps,
} from "@logistack/contracts";
import type { DockerClient, ServiceSpec } from "@logistack/docker";

/** The slice of the Docker client an update uses, so tests can hand in a fake. */
export type UpdateDocker = {
	services: Pick<DockerClient["services"], "inspect" | "update">;
	tasks: Pick<DockerClient["tasks"], "list">;
	images: Pick<DockerClient["images"], "pull" | "inspect">;
};

/** One stack service and the image it should run, in update order. */
export type UpdateTarget = { step: UpdateStep; service: string; image: string };

export type UpdateReport = {
	step(step: UpdateStep, state: UpdateStepState): Promise<void>;
	line(text: string): Promise<void>;
};

export type UpdateOptions = {
	/** Images exist only on this engine (`localhost/...`): check they are there instead of pulling. */
	local: boolean;
	/** Per service, from the update call until Swarm reports it converged. */
	timeoutMs: number;
	pollMs: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

export type UpdateResult = { ok: true } | { ok: false; error: string };

/** The steps around the service rolls that are not Swarm updates. Injected so tests fake them. */
export type UpdateGate = {
	/** Stops new jobs from starting and waits for the running ones to finish. */
	drain(report: UpdateReport): Promise<UpdateResult>;
	/** Lets jobs start again. Runs however the update ends, so it must be idempotent. */
	resume(): Promise<void>;
	/** Applies the new release's migrations from `image`, its pinned api image. */
	migrate(image: string, report: UpdateReport): Promise<UpdateResult>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const imageOf = (spec: ServiceSpec) => spec.TaskTemplate.ContainerSpec.Image;

/** `repo:tag` plus the registry digest, as `docker stack deploy` pins it, so every node runs the same bytes. */
async function pin(docker: UpdateDocker, ref: string): Promise<string> {
	const repo = ref.replace(/:[^/:]+$/, "");
	const digest = (await docker.images.inspect(ref)).RepoDigests?.find((d) =>
		d.startsWith(`${repo}@`),
	);
	return digest ? `${ref}${digest.slice(repo.length)}` : ref;
}

/**
 * Waits until every task Swarm wants running uses `image` and is running (healthy, for an image
 * with a healthcheck) and the update, monitor window included, is no longer in progress. Swarm
 * applies the service's own update_config: on failure it rolls the spec back to the previous
 * image, which is how a rollback shows up here.
 */
async function converge(
	docker: UpdateDocker,
	serviceId: string,
	image: string,
	o: UpdateOptions,
): Promise<UpdateResult> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? Bun.sleep;
	const deadline = now() + o.timeoutMs;
	let lastError = "";
	for (;;) {
		const svc = await docker.services.inspect(serviceId);
		if (imageOf(svc.Spec) !== image)
			return {
				ok: false,
				error: svc.UpdateStatus?.Message || "Swarm rolled the update back",
			};
		const state = svc.UpdateStatus?.State;
		if (state !== "updating" && state !== "rollback_started") {
			const tasks = await docker.tasks.list({
				service: [serviceId],
				"desired-state": ["running"],
			});
			if (
				tasks.every(
					(t) =>
						t.Spec.ContainerSpec.Image === image &&
						t.Status.State === "running",
				)
			)
				return { ok: true };
			lastError = tasks.map((t) => t.Status.Err).find(Boolean) ?? lastError;
		}
		if (now() >= deadline)
			return {
				ok: false,
				error: `not healthy after ${Math.round(o.timeoutMs / 1000)} s${lastError ? `: ${lastError}` : ""}`,
			};
		await sleep(o.pollMs);
	}
}

/**
 * Pull, drain, migrate, then replace the stack's images in order. Every image is fetched before
 * anything else, so a missing tag or an unreachable registry aborts with nothing touched. The
 * drain waits for running jobs, and the migrations run once before any new code serves; either
 * failing aborts with no service changed. A service that does not converge stops the run, and
 * every service this run changed goes back to its previous spec, newest first. Jobs resume
 * however it ends. Re-running with the same targets skips services that already run their image.
 */
export async function runUpdate(
	docker: UpdateDocker,
	targets: UpdateTarget[],
	report: UpdateReport,
	o: UpdateOptions,
	gate: UpdateGate,
): Promise<UpdateResult> {
	await report.step("pull", "running");
	const pinned = new Map<UpdateStep, string>();
	for (const t of targets) {
		try {
			await report.line(`${o.local ? "Checking" : "Pulling"} ${t.image}`);
			if (o.local) await docker.images.inspect(t.image);
			else await docker.images.pull(t.image);
			pinned.set(t.step, await pin(docker, t.image));
		} catch (e) {
			await report.step("pull", "failed");
			return { ok: false, error: `${t.image}: ${message(e)}` };
		}
	}
	await report.step("pull", "done");
	try {
		return await gated(docker, targets, pinned, report, o, gate);
	} finally {
		await gate
			.resume()
			.then(() => report.line("Deployments, backups and migrations resumed"))
			.catch((e) =>
				report.line(`Could not resume jobs: ${message(e)}; the worker retries`),
			);
	}
}

async function gated(
	docker: UpdateDocker,
	targets: UpdateTarget[],
	pinned: Map<UpdateStep, string>,
	report: UpdateReport,
	o: UpdateOptions,
	gate: UpdateGate,
): Promise<UpdateResult> {
	for (const [step, run] of [
		["drain", () => gate.drain(report)],
		["migrate", () => gate.migrate(pinned.get("logistack-api") ?? "", report)],
	] as const) {
		await report.step(step, "running");
		const r = await run().catch((e: unknown) => ({
			ok: false as const,
			error: message(e),
		}));
		await report.step(step, r.ok ? "done" : "failed");
		if (!r.ok) return r;
	}

	const touched: { step: UpdateStep; id: string; spec: ServiceSpec }[] = [];
	for (const t of targets) {
		const image = pinned.get(t.step) as string;
		await report.step(t.step, "running");
		let result: UpdateResult;
		try {
			const svc = await docker.services.inspect(t.service);
			if (imageOf(svc.Spec) === image) {
				await report.line(`${t.service} already runs ${image}`);
				await report.step(t.step, "done");
				continue;
			}
			touched.push({ step: t.step, id: svc.ID, spec: svc.Spec });
			await report.line(`Updating ${t.service} to ${image}`);
			const spec = structuredClone(svc.Spec);
			spec.TaskTemplate.ContainerSpec.Image = image;
			// Stacks before rolling updates disabled the worker's check; its image now ships one.
			if (spec.TaskTemplate.ContainerSpec.Healthcheck?.Test?.[0] === "NONE")
				delete spec.TaskTemplate.ContainerSpec.Healthcheck;
			await docker.services.update(svc.ID, svc.Version.Index, spec);
			result = await converge(docker, svc.ID, image, o);
		} catch (e) {
			result = { ok: false, error: message(e) };
		}
		if (result.ok) {
			await report.line(`${t.service} is healthy`);
			await report.step(t.step, "done");
			continue;
		}
		await report.step(t.step, "failed");
		await report.line(`${t.service} failed: ${result.error}`);
		const undone = await rollback(docker, touched, t.step, report, o);
		return {
			ok: false,
			error: `${t.step} did not become healthy (${result.error}).${undone}`,
		};
	}
	return { ok: true };
}

async function rollback(
	docker: UpdateDocker,
	touched: { step: UpdateStep; id: string; spec: ServiceSpec }[],
	failed: UpdateStep,
	report: UpdateReport,
	o: UpdateOptions,
): Promise<string> {
	const restored: string[] = [];
	const stuck: string[] = [];
	for (const t of touched.toReversed()) {
		const image = imageOf(t.spec);
		try {
			const svc = await docker.services.inspect(t.id);
			// Swarm's own failure_action may have rolled the failing service back already.
			if (imageOf(svc.Spec) !== image) {
				await report.line(`Rolling ${t.step} back to ${image}`);
				await docker.services.update(t.id, svc.Version.Index, t.spec);
				const r = await converge(docker, t.id, image, o);
				if (!r.ok) throw new Error(r.error);
			}
			if (t.step === failed) continue;
			await report.step(t.step, "rolled_back");
			restored.push(t.step);
		} catch (e) {
			stuck.push(t.step);
			await report.line(`Could not roll ${t.step} back: ${message(e)}`);
		}
	}
	return [
		restored.length ? ` Rolled back ${restored.join(", ")}.` : "",
		stuck.length ? ` Still on the new image: ${stuck.join(", ")}.` : "",
	].join("");
}

/** The step map a fresh run starts from. */
export const pendingSteps = (targets: UpdateTarget[]): UpdateSteps =>
	Object.fromEntries([
		["pull", "pending"],
		["drain", "pending"],
		["migrate", "pending"],
		...targets.map((t) => [t.step, "pending"]),
	]);
