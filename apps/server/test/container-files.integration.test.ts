import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContainerPath } from "@logistack/contracts";
import { auditLog, serviceStatus } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { RedisClient, type Server } from "bun";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import {
	type Agents,
	mountAgentGateway,
	staticTokenAuth,
} from "../src/agent-gateway.ts";
import { serveAgentRpc } from "../src/agent-rpc.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

// Cleanup matches this exact per-run prefix only (CLAUDE.md, Docker test rules).
const PREFIX = `ls-test-cfiles-${Date.now().toString(36)}`;
const TEST_LABELS = { "logistack.test": "cfiles" };
const IMAGE = "busybox:1.37";
const TOKEN = "lsn_cfiles_test";
const docker = createDockerClient();

let h: Harness;
let cookie: string;
let developer: string;
let serviceId: string;
let swarmServiceId: string;
let taskId: string;
let nodeId: string;
let agents: Agents;
let gateway: Server<unknown>;
let rpc: Awaited<ReturnType<typeof serveAgentRpc>>;
let redis: RedisClient;
let agent: ReturnType<typeof Bun.spawn> | undefined;

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

const q = (path: string, extra: Record<string, string> = {}) =>
	new URLSearchParams({ path, ...extra }).toString();
const get = (route: string, path: string, who = cookie) =>
	h.call(
		"GET",
		`/api/services/${serviceId}/container-files${route}?${q(path)}`,
		{
			headers: { cookie: who },
		},
	);
const upload = (path: string, data: Uint8Array | string, who = cookie) =>
	h.app.request(
		`/api/services/${serviceId}/container-files/upload?${q(path)}`,
		{
			method: "PUT",
			headers: {
				cookie: who,
				origin: h.config.WEB_ORIGIN,
				"content-type": "application/octet-stream",
			},
			body: data,
		},
	);

/** What the container itself sees, through a plain exec. */
async function inContainer(...cmd: string[]) {
	const out: Uint8Array[] = [];
	for await (const e of agents.exec(nodeId, {
		target: { kind: "task", taskId },
		cmd,
		stdin: false,
	}))
		if (e.type === "output") out.push(e.data);
	return Buffer.concat(out).toString();
}

test("normalizeContainerPath keeps paths inside the root and in normal form", () => {
	expect(normalizeContainerPath("/")).toBe("/");
	expect(normalizeContainerPath("//etc/./ssl//")).toBe("/etc/ssl");
	for (const bad of ["etc", "", "/etc/../root", "/..", "/a\nb", "/a\u0000"])
		expect(() => normalizeContainerPath(bad)).toThrow();
});

describe.skipIf(!hasDocker)("container file browser, end to end", () => {
	beforeAll(async () => {
		h = await startHarness({ area: "cfiles", label: "cfiles" });
		await docker.images.inspect(IMAGE).catch(() => docker.images.pull(IMAGE));
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Files" },
		});
		const envId = (
			await h.call("GET", `/api/projects/${prj.json.id}/environments`, {
				headers: { cookie },
			})
		).json[0].id;
		serviceId = (
			await h.call("POST", `/api/environments/${envId}/services`, {
				headers: { cookie },
				body: {
					name: "web",
					spec: {
						kind: "application",
						source: { type: "image", image: IMAGE },
						build: { type: "image" },
						ports: [],
						replicas: 1,
						resources: {},
						placement: [],
					},
				},
			})
		).json.id;

		const user = { name: "dev", email: "dev@example.com" };
		const password = "developer password 12";
		const invite = await h.call("POST", "/api/invitations", {
			headers: { cookie },
			body: { email: user.email, role: "developer" },
		});
		await h.call("POST", "/api/auth/sign-up/email", {
			body: { ...user, password },
		});
		developer = await h.signIn(user.email, password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			headers: { cookie: developer },
			body: { invitationId: invite.json.id },
		});

		// The replica the reconciler would have recorded: a real task on this node.
		nodeId = (await docker.info()).Swarm.NodeID;
		const svc = await docker.services.create({
			Name: `${PREFIX}-svc`,
			Labels: TEST_LABELS,
			TaskTemplate: {
				ContainerSpec: {
					Image: IMAGE,
					Labels: TEST_LABELS,
					Command: ["sleep", "3600"],
				},
			},
			Mode: { Replicated: { Replicas: 1 } },
		});
		swarmServiceId = svc.ID;
		taskId = await waitFor(
			"service task running",
			async () =>
				(await docker.tasks.list({ service: [swarmServiceId] })).find(
					(t) => t.Status.State === "running",
				)?.ID,
			60_000,
		);
		await h.deps.db.insert(serviceStatus).values({
			serviceId,
			observed: "running",
			tasks: [{ id: taskId, slot: 1, nodeId, state: "running", error: null }],
		});

		// The agent dials a gateway on the harness's Redis, which h.deps.nodes reaches.
		const app = new Hono();
		redis = new RedisClient(h.config.REDIS_URL);
		agents = mountAgentGateway(app, {
			bus: h.deps.bus,
			redis,
			authenticate: staticTokenAuth(TOKEN, "org"),
		});
		rpc = await serveAgentRpc(agents, h.config.REDIS_URL);
		gateway = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: app.fetch,
			websocket,
		});
		agent = Bun.spawn(
			["bun", join(import.meta.dir, "../../agent/src/index.ts")],
			{
				env: {
					...process.env,
					LOGISTACK_API_URL: `http://127.0.0.1:${gateway.port}`,
					LOGISTACK_AGENT_TOKEN: TOKEN,
					LOGISTACK_AGENT_TOKEN_PATH: join(tmpdir(), `${PREFIX}-node-token`),
					LOGISTACK_NODE_ID: nodeId,
					LOGISTACK_NODE_HOSTNAME: "cfiles-node",
					LOGISTACK_AGENT_METRICS_PORT: "0",
				},
				stdout: "ignore",
				stderr: "inherit",
			},
		);
		await waitFor("agent connected", () =>
			agents.connected().some((n) => n.nodeId === nodeId),
		);
	}, 180_000);

	afterAll(async () => {
		agent?.kill();
		rpc?.close();
		gateway?.stop(true);
		redis?.close();
		rmSync(join(tmpdir(), `${PREFIX}-node-token`), { force: true });
		await sweep();
		await h?.close();
	}, 60_000);

	test("lists the root, directories first, hard-linked files with their size", async () => {
		const r = await get("", "/");
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({
			taskId,
			path: "/",
			entry: { type: "dir" },
			truncated: false,
		});
		const names = r.json.entries.map((e: { name: string }) => e.name);
		expect(names).toContain("etc");
		expect(names).toContain("bin");
		expect(r.json.entries[0].type).toBe("dir");

		const bin = await get("", "/bin");
		const byName = Object.fromEntries(
			bin.json.entries.map((e: { name: string }) => [e.name, e]),
		);
		// busybox: `[` is the binary, every applet a hard link to it.
		expect(byName["["]).toMatchObject({ type: "file" });
		expect(byName["["].size).toBeGreaterThan(100_000);
		expect(byName.ls).toMatchObject({ type: "file", size: byName["["].size });
	});

	test("follows a symlink to the file it names", async () => {
		const r = await get("", "/usr/bin/env");
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({
			path: "/bin/env",
			entry: { name: "env", type: "file" },
			entries: null,
		});
	});

	test("uploads a file, reads it back, and the container sees it; the write is audited", async () => {
		const res = await upload("/tmp/hello.txt", "hi from the browser\n");
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ path: "/tmp/hello.txt" });
		expect(await inContainer("cat", "/tmp/hello.txt")).toBe(
			"hi from the browser\n",
		);

		const view = await get("/content", "/tmp/hello.txt");
		expect(view.json).toMatchObject({
			path: "/tmp/hello.txt",
			size: 20,
			truncated: false,
			binary: false,
			content: "hi from the browser\n",
		});
		const dl = await h.app.request(
			`/api/services/${serviceId}/container-files/download?${q("/tmp/hello.txt")}`,
			{ headers: { cookie } },
		);
		expect(dl.status).toBe(200);
		expect(dl.headers.get("content-disposition")).toContain("hello.txt");
		expect(await dl.text()).toBe("hi from the browser\n");

		const [row] = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "service.container_file_upload"),
					eq(auditLog.outcome, "success"),
				),
			);
		expect(row?.resourceId).toBe(serviceId);
		expect(row?.diff).toMatchObject({
			path: "/tmp/hello.txt",
			bytes: 20,
			taskId,
		});
	});

	test("a big file is cut at 1 MB in the viewer and flagged; NUL bytes mark it binary", async () => {
		const big = new Uint8Array(1024 * 1024 + 10).fill(97);
		expect((await upload("/tmp/big.txt", big)).status).toBe(201);
		const view = await get("/content", "/tmp/big.txt");
		expect(view.json).toMatchObject({ size: big.length, truncated: true });
		expect(view.json.content).toHaveLength(1024 * 1024);

		expect((await upload("/tmp/blob", new Uint8Array([1, 0, 2]))).status).toBe(
			201,
		);
		expect((await get("/content", "/tmp/blob")).json).toMatchObject({
			binary: true,
			content: null,
		});
	});

	test("refusals: traversal, a directory as a file, a missing path, a missing directory", async () => {
		expect((await get("", "/etc/../root")).status).toBe(400);
		expect((await get("", "relative")).status).toBe(400);
		expect((await get("/content", "/etc")).status).toBe(400);
		expect((await get("", "/nope")).status).toBe(404);
		expect((await upload("/nope/x.txt", "x")).status).toBe(404);
		// The engine never swaps a directory for a file.
		const swap = await upload("/tmp", "x");
		expect(swap.status).toBe(409);
		expect(await swap.text()).toContain("cannot overwrite directory");
		expect((await upload("/", "x")).status).toBe(400);
	});

	test("a developer (no exec permission) is refused, and the denied write is audited", async () => {
		expect((await get("", "/", developer)).status).toBe(403);
		expect((await upload("/tmp/dev.txt", "x", developer)).status).toBe(403);
		const denied = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "service.container_file_upload"),
					eq(auditLog.outcome, "denied"),
				),
			);
		expect(denied).toHaveLength(1);
		expect(await inContainer("ls", "/tmp")).not.toContain("dev.txt");
	});

	test("a task id of another service is never reached", async () => {
		const r = await h.call(
			"GET",
			`/api/services/${serviceId}/container-files?${q("/", { taskId: "someone-elses-task" })}`,
			{ headers: { cookie } },
		);
		expect(r.status).toBe(409);
		expect(r.json.error.details).toMatchObject({ reason: "not_running" });
	});
});
