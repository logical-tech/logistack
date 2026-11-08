import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_NODE_HEADER,
	AGENT_PROTOCOL_VERSION,
	AGENT_WS_PATH,
} from "@logistack/contracts";
import { createDb, node, organization, runMigrations } from "@logistack/db";
import { eq } from "drizzle-orm";
import { closeCluster, cluster } from "../src/cluster.ts";
import { setLogLevel } from "../src/log.ts";
import { revokeNode } from "../src/node-tokens.ts";
import { ACCESS_REVOKED } from "../src/ws.ts";
import { hasDocker, owner, setupBody, startInfra, webDist } from "./harness.ts";

/**
 * Two api processes on one Postgres and one Redis, behind a Caddy container that round-robins
 * between them, as `install/stack.yml` runs them with LOGISTACK_API_REPLICAS=2. Each test sends
 * the halves of an operation to different replicas, then one replica is killed mid-traffic.
 */

const AREA = "ha";
const TAG = `ls-test-${AREA}-${crypto.randomUUID().slice(0, 8)}`;
const CADDY = `${TAG}-caddy`;
const AGENT_TOKEN = "lsn_ha_enrollment_token";
const ORIGIN = "http://localhost:5173";

type Replica = {
	name: string;
	port: number;
	proc: ReturnType<typeof Bun.spawn>;
};

let infra: Awaited<ReturnType<typeof startInfra>>;
let dist: string;
let caddyfile: string;
let caddy: string;
let a: Replica;
let b: Replica;
let db: ReturnType<typeof createDb>;
let cookie: string;
let orgId: string;

function docker(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

async function waitFor<T>(
	what: string,
	fn: () => Promise<T | undefined | false> | T | undefined | false,
	ms = 20_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await Promise.resolve()
			.then(fn)
			.catch(() => undefined);
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(100);
	}
}

function freePort() {
	const s = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = s.port as number;
	s.stop(true);
	return port;
}

const env = () => ({
	DATABASE_URL: infra.databaseUrl,
	REDIS_URL: infra.redisUrl,
	LOGISTACK_MASTER_KEY: masterKey,
	BETTER_AUTH_SECRET: authSecret,
	BETTER_AUTH_URL: "http://localhost:3000",
	WEB_ORIGIN: ORIGIN,
	PUBLIC_IP: "203.0.113.7",
	LOG_LEVEL: "silent",
	WEB_DIST_DIR: dist,
	LOGISTACK_AGENT_TOKEN: AGENT_TOKEN,
});
const masterKey = crypto.getRandomValues(new Uint8Array(32)).toBase64();
const authSecret = crypto.randomUUID() + crypto.randomUUID();

async function startReplica(name: string): Promise<Replica> {
	const port = freePort();
	const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
		env: { ...process.env, ...env(), PORT: String(port) },
		stdout: "ignore",
		stderr: "inherit",
	});
	await waitFor(`replica ${name}`, async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`);
		return res.ok;
	});
	return { name, port, proc };
}

const at = (target: Replica | "caddy") =>
	target === "caddy" ? caddy : `127.0.0.1:${target.port}`;

async function call(
	target: Replica | "caddy",
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = { cookie },
) {
	const res = await fetch(`http://${at(target)}${path}`, {
		method,
		headers: {
			origin: ORIGIN,
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary JSON.
	let json: any = text;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, json, headers: res.headers };
}

async function signIn(
	target: Replica | "caddy",
	email: string,
	password: string,
) {
	const res = await call(
		target,
		"POST",
		"/api/auth/sign-in/email",
		{ email, password },
		{},
	);
	if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
	return res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
}

/** A browser tab's `/ws`: frames in order, and how it closed. */
function socket(target: Replica | "caddy", auth: string) {
	const frames: { type: string; channel?: string; event?: { type: string } }[] =
		[];
	const ws = new WebSocket(`ws://${at(target)}/ws`, {
		headers: { cookie: auth, origin: ORIGIN },
	} as never);
	const opened = new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("socket failed"));
	});
	const closed = new Promise<number>((resolve) => {
		ws.onclose = (e) => resolve(e.code);
	});
	ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
	const subscribe = async (channel: string) => {
		await opened;
		ws.send(JSON.stringify({ type: "subscribe", channel }));
		await waitFor(`subscribed to ${channel}`, () =>
			frames.some((f) => f.type === "subscribed" && f.channel === channel),
		);
	};
	return { ws, frames, closed, subscribe };
}

const usage = (marker: string) => ({
	at: Date.now(),
	dockerRootDir: marker,
	filesystem: null,
	images: { count: 0, bytes: 0, reclaimableBytes: 0 },
	containers: { count: 0, bytes: 0, reclaimableBytes: 0 },
	volumes: { count: 0, bytes: 0, reclaimableBytes: 0 },
	buildCache: { count: 0, bytes: 0, reclaimableBytes: 0 },
	logs: null,
	topVolumes: [],
});

/**
 * A node agent speaking just enough of the protocol: hello, then a `disk.result` naming `marker`
 * for each disk request. `reconnect` keeps dialing after the socket drops, as the real agent does.
 */
function fakeAgent(
	target: Replica | "caddy",
	nodeId: string,
	marker: string,
	o: { reconnect?: boolean } = {},
) {
	const state = {
		requests: 0,
		hellos: 0,
		ws: undefined as WebSocket | undefined,
		stopped: false,
		closed: [] as number[],
	};
	const dial = () => {
		const ws = new WebSocket(`ws://${at(target)}${AGENT_WS_PATH}`, {
			headers: {
				authorization: `Bearer ${AGENT_TOKEN}`,
				[AGENT_NODE_HEADER]: nodeId,
			},
		} as never);
		state.ws = ws;
		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					type: "hello",
					protocol: AGENT_PROTOCOL_VERSION,
					nodeId,
					hostname: `host-${nodeId}`,
					version: "test",
					capabilities: [],
				}),
			);
		ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data));
			if (m.type === "hello.ok") state.hellos++;
			if (m.type !== "disk.run") return;
			state.requests++;
			ws.send(
				JSON.stringify({
					type: "disk.result",
					id: m.id,
					usage: usage(marker),
					report: null,
				}),
			);
		};
		ws.onclose = (e) => {
			state.closed.push(e.code);
			if (o.reconnect && !state.stopped) setTimeout(dial, 200);
		};
	};
	dial();
	return {
		state,
		stop() {
			state.stopped = true;
			state.ws?.close();
		},
	};
}

const nodeRow = (swarmNodeId: string) =>
	waitFor(`node ${swarmNodeId}`, async () => {
		const [row] = await db
			.select({ id: node.id })
			.from(node)
			.where(eq(node.swarmNodeId, swarmNodeId));
		return row?.id;
	});

describe.skipIf(!hasDocker)("two api replicas behind Caddy", () => {
	beforeAll(async () => {
		setLogLevel("silent");
		infra = await startInfra(AREA, AREA);
		await runMigrations(infra.databaseUrl);
		db = createDb(infra.databaseUrl, { max: 2, onnotice: () => {} });
		dist = webDist();
		a = await startReplica("a");
		b = await startReplica("b");
		caddyfile = join(tmpdir(), `${TAG}-Caddyfile`);
		// Retries the next upstream while a dead one refuses connections, as the stack's Caddy does
		// through the Swarm VIP.
		writeFileSync(
			caddyfile,
			`{
	admin off
	auto_https off
}
:80 {
	reverse_proxy host.docker.internal:${a.port} host.docker.internal:${b.port} {
		lb_policy round_robin
		lb_try_duration 5s
		lb_try_interval 100ms
		fail_duration 10s
	}
}
`,
		);
		docker(
			"run",
			"-d",
			"--name",
			CADDY,
			"--label",
			`logistack.test=${AREA}`,
			"-p",
			"127.0.0.1::80",
			"-v",
			`${caddyfile}:/etc/caddy/Caddyfile:ro`,
			"caddy:2-alpine",
		);
		caddy = docker("port", CADDY, "80/tcp").split("\n")[0] as string;
		await waitFor("caddy", async () => {
			const res = await fetch(`http://${caddy}/api/health`);
			return res.ok;
		});

		expect((await call(a, "POST", "/api/setup", setupBody, {})).status).toBe(
			201,
		);
		cookie = await signIn(b, owner.email, owner.password);
		const [org] = await db.select({ id: organization.id }).from(organization);
		orgId = org?.id as string;
	}, 180_000);

	afterAll(async () => {
		for (const r of [a, b]) r?.proc.kill("SIGKILL");
		Bun.spawnSync(["docker", "rm", "-f", CADDY], {
			stdout: "ignore",
			stderr: "ignore",
		});
		closeCluster(infra?.redisUrl ?? "");
		await db?.$client.end();
		infra?.stop();
		if (dist) rmSync(dist, { recursive: true, force: true });
		if (caddyfile) rmSync(caddyfile, { force: true });
	});

	test("every request works whichever replica answers", async () => {
		// A session made on one replica is valid on the other; writes on one are read on the other.
		for (let i = 0; i < 6; i++) {
			const writer = i % 2 ? a : b;
			const reader = i % 2 ? b : a;
			const made = await call(writer, "POST", "/api/projects", {
				name: `Shop ${i}`,
			});
			expect(made.status).toBe(201);
			const got = await call(reader, "GET", `/api/projects/${made.json.id}`);
			expect(got.status).toBe(200);
			expect(got.json.name).toBe(`Shop ${i}`);
		}
		// And through Caddy, which alternates between them.
		for (let i = 0; i < 10; i++)
			expect((await call("caddy", "GET", "/api/projects")).status).toBe(200);
	});

	test("an agent RPC reaches the replica holding the node's newest socket", async () => {
		// Org events on /ws cross replicas: the socket is on B, the node joins on A.
		const tab = socket(b, cookie);
		await tab.subscribe(`org:${orgId}`);

		const nodeId = "ha-node-rpc";
		const old = fakeAgent(a, nodeId, "from-a");
		await waitFor("hello on a", () => old.state.hellos > 0);
		const id = await nodeRow(nodeId);
		await waitFor("node.joined on the other replica's socket", () =>
			tab.frames.some((f) => f.event?.type === "node.joined"),
		);

		for (const r of [a, b]) {
			const res = await call(r, "GET", `/api/nodes/${id}/disk`);
			expect(res.status).toBe(200);
			expect(res.json.dockerRootDir).toBe("from-a");
		}

		// The node reconnects to B while its socket on A stays open (half-open after a network
		// blip): only the replica holding the newest socket answers, wherever the call lands.
		const fresh = fakeAgent(b, nodeId, "from-b");
		await waitFor("hello on b", () => fresh.state.hellos > 0);
		const before = old.state.requests;
		for (const r of [a, b, a, b]) {
			const res = await call(r, "GET", `/api/nodes/${id}/disk`);
			expect(res.status).toBe(200);
			expect(res.json.dockerRootDir).toBe("from-b");
		}
		expect(old.state.requests).toBe(before);

		// Revoking the node's token closes its sockets, on whichever replicas hold them.
		expect(
			await revokeNode(db, cluster(infra.redisUrl), nodeId),
		).toBeGreaterThanOrEqual(0);
		await waitFor(
			"both sockets closed",
			() =>
				old.state.closed.includes(4001) && fresh.state.closed.includes(4001),
		);
		tab.ws.close();
	});

	test("a membership change applies at once to a socket on the other replica", async () => {
		const viewer = { name: "Vera", email: "vera@example.com" };
		const password = "viewer password 12";
		const invite = await call(a, "POST", "/api/invitations", {
			email: viewer.email,
			role: "viewer",
		});
		expect(invite.status).toBe(201);
		await call(
			a,
			"POST",
			"/api/auth/sign-up/email",
			{ ...viewer, password },
			{},
		);
		const vCookie = await signIn(a, viewer.email, password);
		expect(
			(
				await call(
					a,
					"POST",
					"/api/auth/organization/accept-invitation",
					{ invitationId: invite.json.id },
					{ cookie: vCookie },
				)
			).status,
		).toBe(200);

		const tab = socket(a, vCookie);
		await tab.subscribe(`org:${orgId}`);
		const members = await call(b, "GET", "/api/members");
		const member = members.json.find(
			(m: { email: string }) => m.email === viewer.email,
		);
		expect((await call(b, "DELETE", `/api/members/${member.id}`)).status).toBe(
			204,
		);
		expect(await tab.closed).toBe(ACCESS_REVOKED);
	});

	test("killing a replica interrupts nothing", async () => {
		const agent = fakeAgent("caddy", "ha-node-kill", "via-caddy", {
			reconnect: true,
		});
		await waitFor("agent through caddy", () => agent.state.hellos > 0);
		const id = await nodeRow("ha-node-kill");

		const statuses: number[] = [];
		let busy = true;
		const traffic = (async () => {
			while (busy)
				statuses.push((await call("caddy", "GET", "/api/projects")).status);
		})();
		await Bun.sleep(300);
		a.proc.kill("SIGKILL");
		await a.proc.exited;
		await Bun.sleep(1500);
		busy = false;
		await traffic;
		expect(statuses.length).toBeGreaterThan(10);
		expect(statuses.filter((s) => s !== 200)).toEqual([]);

		// The agent, wherever its socket was, is reachable again through the survivor.
		const disk = await waitFor(
			"disk through the surviving replica",
			async () => {
				const res = await call("caddy", "GET", `/api/nodes/${id}/disk`);
				return res.status === 200 && res.json;
			},
			15_000,
		);
		expect(disk.dockerRootDir).toBe("via-caddy");
		// New sockets and sessions work on the survivor.
		const tab = socket("caddy", cookie);
		await tab.subscribe(`org:${orgId}`);
		tab.ws.close();
		expect(
			(await call("caddy", "POST", "/api/projects", { name: "After" })).status,
		).toBe(201);
		agent.stop();
	}, 60_000);
});
