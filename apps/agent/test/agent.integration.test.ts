import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMessage, type EventEnvelope } from "@logistack/contracts";
import { createDockerClient } from "@logistack/docker";
import { RedisClient, type Server } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import {
	type Agents,
	METRICS_STREAM,
	mountAgentGateway,
	NODE_KEY,
	staticTokenAuth,
} from "../../server/src/agent-gateway.ts";
import { type Bus, createBus } from "../../server/src/events.ts";
import { setLogLevel } from "../../server/src/log.ts";

const socketPath = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const hasDocker = existsSync(socketPath);
const docker = createDockerClient({ socketPath });
const IMAGE = "busybox:1.37";
// Cleanup matches this exact per-run prefix only (CLAUDE.md, Docker test rules).
const PREFIX = `ls-test-agent-${Date.now().toString(36)}`;
const TEST_LABELS = { "logistack.test": "agent" };
const TOKEN = "lsn_test_token";
const ORG = "org_test";
const INTERVAL_MS = 1000;
const METRICS_PORT = 19_469 + Math.floor(Math.random() * 500);

let redis: RedisClient;
let bus: Bus;
let server: Server<unknown>;
let agents: Agents;
let agent: ReturnType<typeof Bun.spawn> | undefined;
let nodeId: string;
let serviceId: string;
let taskId: string;
const events: EventEnvelope[] = [];

async function waitFor<T>(
	what: string,
	fn: () => Promise<T | undefined | false> | T | undefined | false,
	ms = 20_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(100);
	}
}

function serve(port = 0) {
	const app = new Hono();
	agents = mountAgentGateway(app, {
		bus,
		redis,
		authenticate: staticTokenAuth(TOKEN, ORG),
		ttlSec: 2,
	});
	server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch: app.fetch,
		websocket,
	});
}

function spawnAgent() {
	agent = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
		env: {
			...process.env,
			LOGISTACK_API_URL: `http://127.0.0.1:${server.port}`,
			LOGISTACK_AGENT_TOKEN: TOKEN,
			LOGISTACK_AGENT_TOKEN_PATH: join(tmpdir(), `${PREFIX}-node-token`),
			LOGISTACK_NODE_ID: nodeId,
			LOGISTACK_NODE_HOSTNAME: "test-node",
			LOGISTACK_AGENT_INTERVAL_MS: String(INTERVAL_MS),
			LOGISTACK_AGENT_METRICS_PORT: String(METRICS_PORT),
		},
		stdout: "inherit",
		stderr: "inherit",
	});
}

const connected = () => agents.connected().some((n) => n.nodeId === nodeId);

async function sweep() {
	for (const s of await docker.services.list({ name: [PREFIX] }))
		if (s.Spec.Name.startsWith(PREFIX))
			await docker.services.remove(s.ID).catch(() => {});
	await waitFor("test containers to go", async () => {
		const left = (
			await docker.containers.list({ name: [PREFIX] }, true)
		).filter((c) => c.Names.some((n) => n.startsWith(`/${PREFIX}`)));
		for (const c of left)
			await docker.containers.remove(c.Id, true).catch(() => {});
		return left.length === 0;
	}).catch(() => {});
}

async function ensureImage(ref: string) {
	await docker.images.inspect(ref).catch(() => docker.images.pull(ref));
}

const text = (chunks: Uint8Array[]) => Buffer.concat(chunks).toString();

describe.skipIf(!hasDocker)("agent against the local daemon", () => {
	beforeAll(async () => {
		setLogLevel("silent");
		await Promise.all([ensureImage(IMAGE), ensureImage("redis:7-alpine")]);
		const r = await docker.containers.create(`${PREFIX}-redis`, {
			Image: "redis:7-alpine",
			Labels: TEST_LABELS,
			HostConfig: {
				PortBindings: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
			},
		} as never);
		await docker.containers.start(r.Id);
		const inspect = (await docker.containers.inspect(r.Id)) as unknown as {
			NetworkSettings: { Ports: Record<string, { HostPort: string }[]> };
		};
		const port = inspect.NetworkSettings.Ports["6379/tcp"]?.[0]?.HostPort;
		const url = `redis://127.0.0.1:${port}`;
		redis = new RedisClient(url);
		await waitFor("redis", () =>
			redis
				.ping()
				.then((p) => p === "PONG")
				.catch(() => false),
		);
		bus = await createBus(url);
		bus.onEvent((e) => events.push(e));

		nodeId = (await docker.info()).Swarm.NodeID;
		const svc = await docker.services.create({
			Name: `${PREFIX}-svc`,
			Labels: TEST_LABELS,
			TaskTemplate: {
				ContainerSpec: {
					Image: IMAGE,
					Labels: TEST_LABELS,
					Command: [
						"sh",
						"-c",
						"i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.2; done",
					],
				},
			},
			Mode: { Replicated: { Replicas: 1 } },
		});
		serviceId = svc.ID;
		taskId = await waitFor(
			"service task running",
			async () => {
				const tasks = await docker.tasks.list({ service: [serviceId] });
				return tasks.find((t) => t.Status.State === "running")?.ID;
			},
			60_000,
		);

		serve();
		spawnAgent();
		await waitFor("agent hello", connected);
	}, 120_000);

	afterAll(async () => {
		agent?.kill();
		server?.stop(true);
		bus?.close();
		redis?.close();
		await sweep();
	}, 60_000);

	test("hello registers the node in Redis and publishes node.joined", async () => {
		expect(agents.connected()[0]).toMatchObject({
			nodeId,
			hostname: "test-node",
			organizationId: ORG,
		});
		const stored = JSON.parse((await redis.get(NODE_KEY(nodeId))) as string);
		expect(stored).toMatchObject({ nodeId, version: "0.1.0" });
		await waitFor("node.joined", () =>
			events.find((e) => e.type === "node.joined" && e.resource.id === nodeId),
		);
	});

	test("rejects a wrong token", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/api/agent/ws`, {
			headers: {
				authorization: "Bearer lsn_wrong",
				upgrade: "websocket",
				connection: "upgrade",
				"sec-websocket-key": "x",
				"sec-websocket-version": "13",
			},
		});
		expect(res.status).toBe(401);
	});

	test("exec in a task container: stdin, stdout, stderr, exit code", async () => {
		const h = agents.exec(nodeId, {
			target: { kind: "task", taskId },
			cmd: ["sh", "-c", "read x; echo got:$x; echo oops >&2; exit 3"],
		});
		await h.write("hel");
		await h.write("lo\n");
		await h.end();
		const out: Uint8Array[] = [];
		const err: Uint8Array[] = [];
		let code: number | null | undefined;
		for await (const e of h) {
			if (e.type === "exit") code = e.code;
			else (e.stream === "stdout" ? out : err).push(e.data);
		}
		expect(text(out)).toBe("got:hello\n");
		expect(text(err)).toBe("oops\n");
		expect(code).toBe(3);
	});

	test("exec on an unknown task fails with not_found", async () => {
		const h = agents.exec(nodeId, {
			target: { kind: "task", taskId: "nope" },
			cmd: ["true"],
		});
		await expect(h.next()).rejects.toMatchObject({ code: "not_found" });
	});

	test("follow logs by service, and stopping closes the agent session", async () => {
		const lines: string[] = [];
		for await (const l of agents.followLogs(nodeId, {
			target: { kind: "service", serviceId },
			tail: 2,
		})) {
			lines.push(l.line);
			if (lines.length === 5) break;
		}
		for (const l of lines) expect(l).toMatch(/^\S+Z tick \d+$/);
		const n = lines.map((l) => Number(l.split(" ").at(-1)));
		expect(n).toEqual(n.toSorted((a, b) => a - b));
		await waitFor("agent session closed", async () =>
			(
				await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`).then((r) =>
					r.text(),
				)
			).includes("logistack_agent_sessions 0"),
		);
	});

	test("ephemeral container job echoes its stdin and is removed", async () => {
		const name = `${PREFIX}-job`;
		const script = `payload ${PREFIX}\n`;
		const out: Uint8Array[] = [];
		let result: unknown;
		for await (const e of agents.runJob(nodeId, {
			kind: "container",
			image: IMAGE,
			containerName: name,
			cmd: ["cat"],
			script,
			labels: TEST_LABELS,
			timeoutSec: 30,
		})) {
			if (e.type === "output") out.push(e.data);
			else result = e;
		}
		expect(text(out)).toBe(script);
		expect(result).toMatchObject({
			type: "result",
			exitCode: 0,
			bytes: script.length,
			truncated: false,
		});
		expect((await docker.containers.list({ name: [name] }, true)).length).toBe(
			0,
		);
	});

	test("exec job in a task: script on stdin, exit code, output limit", async () => {
		const events: unknown[] = [];
		for await (const e of agents.runJob(nodeId, {
			kind: "exec",
			target: { kind: "task", taskId },
			cmd: ["sh"],
			script: "echo 0123456789; exit 4\n",
			outputLimitBytes: 4,
			timeoutSec: 30,
		}))
			events.push(e.type === "output" ? Buffer.from(e.data).toString() : e);
		expect(events[0]).toBe("0123");
		expect(events.at(-1)).toMatchObject({
			exitCode: 4,
			bytes: 11,
			truncated: true,
		});
	});

	test("job timeout surfaces as an error and removes the container", async () => {
		const name = `${PREFIX}-slow`;
		const run = agents.runJob(nodeId, {
			kind: "container",
			image: IMAGE,
			containerName: name,
			script: "sleep 30\n",
			labels: TEST_LABELS,
			timeoutSec: 1,
		});
		await expect(run.next()).rejects.toMatchObject({ code: "timeout" });
		await waitFor(
			"job container removed",
			async () =>
				(await docker.containers.list({ name: [name] }, true)).length === 0,
		);
	});

	test("metrics land on ls:metrics with sane values", async () => {
		const entry = await waitFor("a metrics entry with cpu deltas", async () => {
			const rows = (await redis.send("XREVRANGE", [
				METRICS_STREAM,
				"+",
				"-",
				"COUNT",
				"1",
			])) as [string, string[]][];
			const fields = rows[0]?.[1];
			if (!fields) return undefined;
			const m = AgentMessage.parse(
				JSON.parse(fields[fields.indexOf("data") + 1] as string),
			);
			if (m.type !== "metrics") return undefined;
			const mine = m.containers.find((c) => c.taskId === taskId);
			return mine && fields[1] === nodeId ? { m, mine } : undefined;
		});
		const { m, mine } = entry;
		expect(mine.serviceId).toBe(serviceId);
		expect(mine.memoryBytes).toBeGreaterThan(0);
		expect(mine.memoryBytes).toBeLessThan(1e9);
		expect(mine.cpuPercent).toBeGreaterThanOrEqual(0);
		expect(Math.abs(m.at - Date.now())).toBeLessThan(60_000);
		if (process.platform === "linux") {
			expect(m.host?.memory.totalBytes).toBeGreaterThan(
				m.host?.memory.availableBytes ?? 0,
			);
			expect(m.host?.cpuPercent).toBeLessThanOrEqual(100);
			expect(m.host?.uptimeSec).toBeGreaterThan(0);
		} else expect(m.host).toBeNull();
		const prom = await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`).then(
			(r) => r.text(),
		);
		expect(prom).toContain(
			`logistack_container_memory_bytes{container="${mine.name}"`,
		);
		expect(prom).toContain("logistack_agent_connected 1");
	});

	test("reconnects after the server restarts, and serves requests again", async () => {
		const port = server.port as number;
		server.stop(true);
		await Bun.sleep(300);
		serve(port);
		await waitFor("agent reconnect", connected, 40_000);
		const h = agents.exec(nodeId, {
			target: { kind: "service", serviceId },
			cmd: ["echo", "again"],
			stdin: false,
		});
		const out: Uint8Array[] = [];
		for await (const e of h) if (e.type === "output") out.push(e.data);
		expect(text(out)).toBe("again\n");
	}, 60_000);

	test("node.down after the agent dies, node.recovered when it returns", async () => {
		agent?.kill();
		await agent?.exited;
		await waitFor(
			"node.down",
			() => events.find((e) => e.type === "node.down"),
			10_000,
		);
		spawnAgent();
		await waitFor(
			"node.recovered",
			() => events.find((e) => e.type === "node.recovered"),
			20_000,
		);
		expect(events.filter((e) => e.type === "node.joined")).toHaveLength(1);
	}, 40_000);
});
