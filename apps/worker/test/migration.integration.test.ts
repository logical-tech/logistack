// Real Swarm: bind mount, host-mode UDP port, user and capabilities as the Dokploy migration needs.
// Opt in with WORKER_IT=1. Needs no Postgres or Redis: it drives the compiler and the apply path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileService } from "@logistack/core";
import { createDockerClient } from "@logistack/docker";
import { upsertService, waitForRollout } from "../src/apply.ts";
import type { Ctx } from "../src/ctx.ts";
import { hasDocker } from "./harness.ts";

const PREFIX = "ls-test-mig-";
const LABEL = { "logistack.test": "mig" };
const enabled = hasDocker && process.env.WORKER_IT === "1";
const docker = createDockerClient();
const ctx = { docker } as Ctx;

async function cleanup() {
	const ours = (n: string) => n.startsWith(PREFIX);
	for (const s of await docker.services.list({ name: [PREFIX] }))
		if (ours(s.Spec.Name)) await docker.services.remove(s.ID).catch(() => {});
	for (let i = 0; i < 40; i++) {
		const left = await docker.containers.list(
			{ label: ["logistack.test=mig"] },
			true,
		);
		if (
			!left.some((c) => ours(c.Labels["com.docker.swarm.service.name"] ?? ""))
		)
			break;
		await Bun.sleep(500);
	}
	for (const n of await docker.networks.list({ name: [PREFIX] }))
		if (ours(n.Name)) await docker.networks.remove(n.Id).catch(() => {});
}

async function until<T>(what: string, f: () => Promise<T | undefined>) {
	for (let i = 0; i < 60; i++) {
		const v = await f().catch(() => undefined);
		if (v) return v;
		await Bun.sleep(500);
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!enabled)("migration settings on the real Swarm", () => {
	let dir: string;
	let nodeId: string;
	const port = 30000 + Math.floor(Math.random() * 20000);
	const name = `${PREFIX}ls-svc-mig0000000000000000000000`;

	beforeAll(async () => {
		await cleanup();
		dir = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
		// The container runs as 845:845, which owns nothing on the host.
		await chmod(dir, 0o777);
		nodeId = (await docker.info()).Swarm.NodeID;
		const net = await docker.networks.create({
			Name: `${PREFIX}net`,
			Driver: "overlay",
			Attachable: true,
			Labels: LABEL,
		});
		const spec = compileService({
			service: {
				id: "svc_mig0000000000000000000000",
				organizationId: "org_test",
				environmentId: "env_test",
				slug: "echo",
				desiredState: "running",
				spec: {
					kind: "application",
					source: { type: "image", image: "alpine:3.21" },
					build: { type: "image" },
					ports: [{ target: 9999, published: port, protocol: "udp" }],
					replicas: 1,
					resources: {},
					placement: [],
					command: [
						"sh",
						"-c",
						"id -u > /data/whoami && exec nc -lu -p 9999 > /data/udp.txt",
					],
					mounts: [{ kind: "bind", hostPath: dir, target: "/data" }],
					user: "845:845",
					capAdd: ["NET_BIND_SERVICE"],
					capDrop: ["MKNOD"],
					restart: "on-failure",
				},
			},
			deploymentId: "dep_mig",
			context: { project: "p", environment: "e", service: "s", domains: [] },
			image: "alpine:3.21",
			env: {},
			mounts: [],
			domains: [],
			networks: { environment: net.Id, ingress: net.Id },
			pinNodeId: nodeId,
			fileIds: {},
			scope: { namePrefix: PREFIX, labels: LABEL },
		});
		expect(spec.Name).toBe(name);
		const applied = await upsertService(ctx, undefined, spec);
		const rollout = await waitForRollout(ctx, name, applied, {
			timeoutMs: 90_000,
			deploymentId: "dep_mig",
		});
		expect(rollout).toEqual({ ok: true });
	}, 120_000);

	afterAll(async () => {
		await cleanup();
		if (dir) await rm(dir, { recursive: true, force: true });
	}, 60_000);

	test("the live Swarm service carries the compiled settings", async () => {
		const live = await docker.services.inspect(name);
		const c = live.Spec.TaskTemplate.ContainerSpec;
		expect(c.User).toBe("845:845");
		expect(c.CapabilityAdd).toEqual(["CAP_NET_BIND_SERVICE"]);
		expect(c.CapabilityDrop).toEqual(["CAP_MKNOD"]);
		// Swarm stores ReadOnly only when true.
		expect(c.Mounts).toEqual([{ Type: "bind", Source: dir, Target: "/data" }]);
		expect(live.Spec.EndpointSpec?.Ports).toEqual([
			{
				Protocol: "udp",
				TargetPort: 9999,
				PublishedPort: port,
				PublishMode: "host",
			},
		]);
		expect(live.Spec.TaskTemplate.RestartPolicy?.Condition).toBe("on-failure");
		expect(live.Spec.TaskTemplate.Placement?.Constraints).toEqual([
			`node.id==${nodeId}`,
		]);
	});

	test("a file the container writes appears in the host directory", async () => {
		const uid = await until("whoami", async () =>
			(await readFile(join(dir, "whoami"), "utf8")).trim(),
		);
		expect(uid).toBe("845");
	});

	test("a UDP datagram to the published host port reaches the container", async () => {
		const payload = `ping-${crypto.randomUUID()}`;
		const got = await until("the datagram", async () => {
			// A host-network container is on the node's network, where host-mode ports bind.
			Bun.spawnSync(
				[
					"docker",
					"run",
					"--rm",
					"-i",
					"--label",
					"logistack.test=mig",
					"--network",
					"host",
					"alpine:3.21",
					"nc",
					"-u",
					"-w1",
					"127.0.0.1",
					String(port),
				],
				{
					stdin: Buffer.from(`${payload}\n`),
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			const text = await readFile(join(dir, "udp.txt"), "utf8");
			return text.includes(payload) ? text : undefined;
		});
		expect(got).toContain(payload);
	}, 60_000);
});
