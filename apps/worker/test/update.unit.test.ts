import { describe, expect, test } from "bun:test";
import type { UpdateStep, UpdateStepState } from "@logistack/contracts";
import type { Service, ServiceSpec, Task } from "@logistack/docker";
import {
	pendingSteps,
	runUpdate,
	type UpdateDocker,
	type UpdateGate,
	type UpdateOptions,
	type UpdateTarget,
} from "../src/update.ts";

const REG = "ghcr.io/logical-tech";
const DIGEST = "@sha256:feed";
const SERVICES = [
	["logistack-api", "logistack"],
	["logistack-agent", "logistack-agent"],
	["caddy", "logistack-caddy"],
	["logistack-worker", "logistack-worker"],
] as const;
const targets = (version: string): UpdateTarget[] =>
	SERVICES.map(([step, image]) => ({
		step,
		service: `logistack_${step}`,
		image: `${REG}/${image}:${version}`,
	}));

/**
 * A single-node Swarm in memory. An update to an image in `broken` behaves as Swarm's
 * failure_action rollback does: the spec flips back to the previous one. An image in `stuck`
 * never gets a running task.
 */
function fakeSwarm(o: {
	missing?: string[];
	broken?: string[];
	stuck?: string[];
}) {
	const calls: string[] = [];
	const services = new Map<string, Service>();
	for (const [step, image] of SERVICES)
		services.set(`logistack_${step}`, {
			ID: `id-${step}`,
			Version: { Index: 1 },
			CreatedAt: "",
			UpdatedAt: "",
			Spec: {
				Name: `logistack_${step}`,
				Labels: { "com.docker.stack.namespace": "logistack" },
				TaskTemplate: {
					ContainerSpec: {
						Image: `localhost/${image}:0.1.0-local.abc`,
						Env: ["ROLE=x"],
					},
				},
			},
		});
	const byId = (id: string) => {
		const s = [...services.values()].find(
			(x) => x.ID === id || x.Spec.Name === id,
		);
		if (!s) throw new Error(`no such service: ${id}`);
		return s;
	};
	const docker: UpdateDocker = {
		images: {
			async pull(ref) {
				calls.push(`pull ${ref}`);
				if (o.missing?.includes(ref)) throw new Error("manifest unknown");
			},
			async inspect(ref) {
				if (o.missing?.includes(ref)) throw new Error("No such image");
				const repo = ref.replace(/:[^/:]+$/, "");
				return {
					RepoDigests: ref.startsWith("localhost/") ? [] : [`${repo}${DIGEST}`],
				} as never;
			},
		},
		services: {
			async inspect(id) {
				return structuredClone(byId(id));
			},
			async update(id, version, spec: ServiceSpec) {
				const s = byId(id);
				expect(version).toBe(s.Version.Index);
				calls.push(
					`update ${s.Spec.Name} ${spec.TaskTemplate.ContainerSpec.Image}`,
				);
				const broken = o.broken?.some((b) =>
					spec.TaskTemplate.ContainerSpec.Image.startsWith(b),
				);
				s.PreviousSpec = s.Spec;
				s.Spec = broken ? s.Spec : structuredClone(spec);
				s.Version.Index++;
				s.UpdateStatus = broken
					? { State: "rollback_completed", Message: "task exited with code 1" }
					: { State: "completed" };
				return {};
			},
		},
		tasks: {
			async list(filters) {
				const s = byId(filters?.service?.[0] ?? "");
				const image = s.Spec.TaskTemplate.ContainerSpec.Image;
				const stuck = o.stuck?.some((b) => image.startsWith(b));
				return [
					{
						Spec: { ContainerSpec: { Image: image } },
						Status: {
							State: stuck ? "starting" : "running",
							Err: stuck ? "health check failing" : undefined,
						},
						DesiredState: "running",
					} as Task,
				];
			},
		},
	};
	return { docker, calls, services };
}

/** Records drain, migrate and resume into the same call log as Swarm, so the order shows. */
function fakeGate(
	calls: string[],
	o: { drain?: string; migrate?: string } = {},
): UpdateGate {
	return {
		async drain(report) {
			calls.push("drain");
			await report.line("Waiting for 1 deployment");
			return o.drain ? { ok: false, error: o.drain } : { ok: true };
		},
		async resume() {
			calls.push("resume");
		},
		async migrate(image) {
			calls.push(`migrate ${image}`);
			if (o.migrate) throw new Error(o.migrate);
			return { ok: true };
		},
	};
}

function recorder() {
	const steps: Partial<Record<UpdateStep, UpdateStepState>> = pendingSteps(
		targets("x"),
	);
	const lines: string[] = [];
	return {
		steps,
		lines,
		report: {
			async step(step: UpdateStep, state: UpdateStepState) {
				steps[step] = state;
			},
			async line(text: string) {
				lines.push(text);
			},
		},
	};
}

function clock(): Pick<UpdateOptions, "now" | "sleep"> {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
	};
}

const opts = (o: Partial<UpdateOptions> = {}): UpdateOptions => ({
	local: false,
	timeoutMs: 60_000,
	pollMs: 1_000,
	...clock(),
	...o,
});

describe("runUpdate", () => {
	test("pulls every image first, then updates api, agent, caddy and the worker last", async () => {
		const swarm = fakeSwarm({});
		const r = recorder();
		expect(
			await runUpdate(
				swarm.docker,
				targets("0.2.0"),
				r.report,
				opts(),
				fakeGate(swarm.calls),
			),
		).toEqual({
			ok: true,
		});
		expect(swarm.calls).toEqual([
			...SERVICES.map(([, image]) => `pull ${REG}/${image}:0.2.0`),
			"drain",
			`migrate ${REG}/logistack:0.2.0${DIGEST}`,
			...SERVICES.map(
				([step, image]) =>
					`update logistack_${step} ${REG}/${image}:0.2.0${DIGEST}`,
			),
			"resume",
		]);
		expect(r.steps).toEqual({
			pull: "done",
			drain: "done",
			migrate: "done",
			"logistack-api": "done",
			"logistack-agent": "done",
			caddy: "done",
			"logistack-worker": "done",
		});
		// Only the image changes; the rest of the spec is the stack's.
		const api = swarm.services.get("logistack_logistack-api");
		expect(api?.Spec.Labels).toEqual({
			"com.docker.stack.namespace": "logistack",
		});
		expect(api?.Spec.TaskTemplate.ContainerSpec.Env).toEqual(["ROLE=x"]);
	});

	test("a failed pull aborts before any service changes", async () => {
		const swarm = fakeSwarm({ missing: [`${REG}/logistack-caddy:0.2.0`] });
		const r = recorder();
		const res = await runUpdate(
			swarm.docker,
			targets("0.2.0"),
			r.report,
			opts(),
			fakeGate(swarm.calls),
		);
		expect(res).toEqual({
			ok: false,
			error: `${REG}/logistack-caddy:0.2.0: manifest unknown`,
		});
		expect(swarm.calls.filter((c) => !c.startsWith("pull"))).toEqual([]);
		expect(r.steps.pull).toBe("failed");
		expect(r.steps["logistack-api"]).toBe("pending");
	});

	test("a service Swarm rolls back undoes the ones already updated, newest first, and stops", async () => {
		const swarm = fakeSwarm({ broken: [`${REG}/logistack-caddy:`] });
		const r = recorder();
		const res = await runUpdate(
			swarm.docker,
			targets("0.2.0"),
			r.report,
			opts(),
			fakeGate(swarm.calls),
		);
		expect(res.ok).toBe(false);
		expect(!res.ok && res.error).toBe(
			"caddy did not become healthy (task exited with code 1). Rolled back logistack-agent, logistack-api.",
		);
		expect(swarm.calls.filter((c) => c.startsWith("update"))).toEqual([
			`update logistack_logistack-api ${REG}/logistack:0.2.0${DIGEST}`,
			`update logistack_logistack-agent ${REG}/logistack-agent:0.2.0${DIGEST}`,
			`update logistack_caddy ${REG}/logistack-caddy:0.2.0${DIGEST}`,
			"update logistack_logistack-agent localhost/logistack-agent:0.1.0-local.abc",
			"update logistack_logistack-api localhost/logistack:0.1.0-local.abc",
		]);
		for (const [step, image] of SERVICES)
			expect(
				swarm.services.get(`logistack_${step}`)?.Spec.TaskTemplate.ContainerSpec
					.Image,
			).toBe(`localhost/${image}:0.1.0-local.abc`);
		expect(swarm.calls.at(-1)).toBe("resume");
		expect(r.steps).toEqual({
			pull: "done",
			drain: "done",
			migrate: "done",
			"logistack-api": "rolled_back",
			"logistack-agent": "rolled_back",
			caddy: "failed",
			"logistack-worker": "pending",
		});
	});

	test("a task that never turns healthy times out, and that service is restored too", async () => {
		const swarm = fakeSwarm({ stuck: [`${REG}/logistack:`] });
		const r = recorder();
		const res = await runUpdate(
			swarm.docker,
			targets("0.2.0"),
			r.report,
			opts({ timeoutMs: 5_000 }),
			fakeGate(swarm.calls),
		);
		expect(!res.ok && res.error).toBe(
			"logistack-api did not become healthy (not healthy after 5 s: health check failing).",
		);
		expect(swarm.calls.filter((c) => c.startsWith("update"))).toEqual([
			`update logistack_logistack-api ${REG}/logistack:0.2.0${DIGEST}`,
			"update logistack_logistack-api localhost/logistack:0.1.0-local.abc",
		]);
		expect(r.steps["logistack-api"]).toBe("failed");
		expect(r.steps["logistack-agent"]).toBe("pending");
	});

	test("local images are checked, not pulled, and keep their plain tag", async () => {
		const swarm = fakeSwarm({});
		const local = targets("0.2.0").map((t) => ({
			...t,
			image: t.image.replace(REG, "localhost"),
		}));
		const r = recorder();
		expect(
			await runUpdate(
				swarm.docker,
				local,
				r.report,
				opts({ local: true }),
				fakeGate(swarm.calls),
			),
		).toEqual({ ok: true });
		expect(swarm.calls).toEqual([
			"drain",
			"migrate localhost/logistack:0.2.0",
			...SERVICES.map(
				([step, image]) => `update logistack_${step} localhost/${image}:0.2.0`,
			),
			"resume",
		]);
	});

	test("a re-run skips services that already run the target", async () => {
		const swarm = fakeSwarm({});
		await runUpdate(
			swarm.docker,
			targets("0.2.0"),
			recorder().report,
			opts(),
			fakeGate(swarm.calls),
		);
		swarm.calls.length = 0;
		const r = recorder();
		expect(
			await runUpdate(
				swarm.docker,
				targets("0.2.0"),
				r.report,
				opts(),
				fakeGate(swarm.calls),
			),
		).toEqual({ ok: true });
		expect(swarm.calls.filter((c) => c.startsWith("update"))).toEqual([]);
		expect(r.steps["logistack-worker"]).toBe("done");
	});

	test("a drain that times out changes no service and resumes the queues", async () => {
		const swarm = fakeSwarm({});
		const r = recorder();
		const res = await runUpdate(
			swarm.docker,
			targets("0.2.0"),
			r.report,
			opts(),
			fakeGate(swarm.calls, { drain: "Gave up after 30 min" }),
		);
		expect(res).toEqual({ ok: false, error: "Gave up after 30 min" });
		expect(swarm.calls.filter((c) => !c.startsWith("pull"))).toEqual([
			"drain",
			"resume",
		]);
		expect(r.steps.drain).toBe("failed");
		expect(r.steps.migrate).toBe("pending");
		expect(r.lines).toContain("Waiting for 1 deployment");
	});

	test("a failed migration changes no service and resumes the queues", async () => {
		const swarm = fakeSwarm({});
		const r = recorder();
		const res = await runUpdate(
			swarm.docker,
			targets("0.2.0"),
			r.report,
			opts(),
			fakeGate(swarm.calls, { migrate: "the migration job failed" }),
		);
		expect(res).toEqual({ ok: false, error: "the migration job failed" });
		expect(swarm.calls.filter((c) => c.startsWith("update"))).toEqual([]);
		expect(swarm.calls.at(-1)).toBe("resume");
		expect(r.steps.drain).toBe("done");
		expect(r.steps.migrate).toBe("failed");
		expect(r.steps["logistack-api"]).toBe("pending");
	});

	test("a disabled healthcheck from an older stack is dropped, so the image's check applies", async () => {
		const swarm = fakeSwarm({});
		const worker = swarm.services.get("logistack_logistack-worker");
		if (!worker) throw new Error("no worker");
		worker.Spec.TaskTemplate.ContainerSpec.Healthcheck = { Test: ["NONE"] };
		await runUpdate(
			swarm.docker,
			targets("0.2.0"),
			recorder().report,
			opts(),
			fakeGate(swarm.calls),
		);
		expect(worker.Spec.TaskTemplate.ContainerSpec.Healthcheck).toBeUndefined();
	});
});
