// End to end: a real Caddy (the compiler's access-log config and analytics route) in front of a
// host upstream, the real agent process following Caddy's log, the gateway and traffic sync of
// the server, the worker's store, then the REST API. Load with known latencies and statuses must
// come back as the right counts and percentiles; the agent's memory must stay bounded while the
// server is down; no client IP may reach Postgres or Redis.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRAFFIC_STREAM } from "@logistack/contracts";
import { createMetricsConsumer } from "@logistack/worker/metrics-consumer";
import { storeTrafficEntries } from "@logistack/worker/traffic-store";
import { RedisClient } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { compileProxy } from "../../../packages/proxy/src/index.ts";
import { mountAgentGateway, staticTokenAuth } from "../src/agent-gateway.ts";
import { startTrafficSync } from "../src/traffic-sync.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const PREFIX = `ls-test-traffic-${crypto.randomUUID().slice(0, 8)}`;
const CADDY = `${PREFIX}-caddy`;
/** The agent finds Caddy by this Swarm label; a plain container can carry it too. */
const CADDY_SERVICE = `${PREFIX}-svc`;
const HOST = "shop.traffic.test";
const N = 1200;

const sh = (...argv: string[]) => {
	const p = Bun.spawnSync(argv, { stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr}`);
	return p.stdout.toString().trim();
};
const rss = (pid: number) =>
	Number(sh("ps", "-o", "rss=", "-p", String(pid))) * 1024;

describe.skipIf(!hasDocker)("traffic end to end", () => {
	let h: Harness;
	let cookie: string;
	let serviceId: string;
	let domainId: string;
	let agent: ReturnType<typeof Bun.spawn> | undefined;
	let gateway: ReturnType<typeof Bun.serve> | undefined;
	let gatewayPort = 0;
	let upstream: ReturnType<typeof Bun.serve>;
	let caddyPort = "";
	let tmp: string;
	let agentOut = "";
	const stops: (() => unknown)[] = [];
	const as = (o: { body?: unknown } = {}) => ({ ...o, headers: { cookie } });

	function startGateway() {
		const redis = new RedisClient(h.config.REDIS_URL);
		const app = new Hono();
		const agents = mountAgentGateway(app, {
			bus: h.deps.bus,
			redis,
			authenticate: staticTokenAuth("lsn_traffic", "org"),
		});
		gateway = Bun.serve({
			hostname: "127.0.0.1",
			port: gatewayPort,
			fetch: app.fetch,
			websocket,
		});
		gatewayPort = gateway.port ?? 0;
		return startTrafficSync({
			db: h.deps.db,
			agents,
			redisUrl: h.config.REDIS_URL,
			caddyService: CADDY_SERVICE,
			refreshMs: 2_000,
		});
	}

	async function load(
		n: number,
		path: (i: number) => string,
		ua = (i: number) => `Mozilla/5.0 (X11) Firefox/${100 + (i % 37)}.0`,
	) {
		for (let i = 0; i < n; i += 50)
			await Promise.all(
				Array.from({ length: Math.min(50, n - i) }, async (_, j) => {
					const k = i + j;
					const res = await fetch(`http://${caddyPort}${path(k)}`, {
						headers: { Host: HOST, "User-Agent": ua(k), Accept: "text/html" },
					});
					await res.arrayBuffer();
				}),
			);
	}

	beforeAll(async () => {
		h = await startHarness({ area: "traffic", label: "traffic" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call(
			"POST",
			"/api/projects",
			as({ body: { name: "Shop" } }),
		);
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			as(),
		);
		const svc = await h.call(
			"POST",
			`/api/environments/${envs.json[0].id}/services`,
			as({
				body: {
					name: "Web",
					spec: {
						kind: "application",
						source: { type: "image", image: "nginx:1.27" },
						build: { type: "image" },
						ports: [{ target: 80, protocol: "tcp" }],
						replicas: 1,
						resources: {},
						placement: [],
					},
				},
			}),
		);
		serviceId = svc.json.id;
		const dom = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({ body: { hostname: HOST, port: 80, https: false, cert: "none" } }),
		);
		expect(dom.status).toBe(201);
		domainId = dom.json.id;
		expect(
			(
				await h.call(
					"PUT",
					`/api/domains/${domainId}/web-analytics`,
					as({ body: { enabled: true } }),
				)
			).status,
		).toBe(200);

		// The upstream: /sleep/<ms> answers after that long, /fail with a 500.
		upstream = Bun.serve({
			hostname: "0.0.0.0",
			port: 0,
			async fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/fail") return new Response("no", { status: 500 });
				const ms = Number(path.match(/^\/sleep\/(\d+)/)?.[1] ?? 0);
				if (ms) await Bun.sleep(ms);
				return new Response("<!doctype html><p>ok", {
					headers: { "content-type": "text/html" },
				});
			},
		});

		// Caddy with the compiler's logging and route, minus TLS and Redis storage (stock image).
		const config = compileProxy({
			settings: {
				adminListen: "localhost:2019",
				acmeEmail: "ops@example.com",
				storage: { redisUrl: "redis://unused:6379", keyPrefix: "x" },
			},
			dashboard: {
				hostname: "ls.traffic.test",
				upstream: { host: "127.0.0.1", port: 1 },
			},
			routes: [
				{
					domainId,
					hostname: HOST,
					upstream: { host: "host.docker.internal", port: upstream.port ?? 0 },
					https: false,
					cert: "none",
					webAnalytics: true,
				},
			],
		});
		const { storage: _, ...rest } = config;
		const http = {
			...config.apps.http,
			servers: { http: config.apps.http.servers.http },
		};
		tmp = mkdtempSync(join(tmpdir(), "ls-test-traffic-"));
		writeFileSync(
			join(tmp, "caddy.json"),
			JSON.stringify({ ...rest, apps: { http } }),
		);
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			CADDY,
			"--label",
			"logistack.test=traffic",
			"--label",
			`com.docker.swarm.service.name=${CADDY_SERVICE}`,
			"--add-host",
			"host.docker.internal:host-gateway",
			"-p",
			"127.0.0.1::80",
			"-v",
			`${join(tmp, "caddy.json")}:/etc/caddy/caddy.json:ro`,
			"caddy:2.11.7-alpine",
			"caddy",
			"run",
			"--config",
			"/etc/caddy/caddy.json",
		);
		stops.push(() => Bun.spawnSync(["docker", "rm", "-f", CADDY]));
		caddyPort = sh("docker", "port", CADDY, "80/tcp").split("\n")[0] as string;
		for (let i = 0; i < 100; i++) {
			const ok = await fetch(`http://${caddyPort}/_ls/a.js`, {
				headers: { Host: HOST },
			})
				.then((r) => r.ok)
				.catch(() => false);
			if (ok) break;
			await Bun.sleep(200);
		}

		const sync = await startGateway();
		stops.push(() => sync.close());
		agent = Bun.spawn(
			["bun", join(import.meta.dir, "../../agent/src/index.ts")],
			{
				env: {
					...process.env,
					LOGISTACK_API_URL: `http://127.0.0.1:${gatewayPort}`,
					LOGISTACK_AGENT_TOKEN: "lsn_traffic",
					LOGISTACK_NODE_ID: `${PREFIX}-node`,
					LOGISTACK_AGENT_TOKEN_PATH: join(tmp, "node-token"),
					LOGISTACK_AGENT_METRICS_PORT: "0",
					LOGISTACK_AGENT_GEOIP: "false",
					LOGISTACK_AGENT_INTERVAL_MS: "2000",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		stops.push(() => agent?.kill());
		for (const stream of [agent.stdout, agent.stderr])
			void (async () => {
				for await (const chunk of stream as ReadableStream<Uint8Array>)
					agentOut += new TextDecoder().decode(chunk);
			})();
		// The worker's half: the traffic stream into traffic_1m.
		const consumer = createMetricsConsumer({
			sql: h.deps.db.$client,
			redisUrl: h.config.REDIS_URL,
			stream: TRAFFIC_STREAM,
			blockMs: 500,
			handle: (entries) => storeTrafficEntries(h.deps.db.$client, entries),
		});
		const ac = new AbortController();
		void consumer.run(ac.signal);
		stops.push(() => {
			ac.abort();
			consumer.close();
		});
		await Bun.sleep(4_000); // hello, traffic.config, the log follow
	}, 180_000);

	afterAll(async () => {
		for (const stop of stops.reverse()) await stop();
		gateway?.stop(true);
		upstream?.stop(true);
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		await h?.close();
	});

	test("counts, status classes, percentiles, visitors and beacons reach the API", async () => {
		// 1200 requests: latency i % 100 ms (so p50 ~ 50, p95 ~ 95), every 20th a 500, 37 user agents.
		await load(N, (i) =>
			i % 20 === 0 ? "/fail" : `/sleep/${i % 100}?token=secret${i}`,
		);
		await load(
			10,
			() =>
				"/_ls/e?n=pageview&u=%2F%3Futm_source%3Dnewsletter&r=https%3A%2F%2Fnews.ycombinator.com%2F",
		);
		await load(3, () => "/_ls/e?n=signup&u=%2F");
		await load(
			5,
			() => "/",
			() => "Googlebot/2.1 (+http://www.google.com/bot.html)",
		);

		let report: Awaited<ReturnType<Harness["call"]>> = {
			status: 0,
			json: null,
			headers: new Headers(),
		};
		for (let i = 0; i < 60; i++) {
			report = await h.call(
				"GET",
				`/api/services/${serviceId}/traffic?range=1h`,
				as(),
			);
			if (report.json?.totals?.requests >= N + 5) break;
			await Bun.sleep(3_000);
			if (i === 30) break;
		}
		expect(report.status).toBe(200);
		const t = report.json.totals;
		if (t.requests !== N + 5)
			console.log(
				agentOut.slice(-4000),
				"XLEN",
				await new RedisClient(h.config.REDIS_URL).send("XLEN", [
					TRAFFIC_STREAM,
				]),
				"rows",
				await h.deps.db
					.$client`select count(*)::int as n, min(service_id) as s, sum(requests)::int as r from traffic_1m`,
				"svc",
				serviceId,
				"cfg",
				await new RedisClient(h.config.REDIS_URL).keys("ls:traffic:*"),
			);
		expect(t.requests).toBe(N + 5);
		expect(t.status).toEqual([0, N - 60 + 5, 0, 0, 60]);
		expect(t.bots).toBe(5);
		expect(t.pageviews).toBe(10); // the script is on: beacons only
		expect(Math.abs(t.visitors - 37)).toBeLessThanOrEqual(2);
		// Truth over the non-failing requests is 0..99 ms plus proxy overhead; /fail is ~0 ms.
		expect(t.p50).toBeGreaterThan(40);
		expect(t.p50).toBeLessThan(60);
		expect(t.p95).toBeGreaterThan(88);
		expect(t.p95).toBeLessThan(110);
		expect(report.json.referrers).toEqual([
			{ key: "news.ycombinator.com", count: 10 },
		]);
		expect(report.json.utmSources).toEqual([{ key: "newsletter", count: 10 }]);
		expect(report.json.events).toEqual([{ key: "signup", count: 3 }]);
		expect(JSON.stringify(report.json.paths)).not.toContain("secret");
		expect(
			report.json.series.reduce(
				(a: number, p: { requests: number }) => a + p.requests,
				0,
			),
		).toBe(N + 5);

		const overview = await h.call("GET", "/api/traffic?range=1h", as());
		expect(overview.json.services[0]).toMatchObject({
			serviceId,
			requests: N + 5,
		});
	}, 240_000);

	test("no client IP or user agent is stored in Postgres or Redis", async () => {
		const logs = sh("docker", "logs", CADDY);
		const ip = logs.match(/"client_ip":"([^"]+)"/)?.[1];
		expect(ip).toBeTruthy();
		const sql = h.deps.db.$client;
		const tables = await sql<{ t: string }[]>`
			select table_name as t from information_schema.tables
			where table_schema = 'public' and table_type = 'BASE TABLE'`;
		for (const { t } of tables) {
			const [row] = await sql.unsafe<{ s: string | null }[]>(
				`select string_agg(x::text, E'\\n') as s from "${t}" x`,
			);
			expect(row?.s ?? "").not.toContain(ip as string);
			expect(row?.s ?? "").not.toContain("Firefox/1");
		}
		const redis = new RedisClient(h.config.REDIS_URL);
		const stream = JSON.stringify(
			await redis.send("XRANGE", [TRAFFIC_STREAM, "-", "+"]),
		);
		expect(stream).not.toContain(ip as string);
		expect(stream).not.toContain("Firefox");
		redis.close();
	});

	test("agent memory stays bounded while the server is unreachable", async () => {
		const pid = agent?.pid as number;
		gateway?.stop(true);
		// Distinct paths and user agents: top-k maps and the visitor sketch must stay capped.
		const flood = (round: number) =>
			load(
				5_000,
				(i) => `/p/${round}-${i}`,
				(i) => `UA-${round}-${i}`,
			);
		await flood(0);
		await flood(1);
		await Bun.sleep(3_000);
		const warm = rss(pid);
		for (let round = 2; round < 8; round++) await flood(round);
		await Bun.sleep(3_000);
		const after = rss(pid);
		console.log(
			`agent RSS after 10k requests ${Math.round(warm / 2 ** 20)} MiB, after 40k more ${Math.round(after / 2 ** 20)} MiB`,
		);
		// Unbounded state would grow with the 30k new keys; garbage and allocator slack stay well under this.
		expect(after - warm).toBeLessThan(16 * 2 ** 20);
	}, 300_000);
});
