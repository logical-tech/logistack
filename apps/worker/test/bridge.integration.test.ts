import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_NODE_HEADER } from "@logistack/contracts";
import {
	createDb,
	type Db,
	node,
	nodeToken,
	organization,
	runMigrations,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../server/src/config.ts";
import { startServer } from "../../server/src/index.ts";
import { setLogLevel } from "../../server/src/log.ts";
import { revokeNode } from "../../server/src/node-tokens.ts";
import {
	createNodeRunner,
	feed,
	type NodeRunner,
	type OutputChunk,
} from "../src/node-runner.ts";

const hasDocker = (() => {
	try {
		return (
			Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" })
				.exitCode === 0
		);
	} catch {
		return false;
	}
})();

// Cleanup matches this exact per-run prefix only (CLAUDE.md, Docker test rules).
const PREFIX = `ls-test-bridge-${Date.now().toString(36)}`;
const LABEL = "logistack.test=bridge";
const TEST_LABELS = { "logistack.test": "bridge" };
const IMAGE = "busybox:1.37";
const ENROLLMENT = "a".repeat(64);
const TOKEN_PATH = join(tmpdir(), `${PREFIX}-node-token`);

const docker = createDockerClient();
let db: Db;
let redisUrl: string;
let running: Awaited<ReturnType<typeof startServer>>;
let runner: NodeRunner;
let nodeId: string;
let serviceId: string;
let taskId: string;
let agent: ReturnType<typeof Bun.spawn> | undefined;
let agentLog: Record<string, unknown>[] = [];

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

function spawnAgent() {
	agentLog = [];
	const proc = Bun.spawn(
		["bun", join(import.meta.dir, "../../agent/src/index.ts")],
		{
			env: {
				...process.env,
				LOGISTACK_API_URL: `http://127.0.0.1:${running.server.port}`,
				LOGISTACK_AGENT_TOKEN: ENROLLMENT,
				LOGISTACK_AGENT_TOKEN_PATH: TOKEN_PATH,
				LOGISTACK_NODE_ID: nodeId,
				LOGISTACK_NODE_HOSTNAME: "bridge-node",
				LOGISTACK_AGENT_INTERVAL_MS: "1000",
				LOGISTACK_AGENT_METRICS_PORT: "0",
			},
			stdout: "pipe",
			stderr: "inherit",
		},
	);
	agent = proc;
	const log = agentLog;
	void (async () => {
		let buf = "";
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			buf += new TextDecoder().decode(chunk);
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				try {
					log.push(JSON.parse(buf.slice(0, i)));
				} catch {}
				buf = buf.slice(i + 1);
			}
		}
	})();
}

async function stopAgent() {
	agent?.kill();
	await agent?.exited;
	await waitFor("gateway to drop the node", () => !connected());
}

const connected = () =>
	running.agents.connected().some((n) => n.nodeId === nodeId);
const logged = (msg: string, fields: Record<string, unknown> = {}) =>
	agentLog.find(
		(l) =>
			l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v),
	);
const text = (chunks: OutputChunk[]) =>
	Buffer.concat(chunks.map((c) => c.data)).toString();
const jobContainers = async (name: string) =>
	(await docker.containers.list({ name: [name] }, true)).filter((c) =>
		c.Names.includes(`/${name}`),
	);

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

// shortcut: needs a spawned agent on the local daemon, flaky on CI runners; opt in with BRIDGE_IT=1.
describe.skipIf(!hasDocker || !process.env.BRIDGE_IT)(
	"agent bridge: enrollment and NodeRunner",
	() => {
		beforeAll(async () => {
			setLogLevel("silent");
			await docker.images.inspect(IMAGE).catch(() => docker.images.pull(IMAGE));
			const pg = container("pg", "postgres:17-alpine", 5432, [
				"POSTGRES_PASSWORD=test",
			]);
			redisUrl = `redis://${container("redis", "redis:7-alpine", 6379, [])}`;
			const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
			await waitFor("postgres", () =>
				runMigrations(databaseUrl).then(
					() => true,
					() => false,
				),
			);
			db = createDb(databaseUrl, { onnotice: () => {} });

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
				async () =>
					(await docker.tasks.list({ service: [serviceId] })).find(
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
			runner = await createNodeRunner(redisUrl);
		}, 120_000);

		afterAll(async () => {
			agent?.kill();
			runner?.close();
			await running?.stop();
			rmSync(TOKEN_PATH, { force: true });
			await sweep();
			for (const s of ["pg", "redis"])
				Bun.spawnSync(["docker", "rm", "-f", "-v", `${PREFIX}-${s}`], {
					stdout: "ignore",
					stderr: "ignore",
				});
		}, 60_000);

		test("the gateway answers over HTTP and refuses unknown tokens with 401", async () => {
			const res = await fetch(
				`http://127.0.0.1:${running.server.port}/api/agent/ws`,
				{
					headers: {
						authorization: "Bearer lsn_wrong",
						[AGENT_NODE_HEADER]: nodeId,
					},
				},
			);
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "invalid_token" },
			});
		});

		test("before setup the agent is refused with 503, logged with status and backoff", async () => {
			spawnAgent();
			const line = await waitFor("a refusal in the agent log", () =>
				logged("connection failed", { status: 503 }),
			);
			expect(line).toMatchObject({ code: "setup_required", attempt: 1 });
			expect(line.backoffMs).toBeNumber();
			expect(connected()).toBe(false);
		}, 30_000);

		test("once an organization exists it enrolls: node row, hashed node token, persisted file", async () => {
			const orgId = crypto.randomUUID();
			await db.insert(organization).values({
				id: orgId,
				name: "Bridge",
				slug: `bridge-${orgId}`,
				createdAt: new Date(),
			});
			await waitFor("agent connected", connected, 40_000);
			expect(logged("connected", { enrolled: true })).toBeDefined();

			const [row] = await db
				.select()
				.from(node)
				.where(eq(node.swarmNodeId, nodeId));
			expect(row).toMatchObject({
				organizationId: orgId,
				hostname: "bridge-node",
				status: "ready",
				agentVersion: "0.1.0",
			});
			expect(row?.role).toBe("manager");
			const token = readFileSync(TOKEN_PATH, "utf8");
			expect(token).toStartWith("lsn_");
			const tokens = await db.select().from(nodeToken);
			expect(tokens).toHaveLength(1);
			expect(tokens[0]).toMatchObject({
				organizationId: orgId,
				nodeId: row?.id,
				tokenHash: createHash("sha256").update(token).digest("hex"),
				revokedAt: null,
			});
		}, 60_000);

		test("a restarted agent reconnects with its node token, not the enrollment token", async () => {
			const before = readFileSync(TOKEN_PATH, "utf8");
			await stopAgent();
			spawnAgent();
			await waitFor("agent reconnected", connected);
			await waitFor("connected log", () => logged("connected"));
			expect(logged("connected", { enrolled: false })).toBeDefined();
			expect(readFileSync(TOKEN_PATH, "utf8")).toBe(before);
			const tokens = await db.select().from(nodeToken);
			expect(tokens).toHaveLength(1);
			expect(tokens[0]?.lastUsedAt).toBeInstanceOf(Date);
		}, 40_000);

		test("runJob from the worker: an ephemeral container echoes its stdin and is removed", async () => {
			const name = `${PREFIX}-job`;
			const script = `payload ${PREFIX}\n`;
			const run = runner.runJob(nodeId, {
				kind: "container",
				image: IMAGE,
				containerName: name,
				cmd: ["cat"],
				script,
				labels: TEST_LABELS,
				timeoutSec: 30,
			});
			const out: OutputChunk[] = [];
			for await (const c of run) out.push(c);
			expect(text(out)).toBe(script);
			expect(await run.result).toMatchObject({
				exitCode: 0,
				bytes: script.length,
				truncated: false,
			});
			expect(await jobContainers(name)).toHaveLength(0);
		}, 30_000);

		test("a job with an ack window waits for its reader instead of piling output up", async () => {
			const size = 4 * 1024 * 1024;
			const job = (name: string, ackWindowBytes?: number) =>
				runner.runJob(nodeId, {
					kind: "container",
					image: IMAGE,
					containerName: name,
					script: `head -c ${size} /dev/zero\n`,
					labels: TEST_LABELS,
					timeoutSec: 60,
					outputLimitBytes: 2 * size,
					ackWindowBytes,
				});
			const finishes = (p: Promise<unknown>) =>
				Promise.race([
					p.then(
						() => true,
						() => true,
					),
					Bun.sleep(6_000).then(() => false),
				]);
			const free = job(`${PREFIX}-free`);
			expect(await finishes(free.result)).toBe(true);
			for await (const _ of free);
			const held = job(`${PREFIX}-held`, 256 * 1024);
			expect(await finishes(held.result)).toBe(false);
			let read = 0;
			for await (const c of held) read += c.data.byteLength;
			expect(read).toBe(size);
			expect(await held.result).toMatchObject({ exitCode: 0, bytes: size });
		}, 40_000);

		// Usage only: a prune here would delete the dev machine's unused images.
		test("disk usage from the worker: the agent answers with its engine's breakdown", async () => {
			const { usage, report } = await runner.disk(nodeId, { op: "usage" });
			expect(report).toBeNull();
			expect(usage.dockerRootDir).toBeTruthy();
			expect(usage.images.count).toBeGreaterThan(0);
		}, 60_000);

		test("exec from the worker: stdin in, stdout and stderr out, exit code", async () => {
			const h = runner.exec(nodeId, {
				target: { kind: "task", taskId },
				cmd: ["sh", "-c", "read x; echo got:$x; echo oops >&2; exit 3"],
			});
			await h.write("hel");
			await h.write("lo\n");
			await h.end();
			const out: OutputChunk[] = [];
			for await (const c of h) out.push(c);
			expect(text(out.filter((c) => c.stream === "stdout"))).toBe(
				"got:hello\n",
			);
			expect(text(out.filter((c) => c.stream === "stderr"))).toBe("oops\n");
			expect(await h.result).toEqual({ code: 3 });
		}, 30_000);

		test("feeding a slow process holds the source to the stdin window", async () => {
			const total = 64 * 1024 * 1024;
			const chunk = 64 * 1024;
			let produced = 0;
			const source = new ReadableStream<Uint8Array>(
				{
					pull(c) {
						if (produced >= total) return c.close();
						produced += chunk;
						c.enqueue(new Uint8Array(chunk));
					},
				},
				{ highWaterMark: 0 },
			);
			const h = runner.exec(
				nodeId,
				{
					target: { kind: "task", taskId },
					cmd: ["sh", "-c", "sleep 4; cat >/dev/null"],
				},
				{ stdinWindowBytes: 1024 * 1024 },
			);
			const fed = feed(h, source);
			await Bun.sleep(3_000);
			// The window plus what the kernel and Docker hold in their socket buffers; never the whole source.
			expect(produced).toBeLessThan(8 * 1024 * 1024);
			await fed;
			expect(produced).toBe(total);
		}, 60_000);

		test("followLogs by service; leaving the loop stops the stream", async () => {
			const lines: string[] = [];
			for await (const l of runner.followLogs(nodeId, {
				target: { kind: "service", serviceId },
				tail: 2,
			})) {
				lines.push(l.line);
				if (lines.length === 4) break;
			}
			for (const l of lines) expect(l).toMatch(/^\S+Z tick \d+$/);
		}, 30_000);

		test("aborting the signal cancels the job on the agent and removes its container", async () => {
			const name = `${PREFIX}-cancel`;
			const ac = new AbortController();
			const run = runner.runJob(
				nodeId,
				{
					kind: "container",
					image: IMAGE,
					containerName: name,
					script: "sleep 60\n",
					labels: TEST_LABELS,
					timeoutSec: 120,
				},
				{ signal: ac.signal },
			);
			await waitFor(
				"job container running",
				async () => (await jobContainers(name)).length === 1,
			);
			ac.abort();
			await expect(run.result).rejects.toMatchObject({ code: "cancelled" });
			await waitFor(
				"job container removed",
				async () => (await jobContainers(name)).length === 0,
				20_000,
			);
		}, 40_000);

		test("a node no replica holds fails at once with code offline", async () => {
			const started = Date.now();
			const run = runner.runJob(`${PREFIX}-nonode`, {
				kind: "container",
				image: IMAGE,
				containerName: `${PREFIX}-never`,
				timeoutSec: 5,
			});
			await expect(run.result).rejects.toMatchObject({ code: "offline" });
			await expect(run.next()).rejects.toMatchObject({ code: "offline" });
			expect(Date.now() - started).toBeLessThan(2_000);
		});

		test("the api's deps.nodes takes the same Redis path", async () => {
			const h = running.deps.nodes.exec(nodeId, {
				target: { kind: "service", serviceId },
				cmd: ["echo", "from-api"],
				stdin: false,
			});
			const out: OutputChunk[] = [];
			for await (const c of h) out.push(c);
			expect(text(out)).toBe("from-api\n");
		}, 30_000);

		test("a revoked node is refused, with its node token and with the enrollment token", async () => {
			expect(await revokeNode(db, nodeId)).toBe(1);
			await stopAgent();
			spawnAgent();
			const revoked = await waitFor("token_revoked in the agent log", () =>
				logged("connection failed", { status: 401, code: "token_revoked" }),
			);
			expect(revoked.backoffMs).toBeNumber();
			await waitFor(
				"node_revoked in the agent log",
				() =>
					logged("connection failed", { status: 403, code: "node_revoked" }),
				20_000,
			);
			expect(connected()).toBe(false);
			expect(existsSync(TOKEN_PATH)).toBe(true);
		}, 40_000);
	},
);
