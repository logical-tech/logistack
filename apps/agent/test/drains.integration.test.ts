import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DrainsConfig } from "@logistack/contracts";
import { createDockerClient } from "@logistack/docker";
import { RedisClient, type Server } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import {
	type Agents,
	DRAIN_STATUS_KEY,
	mountAgentGateway,
	staticTokenAuth,
} from "../../server/src/agent-gateway.ts";
import { type Bus, createBus } from "../../server/src/events.ts";
import { setLogLevel } from "../../server/src/log.ts";

// End to end: a real agent process, connected to an in-process gateway, ships the logs of a
// labelled container to a real Loki, and reports drain health back through Redis.

const socketPath = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const hasDocker = existsSync(socketPath);
const docker = createDockerClient({ socketPath });
const LOKI_IMAGE = "grafana/loki:3.4.2";
const IMAGE = "busybox:1.37";
// Cleanup matches this exact per-run prefix only (CLAUDE.md, Docker test rules).
const PREFIX = `ls-test-drains-${Date.now().toString(36)}`;
const TEST_LABELS = { "logistack.test": "drains" };
const TOKEN = "lsn_test_token";
const SERVICE_ID = `svc_${PREFIX.replace(/-/g, "")}`;
const DEPLOYMENT_ID = "dep_drains_test";

let redis: RedisClient;
let bus: Bus;
let server: Server<unknown>;
let agents: Agents;
let agent: ReturnType<typeof Bun.spawn> | undefined;
let nodeId: string;
let lokiUrl: string;

async function waitFor<T>(
	what: string,
	fn: () => Promise<T | undefined | false> | T | undefined | false,
	ms = 30_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await Promise.resolve()
			.then(fn)
			.catch(() => undefined);
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(250);
	}
}

async function ensureImage(ref: string) {
	await docker.images.inspect(ref).catch(() => docker.images.pull(ref));
}

/** Starts a container publishing `port` on a random loopback port; returns that port. */
async function run(
	name: string,
	body: Record<string, unknown>,
	port?: string,
): Promise<string | undefined> {
	const c = await docker.containers.create(`${PREFIX}-${name}`, {
		...body,
		HostConfig: port
			? { PortBindings: { [port]: [{ HostIp: "127.0.0.1", HostPort: "" }] } }
			: {},
	} as never);
	await docker.containers.start(c.Id);
	if (!port) return undefined;
	const inspect = (await docker.containers.inspect(c.Id)) as unknown as {
		NetworkSettings: { Ports: Record<string, { HostPort: string }[]> };
	};
	return inspect.NetworkSettings.Ports[port]?.[0]?.HostPort;
}

async function sweep() {
	const left = (await docker.containers.list({ name: [PREFIX] }, true)).filter(
		(c) => c.Names.some((n) => n.startsWith(`/${PREFIX}`)),
	);
	for (const c of left)
		await docker.containers.remove(c.Id, true).catch(() => {});
}

const config = (url: string): DrainsConfig => ({
	drains: [{ id: "lgd_test", config: { kind: "loki", url } }],
	routes: {
		[SERVICE_ID]: {
			drainIds: ["lgd_test"],
			meta: {
				organizationId: "org_test",
				organization: "Acme",
				projectId: "prj_test",
				project: "shop",
				environmentId: "env_test",
				environment: "production",
				serviceId: SERVICE_ID,
				service: "web",
			},
		},
	},
});

type LokiStream = {
	stream: Record<string, string>;
	values: [string, string][];
};

async function lokiQuery(query: string): Promise<LokiStream[]> {
	const u = new URL("/loki/api/v1/query_range", lokiUrl);
	u.searchParams.set("query", query);
	u.searchParams.set("start", String((Date.now() - 10 * 60_000) * 1e6));
	u.searchParams.set("limit", "1000");
	const res = await fetch(u);
	if (!res.ok) return [];
	return ((await res.json()) as { data: { result: LokiStream[] } }).data.result;
}

describe.skipIf(!hasDocker)("log drains against a real Loki", () => {
	beforeAll(async () => {
		setLogLevel("silent");
		await Promise.all([
			ensureImage(LOKI_IMAGE),
			ensureImage(IMAGE),
			ensureImage("redis:7-alpine"),
		]);
		const lokiPort = await run(
			"loki",
			{ Image: LOKI_IMAGE, Labels: TEST_LABELS },
			"3100/tcp",
		);
		lokiUrl = `http://127.0.0.1:${lokiPort}`;
		const redisPort = await run(
			"redis",
			{ Image: "redis:7-alpine", Labels: TEST_LABELS },
			"6379/tcp",
		);
		const redisUrl = `redis://127.0.0.1:${redisPort}`;
		redis = new RedisClient(redisUrl);
		await waitFor("redis", () => redis.ping().then((p) => p === "PONG"));
		bus = await createBus(redisUrl);
		await waitFor(
			"loki ready",
			() => fetch(`${lokiUrl}/ready`).then((r) => r.ok),
			90_000,
		);

		nodeId = (await docker.info()).Swarm.NodeID || "node-test";
		const app = new Hono();
		agents = mountAgentGateway(app, {
			bus,
			redis,
			authenticate: staticTokenAuth(TOKEN, "org_test"),
		});
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: app.fetch,
			websocket,
		});
		agent = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
			env: {
				...process.env,
				LOGISTACK_API_URL: `http://127.0.0.1:${server.port}`,
				LOGISTACK_AGENT_TOKEN: TOKEN,
				LOGISTACK_AGENT_TOKEN_PATH: join(tmpdir(), `${PREFIX}-node-token`),
				LOGISTACK_NODE_ID: nodeId,
				LOGISTACK_NODE_HOSTNAME: "drain-node",
				LOGISTACK_AGENT_METRICS_PORT: "0",
			},
			stdout: "ignore",
			stderr: "inherit",
		});
		await waitFor("agent hello", () =>
			agents.connected().some((n) => n.nodeId === nodeId),
		);
	}, 180_000);

	afterAll(async () => {
		agent?.kill();
		server?.stop(true);
		bus?.close();
		redis?.close();
		await sweep();
	}, 60_000);

	test("the agent announces the log-drains capability", () => {
		const node = agents.connected().find((n) => n.nodeId === nodeId);
		expect(node?.capabilities).toContain("log-drains");
	});

	test("a test event reaches Loki through the agent", async () => {
		const r = await agents.testDrain(nodeId, { kind: "loki", url: lokiUrl });
		expect(r).toMatchObject({ ok: true, status: 204 });
		const streams = await waitFor("test event in loki", async () => {
			const s = await lokiQuery('{service="logistack-test"}');
			return s.length > 0 && s;
		});
		expect(streams[0]?.stream.node).toBe("drain-node");
	});

	test("a failing destination reports the error, not its body", async () => {
		const r = await agents.testDrain(nodeId, {
			kind: "http",
			url: `${lokiUrl}/does-not-exist`,
			headers: {},
		});
		expect(r).toEqual({ ok: false, status: 404, error: "HTTP 404" });
	});

	test("a labelled container's logs arrive with the right labels", async () => {
		expect(agents.pushDrains(nodeId, config(lokiUrl))).toBe(true);
		await run("app", {
			Image: IMAGE,
			Cmd: [
				"sh",
				"-c",
				"i=0; while true; do echo hello $i; echo oops $i >&2; i=$((i+1)); sleep 0.2; done",
			],
			Labels: {
				...TEST_LABELS,
				"logistack.managed": "true",
				"logistack.resource": SERVICE_ID,
				"logistack.kind": "service",
				"logistack.org": "org_test",
				"logistack.deployment": DEPLOYMENT_ID,
			},
		});
		const streams = await waitFor(
			"container logs in loki",
			async () => {
				const s = await lokiQuery(`{service_id="${SERVICE_ID}"}`);
				return s.length >= 2 && s;
			},
			60_000,
		);
		const stdout = streams.find((s) => s.stream.stream === "stdout");
		expect(stdout?.stream).toMatchObject({
			source: "logistack",
			organization: "Acme",
			project: "shop",
			environment: "production",
			service: "web",
			service_id: SERVICE_ID,
			deployment_id: DEPLOYMENT_ID,
			node: "drain-node",
		});
		expect(stdout?.values.some(([, line]) => line.startsWith("hello "))).toBe(
			true,
		);
		const stderr = streams.find((s) => s.stream.stream === "stderr");
		expect(stderr?.values.some(([, line]) => line.startsWith("oops "))).toBe(
			true,
		);
	}, 90_000);

	test("drain health reaches Redis per node", async () => {
		const status = await waitFor("drain status", async () => {
			const raw = await redis.hget(DRAIN_STATUS_KEY("lgd_test"), nodeId);
			return raw && JSON.parse(raw);
		});
		expect(status).toMatchObject({
			drainId: "lgd_test",
			state: "ok",
			hostname: "drain-node",
			droppedLines: 0,
		});
		expect(status.sentLines).toBeGreaterThan(0);
	}, 40_000);

	test("removing the drain stops shipping", async () => {
		agents.pushDrains(nodeId, { drains: [], routes: {} });
		await Bun.sleep(2000);
		const count = async () =>
			(await lokiQuery(`{service_id="${SERVICE_ID}"}`)).reduce(
				(n, s) => n + s.values.length,
				0,
			);
		const before = await count();
		await Bun.sleep(3000);
		expect(await count()).toBe(before);
	}, 20_000);
});
