// Real Swarm and real Caddy: requests through the compiled proxy while the compiled service rolls
// to a new deployment. Every object is `ls-test-zdd-*` labelled `logistack.test=zdd`. Opt in with
// WORKER_IT=1; needs the repo's Caddy build (LS_TEST_CADDY_IMAGE, default `ls-test-dns-caddy:dev`).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CompileServiceInput,
	compileService,
	dockerName,
} from "@logistack/core";
import { createDockerClient } from "@logistack/docker";
import { compileProxy } from "@logistack/proxy";
import { hasDocker, sh } from "./harness.ts";

const P = "ls-test-zdd-";
const LABEL = { "logistack.test": "zdd" };
const NET = `${P}net`;
const CADDY = `${P}caddy`;
const HOST = "zdd.test";
/** ZDD_STATEFUL=1 runs one replica with a volume, which makes its update stop-first. */
const STATEFUL = process.env.ZDD_STATEFUL === "1";
const VOLUME_MOUNT = "mnt_zdd00000000000000000000000";
const CADDY_IMAGE = process.env.LS_TEST_CADDY_IMAGE ?? "ls-test-dns-caddy:dev";
const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });
const enabled =
	hasDocker &&
	process.env.WORKER_IT === "1" &&
	quiet("docker", "image", "inspect", CADDY_IMAGE).exitCode === 0;

// Boots slowly, answers each request after ZDD_REQUEST_MS (300) and, on SIGTERM, stops accepting and
// finishes what it holds, as a framework's graceful shutdown does. ZDD_APP=naive exits at once.
const APP = `
await Bun.sleep(3000);
const server = Bun.serve({ port: 8080, hostname: "0.0.0.0", idleTimeout: 0, async fetch(req) {
	await Bun.sleep(Number(process.env.ZDD_REQUEST_MS ?? 300));
	return new Response(req.method + " " + process.env.LOGISTACK_DEPLOYMENT_ID);
} });
// Exiting right after stop() resolves can drop a response still being written; the process ends
// on its own once the server holds nothing.
process.on("SIGTERM", () =>
	process.env.ZDD_APP === "naive" ? process.exit(0) : server.stop(),
);
`;

const docker = createDockerClient();
const dir = mkdtempSync(join(tmpdir(), `${P}cfg-`));
let caddyAddr = "";
let serviceId = "";

const input = (deploymentId: string, net: string): CompileServiceInput => ({
	service: {
		id: "svc_zdd00000000000000000000000",
		organizationId: "org_zdd",
		environmentId: "env_zdd00000000000000000000",
		slug: "zdd",
		desiredState: "running",
		spec: {
			kind: "application",
			source: { type: "image", image: "oven/bun:1.4-slim" },
			build: { type: "image" },
			ports: [],
			replicas: STATEFUL ? 1 : 2,
			resources: {},
			placement: [],
			command: ["bun", "-e", APP],
			...(process.env.ZDD_DRAIN && {
				drainTimeout: Number(process.env.ZDD_DRAIN),
			}),
		},
	},
	deploymentId,
	image: "oven/bun:1.4-slim",
	env: Object.fromEntries(
		["ZDD_APP", "ZDD_REQUEST_MS"].flatMap((k) => {
			const v = process.env[k];
			return v ? [[k, v]] : [];
		}),
	),
	context: { project: "ZDD", environment: "test", service: "zdd", domains: [] },
	mounts: STATEFUL
		? [{ id: VOLUME_MOUNT, kind: "volume", target: "/data", readOnly: false }]
		: [],
	...(STATEFUL && {
		pinNodeId: sh("docker", "info", "-f", "{{.Swarm.NodeID}}"),
	}),
	domains: [{ port: 8080 }],
	networks: { environment: net, ingress: net },
	fileIds: {},
	scope: { namePrefix: P, labels: LABEL },
});

async function cleanup() {
	quiet("docker", "rm", "-f", CADDY);
	for (const s of await docker.services.list({ name: [P] }))
		if (s.Spec.Name.startsWith(P)) await docker.services.remove(s.ID);
	const volume = `${P}${dockerName("vol", VOLUME_MOUNT)}`;
	const gone = (kind: string, name: string) =>
		quiet("docker", kind, "rm", name).exitCode === 0 ||
		quiet("docker", kind, "inspect", name).exitCode !== 0;
	for (let i = 0; i < 120; i++) {
		if (gone("network", NET) && gone("volume", volume)) return;
		await Bun.sleep(500);
	}
}

const call = (method: "GET" | "POST") =>
	fetch(`http://${caddyAddr}/`, {
		method,
		headers: { host: HOST },
		signal: AbortSignal.timeout(90_000),
	});

beforeAll(async () => {
	if (!enabled) return;
	await cleanup();
	const net = sh(
		"docker",
		"network",
		"create",
		"--driver",
		"overlay",
		"--attachable",
		"--label",
		"logistack.test=zdd",
		NET,
	);
	const spec = compileService(input("dep_zdd_one", net));
	serviceId = (await docker.services.create(spec)).ID;

	const config = compileProxy({
		settings: {
			adminListen: "localhost:2019",
			acmeEmail: "ops@example.com",
			storage: { redisUrl: "redis://unused:6379/0", keyPrefix: "x" },
		},
		dashboard: { hostname: "ls.zdd.test", upstream: { host: "x", port: 1 } },
		routes: [
			{
				domainId: "zdd",
				hostname: HOST,
				upstream: { host: spec.Name as string, port: 8080 },
				https: false,
				cert: "none",
			},
		],
	});
	const { https: _, ...servers } = config.apps.http.servers;
	const plain = {
		...config,
		storage: { module: "file_system", root: "/tmp/caddy" },
		apps: { http: { ...config.apps.http, servers } },
	};
	writeFileSync(join(dir, "caddy.json"), JSON.stringify(plain));
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		CADDY,
		"--label",
		"logistack.test=zdd",
		"--network",
		NET,
		"-p",
		"127.0.0.1::80",
		"-v",
		`${dir}/caddy.json:/etc/caddy/caddy.json:ro`,
		"--entrypoint",
		"caddy",
		CADDY_IMAGE,
		"run",
		"--config",
		"/etc/caddy/caddy.json",
	);
	// The overlay has no route from the host, so the test reaches Caddy through a published port.
	caddyAddr = sh("docker", "port", CADDY, "80/tcp").split("\n")[0] as string;
	const end = Date.now() + 90_000;
	while ((await call("GET").catch(() => null))?.status !== 200) {
		if (Date.now() > end) throw new Error("the service never answered");
		await Bun.sleep(500);
	}
}, 120_000);

afterAll(async () => {
	if (enabled) await cleanup();
	rmSync(dir, { recursive: true, force: true });
}, 90_000);

test.skipIf(!enabled)(
	"a rolling redeploy loses no request through the proxy",
	async () => {
		const failures: Record<string, string[]> = { GET: [], POST: [] };
		const sent = { GET: 0, POST: 0 };
		let running = true;
		let slowest = 0;
		const t0 = Date.now();
		const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
		const worker = async (method: "GET" | "POST") => {
			while (running) {
				sent[method]++;
				try {
					const start = Date.now();
					const res = await call(method);
					const body = await res.text();
					slowest = Math.max(slowest, Date.now() - start);
					if (res.status !== 200)
						failures[method]?.push(
							`${at()} ${res.status} ${body.slice(0, 80)}`,
						);
				} catch (e) {
					failures[method]?.push(`${at()} ${e}`);
				}
			}
		};
		const load = [
			...Array.from({ length: 6 }, () => worker("GET")),
			...Array.from({ length: 2 }, () => worker("POST")),
		];

		await Bun.sleep(2000);
		const current = await docker.services.inspect(serviceId);
		const net = current.Spec.TaskTemplate.Networks?.[0]?.Target as string;
		await docker.services.update(
			serviceId,
			current.Version.Index,
			compileService(input("dep_zdd_two", net)),
		);
		const state = async () =>
			(await docker.services.inspect(serviceId)).UpdateStatus?.State;
		const end = Date.now() + 180_000;
		while ((await state()) !== "completed") {
			if (Date.now() > end) throw new Error(`update stuck: ${await state()}`);
			await Bun.sleep(500);
		}
		// Old tasks may still be draining after the update is marked complete.
		await Bun.sleep(15_000);
		running = false;
		await Promise.all(load);

		console.log(
			`zdd(${process.env.ZDD_APP ?? "graceful"}${STATEFUL ? ", stateful" : ""}): GET ${failures.GET?.length}/${sent.GET} failed, POST ${failures.POST?.length}/${sent.POST} failed, slowest ${slowest}ms`,
			failures.GET?.[0],
			failures.GET?.at(-1),
			failures.POST?.[0],
			failures.POST?.at(-1),
		);
		expect(await (await call("GET")).text()).toBe("GET dep_zdd_two");
		expect(failures).toEqual({ GET: [], POST: [] });
	},
	300_000,
);
