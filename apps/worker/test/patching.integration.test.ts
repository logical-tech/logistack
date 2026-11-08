import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EventType } from "@logistack/contracts";
import { PATCH_ENV } from "@logistack/core";
import {
	createDb,
	node,
	nodePatchStatus,
	organization,
	patchRun,
	runMigrations,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import {
	claimRun,
	newRunNode,
	type PatchDeps,
	type PatchNode,
	processRun,
	scanNode,
	unhealthyServices,
} from "../src/patching.ts";

// Simulated nodes: privileged debian:12.0 containers (47 packages behind) stand in for hosts, a
// container restart stands in for a reboot. Drain and rejoin are recorded, not applied: draining
// the dev machine's only Swarm node would stop every other suite's services. A real replicated
// Swarm service is watched the whole time to prove nothing the run does takes it down.

const PREFIX = "ls-test-patching-";
const OUTDATED = "debian:12.0";

function sh(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args.join(" ")} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

const swarmActive = (() => {
	try {
		return sh("info", "--format", "{{.Swarm.LocalNodeState}}") === "active";
	} catch {
		return false;
	}
})();

/** Removes only this run's objects, by their exact prefix. */
function cleanup(tag: string) {
	if (!tag.startsWith(PREFIX)) return;
	const ls = (kind: string[]) =>
		Bun.spawnSync(["docker", ...kind, "--format", "{{.Names}}"], {
			stderr: "ignore",
		})
			.stdout.toString()
			.split("\n")
			.filter((n) => n.startsWith(`${tag}-`));
	for (const s of Bun.spawnSync(
		["docker", "service", "ls", "--format", "{{.Name}}"],
		{ stderr: "ignore" },
	)
		.stdout.toString()
		.split("\n")
		.filter((n) => n.startsWith(`${tag}-`)))
		Bun.spawnSync(["docker", "service", "rm", s], { stdout: "ignore" });
	for (const c of ls(["ps", "-a"]))
		Bun.spawnSync(["docker", "rm", "-f", "-v", c], { stdout: "ignore" });
}

describe.skipIf(!swarmActive)("node patching on simulated nodes", () => {
	const tag = `${PREFIX}${crypto.randomUUID().slice(0, 8)}`;
	const docker = createDockerClient();
	let db: ReturnType<typeof createDb>;
	const events: { type: EventType; payload: Record<string, unknown> }[] = [];
	const bus = {
		publish: async (
			type: EventType,
			_org: string,
			_r: unknown,
			payload: Record<string, unknown> = {},
		) => {
			events.push({ type, payload });
		},
	};
	let orgId: string;
	const rows: PatchNode[] = [];
	/** swarm node id -> container name */
	const hosts = new Map<string, string>();
	const drained = new Set<string>();
	let maxDrained = 0;
	const availability: string[] = [];

	const deps: PatchDeps = {
		host(n) {
			const name = hosts.get(n.swarmNodeId) as string;
			return {
				async run(argv, o = {}) {
					const p = Bun.spawn(
						[
							"docker",
							"exec",
							...PATCH_ENV.flatMap((e) => ["-e", e]),
							name,
							...argv,
						],
						{ stdout: "pipe", stderr: "pipe" },
					);
					const timer = setTimeout(
						() => p.kill(),
						(o.timeoutSec ?? 120) * 1000,
					);
					const [stdout, stderr, code] = await Promise.all([
						new Response(p.stdout).text(),
						new Response(p.stderr).text(),
						p.exited,
					]);
					clearTimeout(timer);
					return { code, stdout, stderr };
				},
				async reboot() {
					// /run is a tmpfs on a real host: the flag does not survive the boot.
					sh("exec", name, "rm", "-f", "/var/run/reboot-required");
					sh("restart", "-t", "1", name);
				},
			};
		},
		async setAvailability(n, a) {
			availability.push(`${n.hostname}:${a}`);
			if (a === "drain") drained.add(n.id);
			else drained.delete(n.id);
			maxDrained = Math.max(maxDrained, drained.size);
			await db.update(node).set({ desired: a }).where(eq(node.id, n.id));
		},
		tasksLeft: async () => 0,
		online: async (n) =>
			sh(
				"inspect",
				"--format",
				"{{.State.Running}}",
				hosts.get(n.swarmNodeId) as string,
			) === "true",
		unhealthy: () => unhealthyServices(docker, { name: [`${tag}-`] }),
		sleep: Bun.sleep,
		pollMs: 500,
		timeouts: {
			drainMs: 30_000,
			rejoinMs: 60_000,
			healthyMs: 60_000,
			upgradeSec: 900,
		},
	};

	let watching = true;
	const samples: number[] = [];
	let watcher: Promise<void> | undefined;

	beforeAll(async () => {
		sh("pull", "-q", OUTDATED);
		sh("pull", "-q", "alpine:3.22");
		sh("pull", "-q", "postgres:17-alpine");
		const pg = `${tag}-pg`;
		sh(
			"run",
			"-d",
			"--name",
			pg,
			"--label",
			"logistack.test=patching",
			"-e",
			"POSTGRES_PASSWORD=test",
			"-p",
			"127.0.0.1::5432",
			"postgres:17-alpine",
		);
		const url = `postgres://postgres:test@${sh("port", pg, "5432/tcp").split("\n")[0]}/postgres`;
		for (let i = 0; ; i++) {
			try {
				await runMigrations(url);
				break;
			} catch (e) {
				if (i > 60) throw e;
				await Bun.sleep(500);
			}
		}
		db = createDb(url, { onnotice: () => {} });
		orgId = `org_${tag}`;
		await db.insert(organization).values({
			id: orgId,
			name: "Patching",
			slug: tag,
			createdAt: new Date(),
		});

		for (const [i, image] of [OUTDATED, OUTDATED, "alpine:3.22"].entries()) {
			const name = `${tag}-n${i + 1}`;
			sh(
				"run",
				"-d",
				"--privileged",
				"--name",
				name,
				"--label",
				"logistack.test=patching",
				image,
				"sleep",
				"infinity",
			);
			hosts.set(name, name);
			const [row] = await db
				.insert(node)
				.values({
					organizationId: orgId,
					swarmNodeId: name,
					hostname: name,
					address: "127.0.0.1",
					role: "worker",
					status: "ready",
				})
				.returning();
			rows.push(row as PatchNode);
		}
		// The first node has a kernel update waiting for a reboot.
		sh("exec", `${tag}-n1`, "touch", "/var/run/reboot-required");

		sh(
			"service",
			"create",
			"--detach",
			"--name",
			`${tag}-web`,
			"--label",
			"logistack.test=patching",
			"--replicas",
			"2",
			"alpine:3.22",
			"sleep",
			"infinity",
		);
		for (let i = 0; (await deps.unhealthy()).length; i++) {
			if (i > 120) throw new Error("the watched service never started");
			await Bun.sleep(500);
		}
		watcher = (async () => {
			while (watching) {
				const [s] = await docker.services.list({ name: [`${tag}-web`] });
				samples.push(s?.ServiceStatus?.RunningTasks ?? 0);
				await Bun.sleep(1_000);
			}
		})();
	}, 300_000);

	afterAll(async () => {
		watching = false;
		await watcher;
		await db?.$client.end();
		cleanup(tag);
	});

	test("a scan finds the outdated packages and raises security events", async () => {
		const [n1] = rows;
		await scanNode({ db, bus }, deps, n1 as PatchNode);
		const [s] = await db
			.select()
			.from(nodePatchStatus)
			.where(eq(nodePatchStatus.nodeId, (n1 as PatchNode).id));
		expect(s?.packageManager).toBe("apt");
		expect(s?.os).toContain("Debian GNU/Linux 12");
		expect(s?.updates.length).toBeGreaterThan(10);
		expect(s?.securityCount).toBeGreaterThan(0);
		expect(s?.rebootRequired).toBe(true);
		expect(events.some((e) => e.type === "node.patches_available")).toBe(true);
	}, 300_000);

	test("a rolling run patches node after node and the service stays up", async () => {
		const [n1, n2] = rows as [PatchNode, PatchNode];
		const [queued] = await db
			.insert(patchRun)
			.values({
				organizationId: orgId,
				trigger: "manual",
				reboot: "if_needed",
				nodes: [n1, n2].map(newRunNode),
			})
			.returning();
		const run = await claimRun(db);
		expect(run?.id).toBe(queued?.id as string);
		await processRun({ db, bus }, deps, run as NonNullable<typeof run>);

		const [done] = await db
			.select()
			.from(patchRun)
			.where(eq(patchRun.id, run?.id as string));
		if (done?.state !== "succeeded") console.log(done?.log.join("\n"));
		expect(done?.state).toBe("succeeded");
		const [r1, r2] = done?.nodes ?? [];
		expect(r1?.state).toBe("succeeded");
		expect(r1?.rebooted).toBe(true);
		expect(r1?.upgraded).toBeGreaterThan(10);
		expect(r2?.state).toBe("succeeded");
		expect(r2?.rebooted).toBe(false);
		expect(r2?.upgraded).toBeGreaterThan(10);

		// One node at a time, each back to active.
		expect(maxDrained).toBe(1);
		expect(availability).toEqual([
			`${n1.hostname}:drain`,
			`${n1.hostname}:active`,
			`${n2.hostname}:drain`,
			`${n2.hostname}:active`,
		]);
		for (const n of [n1, n2]) {
			const [s] = await db
				.select()
				.from(nodePatchStatus)
				.where(eq(nodePatchStatus.nodeId, n.id));
			expect(s?.updates).toEqual([]);
			expect(s?.rebootRequired).toBe(false);
		}
		expect(events.at(-1)?.type).toBe("node.patch_succeeded");

		watching = false;
		await watcher;
		expect(samples.length).toBeGreaterThan(5);
		expect(Math.min(...samples)).toBe(2);
	}, 900_000);

	test("a node that cannot be patched stops the run and is left active", async () => {
		const [, n2, n3] = rows as [PatchNode, PatchNode, PatchNode];
		availability.length = 0;
		await db.insert(patchRun).values({
			organizationId: orgId,
			trigger: "manual",
			nodes: [n3, n2].map(newRunNode),
		});
		const run = await claimRun(db);
		await processRun({ db, bus }, deps, run as NonNullable<typeof run>);
		const [done] = await db
			.select()
			.from(patchRun)
			.where(eq(patchRun.id, run?.id as string));
		expect(done?.state).toBe("failed");
		expect(done?.nodes[0]?.step).toBe("scan");
		expect(done?.nodes[0]?.error).toContain("no supported package manager");
		expect(done?.nodes[1]?.state).toBe("skipped");
		expect(availability).toEqual([`${n3.hostname}:active`]);
		expect(events.at(-1)?.type).toBe("node.patch_failed");
	}, 120_000);
});
