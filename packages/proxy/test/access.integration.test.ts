import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AccessRule,
	compileProxy,
	type ProxyRoute,
} from "../src/index.ts";
import { dashboard, settings } from "./fixtures.ts";

/** Every object here is named `ls-test-qw49-*` and labelled `logistack.test=qw49`; cleanup removes exactly these. */
const P = "ls-test-qw49-";
const NET = `${P}net`;
const CADDY = `${P}caddy`;
const LABEL = "logistack.test=qw49";
/** The repo's Caddy build (docker/caddy), as the worker's proxy test builds it. */
const IMAGE = process.env.LS_TEST_CADDY_IMAGE ?? "ls-test-dns-caddy:dev";

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

describe.skipIf(!hasImage)("access rules against real Caddy", () => {
	let caddyIp = "";
	let dir = "";
	const upstream = Bun.serve({
		port: 0,
		hostname: "0.0.0.0",
		fetch: (req) =>
			new Response(`upstream user=${req.headers.get("remote-user") ?? "-"}`),
	});
	const auth = Bun.serve({
		port: 0,
		hostname: "0.0.0.0",
		fetch: (req) =>
			req.headers.get("x-token") === "good"
				? new Response("auth body", { headers: { "Remote-User": "alice" } })
				: new Response("login first", { status: 401 }),
	});

	beforeAll(async () => {
		cleanup();
		const hash = await Bun.password.hash("s3cret-pass", {
			algorithm: "bcrypt",
			cost: 4,
		});
		const anywhere = ["0.0.0.0/0", "::/0"];
		sh("docker", "network", "create", "--label", LABEL, NET);
		// The host reaches Caddy through the network's gateway, so its subnet is the "front proxy".
		const subnet = sh(
			"docker",
			"network",
			"inspect",
			"-f",
			"{{(index .IPAM.Config 0).Subnet}}",
			NET,
		);
		const route = (hostname: string, access: AccessRule[]): ProxyRoute => ({
			domainId: hostname,
			hostname,
			upstream: { host: "host.docker.internal", port: upstream.port as number },
			https: false,
			cert: "none",
			access,
		});
		const forward = (copyHeaders: string[]): AccessRule => ({
			type: "forward_auth",
			url: `http://host.docker.internal:${auth.port}/verify?app=1`,
			copyHeaders,
		});
		const config = compileProxy({
			settings,
			dashboard,
			routes: [
				route("basic.test", [
					{ type: "basic_auth", users: [{ username: "ops", hash }] },
				]),
				route("deny.test", [{ type: "ip_allow", cidrs: ["203.0.113.0/24"] }]),
				route("allow.test", [{ type: "ip_allow", cidrs: anywhere }]),
				route("proxied.test", [
					{
						type: "ip_allow",
						cidrs: ["198.51.100.7"],
						trustedProxies: [subnet],
					},
				]),
				route("pinned.test", [
					{
						type: "ip_allow",
						cidrs: ["198.51.100.7"],
						trustedProxies: ["192.0.2.0/24"],
					},
				]),
				route("direct.test", [{ type: "ip_allow", cidrs: ["198.51.100.7"] }]),
				route("fwd.test", [forward(["remote-user"])]),
				route("fwd-bare.test", [forward([])]),
				route("both.test", [
					{ type: "basic_auth", users: [{ username: "ops", hash }] },
					{ type: "ip_allow", cidrs: ["203.0.113.0/24"] },
				]),
			],
		});
		// Plain HTTP only: no TLS app, file storage instead of Redis.
		const { https: _, ...servers } = config.apps.http.servers;
		const plain = {
			...config,
			admin: { listen: "localhost:2019" },
			storage: { module: "file_system", root: "/tmp/caddy" },
			apps: { http: { ...config.apps.http, servers } },
		};
		dir = mkdtempSync(join(tmpdir(), `${P}cfg-`));
		writeFileSync(join(dir, "caddy.json"), JSON.stringify(plain));
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
		while ((await get("allow.test").catch(() => null))?.status !== 200) {
			if (Date.now() > end)
				throw new Error(`Caddy never answered: ${sh("docker", "logs", CADDY)}`);
			await Bun.sleep(200);
		}
	}, 60_000);

	afterAll(() => {
		cleanup();
		upstream.stop(true);
		auth.stop(true);
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	async function get(host: string, headers: Record<string, string> = {}) {
		const res = await fetch(`http://${caddyIp}/`, {
			headers: { host, ...headers },
		});
		return { status: res.status, body: await res.text() };
	}
	const basic = (user: string, pass: string) => ({
		authorization: `Basic ${btoa(`${user}:${pass}`)}`,
	});

	test("basic auth: 401 without credentials, 401 with a wrong password, 200 with the right one", async () => {
		expect((await get("basic.test")).status).toBe(401);
		expect((await get("basic.test", basic("ops", "nope-nope"))).status).toBe(
			401,
		);
		expect(await get("basic.test", basic("ops", "s3cret-pass"))).toEqual({
			status: 200,
			body: "upstream user=-",
		});
	});

	test("ip allowlist: 403 from a range outside the list, 200 inside it", async () => {
		expect(await get("deny.test")).toEqual({ status: 403, body: "Forbidden" });
		expect((await get("allow.test")).status).toBe(200);
	});

	test("X-Forwarded-For counts only from the rule's own trusted proxies", async () => {
		expect((await get("proxied.test")).status).toBe(403);
		expect(
			(await get("proxied.test", { "x-forwarded-for": "198.51.100.8" })).status,
		).toBe(403);
		expect(
			(await get("proxied.test", { "x-forwarded-for": "198.51.100.7" })).status,
		).toBe(200);
		// The server trusts the subnet for proxied.test; other rules must not inherit that.
		expect(
			(await get("pinned.test", { "x-forwarded-for": "198.51.100.7" })).status,
		).toBe(403);
		expect(
			(await get("direct.test", { "x-forwarded-for": "198.51.100.7" })).status,
		).toBe(403);
	});

	test("forward auth: the auth server's 401 reaches the client, a 2xx lets the request through", async () => {
		expect(await get("fwd.test")).toEqual({ status: 401, body: "login first" });
		expect(await get("fwd.test", { "x-token": "good" })).toEqual({
			status: 200,
			body: "upstream user=alice",
		});
		expect(await get("fwd-bare.test", { "x-token": "good" })).toEqual({
			status: 200,
			body: "upstream user=-",
		});
	});

	test("forward auth: a client cannot forge a copied header", async () => {
		const forged = { "x-token": "good", "remote-user": "mallory" };
		expect((await get("fwd.test", forged)).body).toBe("upstream user=alice");
		expect((await get("fwd-bare.test", forged)).body).toBe(
			"upstream user=mallory",
		);
	});

	test("the IP check runs before auth: a blocked address never sees the login prompt", async () => {
		expect(await get("both.test", basic("ops", "s3cret-pass"))).toEqual({
			status: 403,
			body: "Forbidden",
		});
	});
});
