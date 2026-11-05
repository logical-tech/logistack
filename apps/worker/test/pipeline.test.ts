import { describe, expect, test } from "bun:test";
import type { DeploymentStatus } from "@logistack/contracts";
import { type DeploymentEvent, transition } from "@logistack/core";
import {
	type DeploymentRow,
	drive,
	Interrupted,
	planQueue,
	type Steps,
} from "../src/deploy.ts";

const row = (id: string, status: DeploymentStatus, minute: number) =>
	({
		id,
		serviceId: "svc_1",
		status,
		createdAt: new Date(2026, 10, 3, 10, minute),
	}) as DeploymentRow;

describe("planQueue", () => {
	test("newest queued runs, older queued are superseded by it", () => {
		const plan = planQueue([
			row("a", "queued", 1),
			row("c", "queued", 3),
			row("b", "queued", 2),
		]);
		expect(plan.kind).toBe("run");
		if (plan.kind !== "run") return;
		expect(plan.deployment.id).toBe("c");
		expect(plan.supersede.map((d) => d.id)).toEqual(["a", "b"]);
	});

	test("a deployment in flight is resumed, never superseded by newer queued ones", () => {
		const plan = planQueue([row("a", "building", 1), row("b", "queued", 2)]);
		expect(plan).toEqual({
			kind: "resume",
			deployment: row("a", "building", 1),
		});
	});

	test("deployments awaiting checks are the checks poller's, not the queue's", () => {
		const plan = planQueue([
			row("a", "queued", 1),
			row("b", "awaiting_checks", 2),
		]);
		expect(plan).toEqual({
			kind: "run",
			deployment: row("a", "queued", 1),
			supersede: [],
		});
		expect(planQueue([row("b", "awaiting_checks", 2)])).toEqual({
			kind: "idle",
		});
	});

	test("terminal rows are ignored", () => {
		expect(planQueue([row("a", "healthy", 1), row("b", "failed", 2)])).toEqual({
			kind: "idle",
		});
	});
});

/** In-memory store driven by the real state machine, like the DB-backed one. */
function harness(o: {
	status?: DeploymentStatus;
	source?: "git" | "image";
	push?: boolean;
	steps?: Partial<Steps>;
	moveRowOn?: DeploymentEvent["type"];
}) {
	let state: DeploymentStatus = o.status ?? "queued";
	const history: DeploymentStatus[] = [state];
	const calls: string[] = [];
	const patches: Record<string, unknown>[] = [];
	const controller = new AbortController();
	const step =
		<K extends keyof Steps>(name: K, fallback: Awaited<ReturnType<Steps[K]>>) =>
		async () => {
			calls.push(name);
			const s = o.steps?.[name] as (() => Promise<unknown>) | undefined;
			return (s ? await s() : fallback) as never;
		};
	const steps: Steps = {
		clone: step("clone", { commitSha: "abc" }),
		build: step("build", { imageRef: "r/o/s:dep" }),
		push: step("push", undefined),
		deploy: step("deploy", { ok: true }),
	};
	const run = () =>
		drive({
			status: state,
			source: o.source ?? "git",
			push: o.push ?? false,
			steps,
			signal: controller.signal,
			advance: async (e, patch = {}) => {
				if (e.type === o.moveRowOn) throw new Interrupted();
				const r = transition(state, e);
				if (!r.ok) throw new Error(`illegal ${e.type} from ${state}`);
				state = r.state;
				history.push(state);
				patches.push(patch);
				return state;
			},
		});
	return { run, history, calls, patches, controller };
}

describe("drive", () => {
	test("image source skips clone and build", async () => {
		const h = harness({ source: "image" });
		expect(await h.run()).toBe("healthy");
		expect(h.history).toEqual(["queued", "deploying", "healthy"]);
		expect(h.calls).toEqual(["deploy"]);
	});

	test("git source with a registry goes through every step", async () => {
		const h = harness({ push: true });
		expect(await h.run()).toBe("healthy");
		expect(h.history).toEqual([
			"queued",
			"cloning",
			"building",
			"pushing",
			"deploying",
			"healthy",
		]);
		expect(h.calls).toEqual(["clone", "build", "push", "deploy"]);
		expect(h.patches[1]).toEqual({ commitSha: "abc" });
		expect(h.patches[2]).toEqual({ imageRef: "r/o/s:dep" });
	});

	test("no registry skips pushing", async () => {
		const h = harness({ push: false });
		await h.run();
		expect(h.history).not.toContain("pushing");
		expect(h.calls).not.toContain("push");
	});

	test("a failing step fails the deployment with its error and stops", async () => {
		const h = harness({
			steps: {
				build: async () => {
					throw new Error("buildctl exited with code 1");
				},
			},
		});
		expect(await h.run()).toBe("failed");
		expect(h.calls).toEqual(["clone", "build"]);
		expect(h.patches.at(-1)).toMatchObject({
			error: "buildctl exited with code 1",
		});
	});

	test("a rolled back rollout ends failed and records the rollback", async () => {
		const h = harness({
			source: "image",
			steps: {
				deploy: async () => ({
					ok: false,
					error: "rolled back: update failed",
					rolledBack: true,
				}),
			},
		});
		expect(await h.run()).toBe("failed");
		expect(h.patches.at(-1)).toMatchObject({
			error: "rolled back: update failed",
		});
	});

	test("explicit cancel during a build ends cancelled", async () => {
		const h = harness({
			steps: {
				build: async () => {
					h.controller.abort("cancel");
					throw new Error("buildctl exited with code 137");
				},
			},
		});
		expect(await h.run()).toBe("cancelled");
		expect(h.calls).toEqual(["clone", "build"]);
		expect(h.patches.at(-1)).not.toHaveProperty("error");
	});

	test("shutdown during a build fails it; during a rollout it stays deploying for resume", async () => {
		const building = harness({
			steps: {
				build: async () => {
					building.controller.abort("shutdown");
					throw new Error("killed");
				},
			},
		});
		expect(await building.run()).toBe("failed");
		expect(building.patches.at(-1)).toMatchObject({
			error: "interrupted: the worker shut down",
		});

		const rolling = harness({
			source: "image",
			steps: {
				deploy: async () => {
					rolling.controller.abort("shutdown");
					throw new Error("aborted");
				},
			},
		});
		expect(await rolling.run()).toBe("deploying");
	});

	test("resume: deploying re-converges, a stranded build fails", async () => {
		const deploying = harness({ status: "deploying" });
		expect(await deploying.run()).toBe("healthy");
		expect(deploying.calls).toEqual(["deploy"]);

		const building = harness({ status: "building" });
		expect(await building.run()).toBe("failed");
		expect(building.calls).toEqual([]);
		expect(building.patches.at(-1)).toMatchObject({
			error: "interrupted: the worker stopped during building",
		});
	});

	test("a row moved by someone else (API cancel) stops the pipeline without writing", async () => {
		const h = harness({ moveRowOn: "cloned" });
		expect(await h.run()).toBe("cloning");
		expect(h.calls).toEqual(["clone"]);
	});
});
