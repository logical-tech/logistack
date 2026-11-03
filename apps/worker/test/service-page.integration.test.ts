import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditLog,
	createDb,
	type Db,
	deployment,
	runMigrations,
	serviceStatus,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { like } from "drizzle-orm";
import { loadConfig } from "../../server/src/config.ts";
import { startServer } from "../../server/src/index.ts";
import { setLogLevel } from "../../server/src/log.ts";
import { hasDocker, owner, setupBody } from "../../server/test/harness.ts";
import { createBus } from "../src/bus.ts";

// Real stack: Postgres, Redis, the api, an agent on this Swarm node, a Swarm service.
// Cleanup matches this run's exact prefix only (CLAUDE.md, Docker test rules).
const PREFIX = `ls-test-svc-${Date.now().toString(36)}`;
const LABEL = "logistack.test=svc";
const TEST_LABELS = { "logistack.test": "svc" };
const IMAGE = "busybox:1.37";
const ENROLLMENT = "b".repeat(64);
const TOKEN_PATH = join(tmpdir(), `${PREFIX}-node-token`);

const docker = createDockerClient();
let db: Db;
let running: Awaited<ReturnType<typeof startServer>>;
let agent: ReturnType<typeof Bun.spawn> | undefined;
let swarmNodeId: string;
let swarmServiceId: string;
let taskId: string;
let serviceId: string;
let cookie: string;

function sh(...argv: string[]) {
	const p = Bun.spawnSync(argv, { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

function container(suffix: string, image: string, port: number, env: string[]) {
	const name = `${PREFIX}-${suffix}`;
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		name,
		"--label",
		LABEL,
		"-p",
		`127.0.0.1::${port}`,
		...env.flatMap((e) => ["-e", e]),
		image,
	);
	return sh("docker", "port", name, `${port}/tcp`).split("\n")[0] as string;
}

async function waitFor<T>(
	what: string,
	fn: () => Promise<T | undefined | false> | T | undefined | false,
	ms = 30_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(100);
	}
}

const base = () => `127.0.0.1:${running.server.port}`;

async function api(method: string, path: string, body?: unknown) {
	const res = await fetch(`http://${base()}${path}`, {
		method,
		headers: {
			cookie,
			origin: "http://localhost:5173",
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	// biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary JSON.
	return { status: res.status, json: (await res.json()) as any };
}

/** A /ws-style socket that records every frame. */
async function socket(path: string) {
	const ws = new WebSocket(`ws://${base()}${path}`, {
		// Bun's WebSocket accepts headers, which the browser sends as cookies.
		headers: { cookie },
	} as unknown as string[]);
	ws.binaryType = "arraybuffer";
	const frames: (string | Uint8Array)[] = [];
	ws.onmessage = (e) =>
		frames.push(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
	const closed = new Promise<void>((r) => {
		ws.onclose = () => r();
	});
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error(`websocket ${path} failed`));
	});
	const json = () =>
		frames
			.filter((f): f is string => typeof f === "string")
			.map((f) => JSON.parse(f));
	return { ws, frames, json, closed };
}

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

describe.skipIf(!hasDocker)("service page on the real stack", () => {
	beforeAll(async () => {
		setLogLevel("silent");
		await docker.images.inspect(IMAGE).catch(() => docker.images.pull(IMAGE));
		const pg = container("pg", "postgres:17-alpine", 5432, [
			"POSTGRES_PASSWORD=test",
		]);
		const redisUrl = `redis://${container("redis", "redis:7-alpine", 6379, [])}`;
		const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
		await waitFor("postgres", () =>
			runMigrations(databaseUrl).then(
				() => true,
				() => false,
			),
		);
		db = createDb(databaseUrl, { onnotice: () => {} });

		swarmNodeId = (await docker.info()).Swarm.NodeID;
		swarmServiceId = (
			await docker.services.create({
				Name: `${PREFIX}-web`,
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
			})
		).ID;
		taskId = await waitFor(
			"service task running",
			async () =>
				(await docker.tasks.list({ service: [swarmServiceId] })).find(
					(t) => t.Status.State === "running",
				)?.ID,
			60_000,
		);

		running = await startServer(
			loadConfig({
				DATABASE_URL: databaseUrl,
				REDIS_URL: redisUrl,
				LOGISTACK_MASTER_KEY: crypto
					.getRandomValues(new Uint8Array(32))
					.toBase64(),
				BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
				BETTER_AUTH_URL: "http://localhost:3000",
				WEB_ORIGIN: "http://localhost:5173",
				LOG_LEVEL: "silent",
				PORT: "0",
				WEB_DIST_DIR: join(tmpdir(), `${PREFIX}-no-web`),
				LOGISTACK_AGENT_TOKEN: ENROLLMENT,
			}),
		);
		const setup = await fetch(`http://${base()}/api/setup`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify(setupBody),
		});
		expect(setup.status).toBe(201);
		const signIn = await fetch(`http://${base()}/api/auth/sign-in/email`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify({ email: owner.email, password: owner.password }),
		});
		cookie = signIn.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");

		agent = Bun.spawn(
			["bun", join(import.meta.dir, "../../agent/src/index.ts")],
			{
				env: {
					...process.env,
					LOGISTACK_API_URL: `http://${base()}`,
					LOGISTACK_AGENT_TOKEN: ENROLLMENT,
					LOGISTACK_AGENT_TOKEN_PATH: TOKEN_PATH,
					LOGISTACK_NODE_ID: swarmNodeId,
					LOGISTACK_NODE_HOSTNAME: "svc-node",
					LOGISTACK_AGENT_INTERVAL_MS: "1000",
					LOGISTACK_AGENT_METRICS_PORT: "0",
				},
				stdout: "ignore",
				stderr: "inherit",
			},
		);
		await waitFor(
			"agent connected",
			() => running.agents.connected().some((n) => n.nodeId === swarmNodeId),
			40_000,
		);

		const project = await api("POST", "/api/projects", { name: "Shop" });
		const envs = await api(
			"GET",
			`/api/projects/${project.json.id}/environments`,
		);
		serviceId = (
			await api("POST", `/api/environments/${envs.json[0].id}/services`, {
				name: "Web",
				spec: {
					kind: "application",
					source: { type: "image", image: IMAGE },
					build: { type: "image" },
					ports: [],
					replicas: 1,
					resources: {},
					placement: [],
				},
			})
		).json.id;
		// What the reconciler writes for the Swarm service; reconciling is not under test here.
		await db.insert(serviceStatus).values({
			serviceId,
			observed: "running",
			replicasRunning: 1,
			replicasDesired: 1,
			tasks: [
				{
					id: taskId,
					slot: 1,
					nodeId: swarmNodeId,
					state: "running",
					message: "started",
					error: null,
				},
			],
		});
	}, 180_000);

	afterAll(async () => {
		agent?.kill();
		await agent?.exited;
		await running?.stop();
		await db?.$client.end();
		rmSync(TOKEN_PATH, { force: true });
		await sweep();
		for (const s of ["pg", "redis"])
			Bun.spawnSync(["docker", "rm", "-f", "-v", `${PREFIX}-${s}`], {
				stdout: "ignore",
				stderr: "ignore",
			});
	}, 60_000);

	test("the overview names the replica's node", async () => {
		const res = await api("GET", `/api/services/${serviceId}/overview`);
		expect(res.status).toBe(200);
		expect(res.json.status.tasks).toEqual([
			expect.objectContaining({
				id: taskId,
				nodeId: swarmNodeId,
				hostname: "svc-node",
			}),
		]);
	});

	test("runtime logs stream through the api: tail, then live lines with replica and timestamp", async () => {
		const s = await socket("/ws");
		const channel = `service-logs:${serviceId}`;
		s.ws.send(
			JSON.stringify({ type: "subscribe", channel, options: { tail: 3 } }),
		);
		const lines = () => s.json().filter((m) => m.type === "line");
		await waitFor("six log lines", () => lines().length >= 6, 20_000);
		s.ws.send(JSON.stringify({ type: "unsubscribe", channel }));
		for (const l of lines().slice(0, 6)) {
			expect(l).toMatchObject({ channel, taskId, slot: 1, stream: "stdout" });
			expect(l.line).toMatch(/^tick \d+$/);
			expect(l.at).toMatch(/Z$/);
		}
		const ticks = lines().map((l) => Number(l.line.split(" ")[1]));
		expect(ticks.slice(1)).toEqual(ticks.slice(0, -1).map((n) => n + 1));
		s.ws.close();
	}, 30_000);

	test("a terminal session runs `echo hi` through the WebSocket bridge, and its end is audited", async () => {
		const ticket = await api("POST", `/api/services/${serviceId}/exec`, {
			shell: "sh",
			rows: 24,
			cols: 80,
		});
		expect(ticket.status).toBe(201);
		expect(ticket.json).toMatchObject({ taskId, nodeId: swarmNodeId });
		const t = await socket(`/ws/exec?ticket=${ticket.json.ticket}`);
		const output = () =>
			Buffer.concat(t.frames.filter((f) => f instanceof Uint8Array)).toString();
		await waitFor("ready", () => t.json().some((m) => m.type === "ready"));
		t.ws.send(JSON.stringify({ type: "resize", rows: 30, cols: 100 }));
		t.ws.send(JSON.stringify({ type: "input", data: "echo hi\n" }));
		// The TTY echoes the command; the answer is `hi` on a line of its own.
		await waitFor(
			"hi on its own line",
			() => /\r\nhi\r\n/.test(output()),
			15_000,
		);
		t.ws.send(JSON.stringify({ type: "input", data: "exit 7\n" }));
		await t.closed;
		expect(t.json().find((m) => m.type === "exit")).toEqual({
			type: "exit",
			code: 7,
		});

		const end = await waitFor("exec_end audit row", async () =>
			(
				await db
					.select()
					.from(auditLog)
					.where(like(auditLog.action, "service.exec%"))
			).find((r) => r.action === "service.exec_end"),
		);
		expect(end).toMatchObject({ resourceId: serviceId, outcome: "success" });
		expect(end.diff).toMatchObject({ taskId, shell: "sh", exitCode: 7 });

		const reused = await fetch(
			`http://${base()}/ws/exec?ticket=${ticket.json.ticket}`,
			{
				headers: { cookie, upgrade: "websocket" },
			},
		);
		expect(reused.status).toBe(403);
	}, 40_000);

	test("a deployment log over /ws: the stored lines, then live ones, each once", async () => {
		const [d] = await db
			.insert(deployment)
			.values({ serviceId, trigger: "manual", status: "building" })
			.returning();
		const id = (d as { id: string }).id;
		const bus = await createBus(running.deps.config.REDIS_URL);
		try {
			for (const n of [0, 1]) await bus.publishLog(id, `==> step ${n}`);
			const s = await socket("/ws");
			s.ws.send(
				JSON.stringify({ type: "subscribe", channel: `deployment-log:${id}` }),
			);
			await waitFor(
				"replay",
				() => s.json().filter((m) => m.type === "line").length === 2,
			);
			for (const n of [2, 3])
				await bus.publishLog(id, `\u001b[32m==> step ${n}\u001b[0m`);
			await waitFor(
				"live",
				() => s.json().filter((m) => m.type === "line").length === 4,
			);
			expect(
				s
					.json()
					.filter((m) => m.type === "line")
					.map((m) => [m.seq, m.line]),
			).toEqual([
				[0, "==> step 0"],
				[1, "==> step 1"],
				[2, "\u001b[32m==> step 2\u001b[0m"],
				[3, "\u001b[32m==> step 3\u001b[0m"],
			]);
			s.ws.close();
		} finally {
			bus.close();
		}
	}, 30_000);

	test("a subscription to a deployment log outside the organization is refused", async () => {
		const s = await socket("/ws");
		s.ws.send(
			JSON.stringify({ type: "subscribe", channel: "deployment-log:dep_nope" }),
		);
		await waitFor("error", () => s.json().some((m) => m.type === "error"));
		expect(s.json().find((m) => m.type === "error")).toMatchObject({
			code: "forbidden",
		});
		s.ws.close();
	});
});
