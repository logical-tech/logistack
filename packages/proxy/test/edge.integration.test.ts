import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compileProxy,
	type EdgeRules,
	maintenancePage,
	type ProxyRoute,
	unavailablePage,
} from "../src/index.ts";
import { dashboard, settings } from "./fixtures.ts";

/** Every object here is named `ls-test-edge-*` and labelled `logistack.test=edge`; cleanup removes exactly these. */
const P = "ls-test-edge-";
const NET = `${P}net`;
const CADDY = `${P}caddy`;
const LABEL = "logistack.test=edge";
/** The repo's Caddy build (docker/caddy), which carries mholt/caddy-ratelimit. */
const IMAGE = process.env.LS_TEST_CADDY_IMAGE ?? "ls-test-edge-caddy:dev";

const run = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
const sh = (...argv: string[]) => {
	const p = run(...argv);
	if (p.exitCode !== 0)
		throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
};
const hasImage = run("docker", "image", "inspect", IMAGE).exitCode === 0;

function cleanup() {
	run("docker", "rm", "-f", "-v", CADDY);
	run("docker", "network", "rm", NET);
}

describe.skipIf(!hasImage)("edge rules against real Caddy", () => {
	let caddyIp = "";
	let dir = "";
	const upstream = Bun.serve({
		port: 0,
		hostname: "0.0.0.0",
		fetch: () => new Response("upstream"),
	});
	const branding = { orgName: "Acme Ops" };

	beforeAll(async () => {
		cleanup();
		sh("docker", "network", "create", "--label", LABEL, NET);
		// The host reaches Caddy through the network's gateway, so requests from this test come from the subnet.
		const subnet = sh(
			"docker",
			"network",
			"inspect",
			"-f",
			"{{(index .IPAM.Config 0).Subnet}}",
			NET,
		);
		const route = (
			hostname: string,
			extra: { edge?: EdgeRules; maintenance?: ProxyRoute["maintenance"] },
			port = upstream.port as number,
		): ProxyRoute => ({
			domainId: hostname,
			hostname,
			upstream: { host: "host.docker.internal", port },
			https: false,
			cert: "none",
			...extra,
		});
		const config = compileProxy({
			settings,
			dashboard,
			routes: [
				route("maint.test", {
					maintenance: {
						allowCidrs: ["203.0.113.0/24"],
						page: maintenancePage(branding, "Back soon"),
					},
				}),
				route("maint-allowed.test", {
					maintenance: { allowCidrs: [subnet], page: "never shown" },
				}),
				route("limited.test", {
					edge: {
						rateLimit: { requestsPerSecond: 1, burst: 3, exemptCidrs: [] },
					},
				}),
				route("exempt.test", {
					edge: {
						rateLimit: {
							requestsPerSecond: 1,
							burst: 1,
							exemptCidrs: [subnet],
						},
					},
				}),
				route("blocked.test", {
					edge: {
						block: { paths: ["/wp-admin*"], userAgents: ["sqlmap"] },
					},
				}),
				// Nothing listens on port 1: the dial fails like an upstream mid-deploy.
				route(
					"down.test",
					{ edge: { errorPage: unavailablePage(branding) } },
					1,
				),
			],
		});
		const { https: _, ...servers } = config.apps.http.servers;
		const plain = {
			...config,
			admin: { listen: "localhost:2019" },
			storage: { module: "file_system", root: "/tmp/caddy" },
			apps: { http: { ...config.apps.http, servers } },
		};
		// A dead upstream would otherwise be retried for 30s before the 502.
		const json = JSON.stringify(plain).replaceAll(
			'"try_duration":"30s"',
			'"try_duration":"1s"',
		);
		dir = mkdtempSync(join(tmpdir(), `${P}cfg-`));
		writeFileSync(join(dir, "caddy.json"), json);
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			CADDY,
			"--label",
			LABEL,
			"--network",
			NET,
			"--add-host",
			"host.docker.internal:host-gateway",
			"-v",
			`${dir}/caddy.json:/etc/caddy/caddy.json:ro`,
			"--entrypoint",
			"caddy",
			IMAGE,
			"run",
			"--config",
			"/etc/caddy/caddy.json",
		);
		caddyIp = sh(
			"docker",
			"inspect",
			"-f",
			`{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
			CADDY,
		);
		const end = Date.now() + 20_000;
		while ((await get("maint.test").catch(() => null))?.status !== 503) {
			if (Date.now() > end)
				throw new Error(`Caddy never answered: ${sh("docker", "logs", CADDY)}`);
			await Bun.sleep(200);
		}
	}, 60_000);

	afterAll(() => {
		cleanup();
		upstream.stop(true);
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	async function get(
		host: string,
		path = "/",
		headers: Record<string, string> = {},
	) {
		const res = await fetch(`http://${caddyIp}${path}`, {
			headers: { host, ...headers },
		});
		return { status: res.status, headers: res.headers, body: await res.text() };
	}

	test("maintenance: 503 with the branded page, an allowlisted IP reaches the service", async () => {
		const blocked = await get("maint.test");
		expect(blocked.status).toBe(503);
		expect(blocked.headers.get("retry-after")).toBe("300");
		expect(blocked.body).toContain("Back soon");
		expect(blocked.body).toContain("Acme Ops");
		expect(await get("maint-allowed.test")).toMatchObject({
			status: 200,
			body: "upstream",
		});
	});

	test("rate limit: the burst passes, the next request gets 429", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++)
			statuses.push((await get("limited.test")).status);
		expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
		expect(statuses.slice(3)).toEqual([429, 429]);
	});

	test("rate limit: an exempt range is never limited", async () => {
		for (let i = 0; i < 5; i++)
			expect((await get("exempt.test")).status).toBe(200);
	});

	test("block rules: 403 on a blocked path or user agent, 200 otherwise", async () => {
		expect((await get("blocked.test", "/wp-admin/setup.php")).status).toBe(403);
		expect(
			(await get("blocked.test", "/", { "user-agent": "SQLMap/1.7" })).status,
		).toBe(403);
		expect((await get("blocked.test", "/ok")).status).toBe(200);
	});

	test("error page: a failed upstream shows the page with the 502 status", async () => {
		const res = await get("down.test");
		expect(res.status).toBe(502);
		expect(res.body).toContain("temporarily unavailable");
	});
});
