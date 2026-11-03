// Real Swarm, worker, api, Postgres and Redis: storage services from deploy to scoped keys.
// Opt in with STORAGE_IT=1; deploys four engines, a few minutes. The api runs on this host, off
// the overlay, so a socat container on the storage network stands in for the api's ls-storage leg.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StorageEngine, storageEngines } from "@logistack/contracts";
import { dockerName, storageEngineDefs } from "@logistack/core";
import { createDb, type Db, runMigrations, s3Destination } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { storageClient } from "@logistack/providers";
import { S3Client } from "bun";
import { eq } from "drizzle-orm";
import { loadConfig as serverConfig } from "../../server/src/config.ts";
import { startServer } from "../../server/src/index.ts";
import { setLogLevel as serverLogLevel } from "../../server/src/log.ts";
import { owner, setupBody } from "../../server/test/harness.ts";
import { loadConfig } from "../src/config.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";

const AREA = "ls-test-obj-";
// Short: Swarm names stop at 64 characters and config names carry an id and a hash.
const PREFIX = `${AREA}${Date.now().toString(36).slice(-4)}-`;
const LABEL = { "logistack.test": "obj" };
const SOCAT = "alpine/socat:1.8.1.3";
const MiB = 1024 * 1024;

const enabled = (() => {
	try {
		return (
			process.env.STORAGE_IT === "1" &&
			Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" })
				.exitCode === 0
		);
	} catch {
		return false;
	}
})();

const docker = createDockerClient();

function sh(...argv: string[]) {
	const p = Bun.spawnSync(argv, { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

function container(
	suffix: string,
	image: string,
	port: number,
	args: string[],
) {
	const name = `${PREFIX}${suffix}`;
	const split = args.indexOf("--");
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=obj",
		"-p",
		`127.0.0.1::${port}`,
		...args.slice(0, split),
		image,
		...args.slice(split + 1),
	);
	return sh("docker", "port", name, `${port}/tcp`).split("\n")[0] as string;
}

async function waitFor<T>(
	what: string,
	fn: () => Promise<T | undefined | false> | T | undefined | false,
	ms = 60_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(250);
	}
}

/** Removes every object of this area (any run); nothing outside the `ls-test-obj-` prefix. */
async function sweep() {
	const ours = (n: string | undefined) =>
		!!n?.replace(/^\//, "").startsWith(AREA);
	for (const s of await docker.services.list({ name: [AREA] }))
		if (ours(s.Spec.Name)) await docker.services.remove(s.ID).catch(() => {});
	await waitFor(
		"test containers to go",
		async () => {
			const left = (
				await docker.containers.list({ name: [AREA] }, true)
			).filter(
				(c) =>
					c.Names.some(ours) || ours(c.Labels["com.docker.swarm.service.name"]),
			);
			for (const c of left)
				if (!c.Labels["com.docker.swarm.service.name"])
					await docker.containers.remove(c.Id, true).catch(() => {});
			return left.length === 0;
		},
		90_000,
	).catch(() => {});
	for (const c of await docker.configs.list({ name: [AREA] }))
		if (ours(c.Spec.Name)) await docker.configs.remove(c.ID).catch(() => {});
	for (const n of await docker.networks.list({ name: [AREA] }))
		if (ours(n.Name)) await docker.networks.remove(n.Id).catch(() => {});
	for (const v of await docker.volumes.list({ name: [AREA] }))
		if (ours(v.Name)) await docker.volumes.remove(v.Name, true).catch(() => {});
}

describe.skipIf(!enabled)("object storage end to end", () => {
	let db: Db;
	let api: Awaited<ReturnType<typeof startServer>>;
	let worker: RunningWorker;
	let cookie = "";
	let envId = "";
	const forwards = new Map<string, string>();
	const services: Partial<Record<StorageEngine, string>> = {};

	const base = () => `http://127.0.0.1:${api.server.port}`;
	async function call(method: string, path: string, body?: unknown) {
		const res = await fetch(`${base()}${path}`, {
			method,
			headers: {
				cookie,
				origin: "http://localhost:5173",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		// biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary JSON.
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {}
		return { status: res.status, json, text };
	}

	/** A socat on the storage network, published on loopback: what ls-storage gives the api in production. */
	function forward(serviceId: string, port: number) {
		const target = `${PREFIX}${dockerName("svc", serviceId)}`;
		const addr = container(`fwd-${serviceId.slice(-6)}-${port}`, SOCAT, port, [
			"--network",
			`${PREFIX}storage`,
			"--",
			`tcp-listen:${port},fork,reuseaddr`,
			`tcp:${target}:${port}`,
		]);
		forwards.set(`${serviceId}:${port}`, `http://${addr}`);
	}

	async function deployStorage(engine: StorageEngine) {
		const created = await call("POST", `/api/environments/${envId}/services`, {
			name: `${engine} files`,
			spec: { kind: "storage", engine, resources: {} },
		});
		expect(created.status).toBe(201);
		const id = created.json.id as string;
		const dep = await call("POST", `/api/services/${id}/deploy`);
		expect(dep.status).toBe(202);
		const final = await waitFor(
			`${engine} deployment`,
			async () => {
				const d = await call("GET", `/api/deployments/${dep.json.id}`);
				return ["healthy", "failed"].includes(d.json.status)
					? d.json
					: undefined;
			},
			240_000,
		);
		expect(final).toMatchObject({ status: "healthy" });
		const def = storageEngineDefs[engine];
		forward(id, def.s3Port);
		if (def.adminPort) forward(id, def.adminPort);
		services[engine] = id;
		return id;
	}

	beforeAll(async () => {
		serverLogLevel("silent");
		await sweep();
		for (const image of [
			SOCAT,
			...storageEngines.map((e) => storageEngineDefs[e].image),
		])
			await docker.images.inspect(image).catch(() => docker.images.pull(image));
		const pg = container("pg", "postgres:17-alpine", 5432, [
			"-e",
			"POSTGRES_PASSWORD=test",
			"--",
		]);
		const redisUrl = `redis://${container("redis", "redis:7-alpine", 6379, ["--"])}`;
		const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
		await waitFor("postgres", () =>
			runMigrations(databaseUrl).then(
				() => true,
				() => false,
			),
		);
		db = createDb(databaseUrl, { onnotice: () => {} });
		for (const net of ["control", "ingress", "storage"])
			await docker.networks.create({
				Name: `${PREFIX}${net}`,
				Driver: "overlay",
				Attachable: true,
				Labels: LABEL,
			});

		const masterKey = crypto.getRandomValues(new Uint8Array(32)).toBase64();
		api = await startServer(
			serverConfig({
				DATABASE_URL: databaseUrl,
				REDIS_URL: redisUrl,
				LOGISTACK_MASTER_KEY: masterKey,
				BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
				BETTER_AUTH_URL: "http://localhost:3000",
				WEB_ORIGIN: "http://localhost:5173",
				LOG_LEVEL: "silent",
				PORT: "0",
				WEB_DIST_DIR: join(tmpdir(), `${PREFIX}no-web`),
			}),
		);
		api.deps.storageEndpoint = (id, port) => {
			const url = forwards.get(`${id}:${port}`);
			if (!url) throw new Error(`no forward for ${id}:${port}`);
			return url;
		};
		const setup = await fetch(`${base()}/api/setup`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify(setupBody),
		});
		expect(setup.status).toBe(201);
		const signIn = await fetch(`${base()}/api/auth/sign-in/email`, {
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

		worker = await startWorker(
			loadConfig({
				DATABASE_URL: databaseUrl,
				REDIS_URL: redisUrl,
				LOGISTACK_MASTER_KEY: masterKey,
				LS_WORK_DIR: join(tmpdir(), `${PREFIX}work`),
				LS_CONTROL_NETWORK: `${PREFIX}control`,
				LS_INGRESS_NETWORK: `${PREFIX}ingress`,
				LS_STORAGE_NETWORK: `${PREFIX}storage`,
				LS_CADDY_SERVICE: `${PREFIX}caddy`,
				LS_NAME_PREFIX: PREFIX,
				LS_SCOPE_LABELS: JSON.stringify(LABEL),
				LS_DEPLOY_TIMEOUT_MS: "240000",
				LS_RECONCILE_INTERVAL_MS: "0",
				LS_METRICS_INTERVAL_MS: "0",
				LS_NODE_SYNC_INTERVAL_MS: "0",
				LOG_LEVEL: "silent",
			}),
		);
		const prj = await call("POST", "/api/projects", { name: "Media" });
		envId = (await call("GET", `/api/projects/${prj.json.id}/environments`))
			.json[0].id;
	}, 600_000);

	afterAll(async () => {
		await worker?.stop();
		await api?.stop();
		await db?.$client.end();
		rmSync(join(tmpdir(), `${PREFIX}work`), { recursive: true, force: true });
		await sweep();
	}, 180_000);

	for (const engine of ["minio", "rustfs"] as const)
		test(`${engine}: deploy, buckets, 10 MiB multipart, share, scoped key, delete`, async () => {
			const id = await deployStorage(engine);
			const s = `/api/storage/${id}`;

			expect(
				(await call("POST", `${s}/buckets`, { name: "photos" })).status,
			).toBe(201);
			expect(
				(await call("POST", `${s}/buckets`, { name: "archive" })).status,
			).toBe(201);

			const payload = new Uint8Array(10 * MiB).map((_, i) => (i * 31) % 251);
			const digest = new Bun.CryptoHasher("sha256")
				.update(payload)
				.digest("hex");
			const stream = new Response(payload).body as ReadableStream<Uint8Array>;
			const up = await fetch(
				`${base()}${s}/buckets/photos/upload?key=${encodeURIComponent("2026/big shot.raw")}`,
				{
					method: "PUT",
					headers: {
						cookie,
						origin: "http://localhost:5173",
						"content-type": "application/octet-stream",
					},
					body: stream,
					duplex: "half",
				} as RequestInit,
			);
			expect(up.status).toBe(201);

			const top = await call("GET", `${s}/buckets/photos/objects`);
			expect(top.json.folders).toEqual(["2026/"]);
			const inside = await call(
				"GET",
				`${s}/buckets/photos/objects?prefix=2026/`,
			);
			expect(inside.json.objects).toEqual([
				expect.objectContaining({ key: "2026/big shot.raw", size: 10 * MiB }),
			]);
			// An S3 multipart ETag is "<md5 of part md5s>-<parts>": 8 MiB parts make two.
			expect(inside.json.objects[0].etag).toMatch(/-2$/);

			const download = await fetch(
				`${base()}${s}/buckets/photos/download?key=${encodeURIComponent("2026/big shot.raw")}`,
				{ headers: { cookie } },
			);
			expect(download.headers.get("content-disposition")).toContain(
				"attachment",
			);
			expect(
				new Bun.CryptoHasher("sha256")
					.update(await download.arrayBuffer())
					.digest("hex"),
			).toBe(digest);

			const share = await call("POST", `${s}/buckets/photos/share`, {
				key: "2026/big shot.raw",
				expiresIn: 300,
			});
			expect(share.json.via).toBe("logistack");
			const shared = await fetch(
				share.json.url.replace("http://localhost:3000", base()),
			);
			expect(shared.status).toBe(200);
			expect(
				new Bun.CryptoHasher("sha256")
					.update(await shared.arrayBuffer())
					.digest("hex"),
			).toBe(digest);
			const forged = await fetch(
				`${base()}/api/storage/shared/${share.json.url.split("/").at(-1).slice(0, -4)}AAAA`,
			);
			expect(forged.status).toBe(404);

			// A real S3 presigned GET, as clients get it with a public endpoint domain.
			const root = (await call("GET", `${s}/credentials`)).json;
			const endpoint = forwards.get(
				`${id}:${storageEngineDefs[engine].s3Port}`,
			) as string;
			const presigned = storageClient({
				engine,
				endpoint,
				region: "us-east-1",
				...root,
			}).presign("photos", "2026/big shot.raw", 60);
			const viaPresign = await fetch(presigned);
			expect(viaPresign.status).toBe(200);
			expect((await viaPresign.arrayBuffer()).byteLength).toBe(10 * MiB);

			const key = await call("POST", `${s}/keys`, {
				name: "photos app",
				buckets: ["photos"],
				access: "readwrite",
			});
			expect([key.status, key.status === 201 ? "" : key.text]).toEqual([
				201,
				"",
			]);
			const scoped = new S3Client({
				endpoint,
				region: "us-east-1",
				accessKeyId: key.json.accessKeyId,
				secretAccessKey: key.json.secretAccessKey,
			});
			const allowed = await waitFor(
				"scoped key active",
				() =>
					scoped.write("from-app.txt", "hi", { bucket: "photos" }).then(
						() => true,
						() => false,
					),
				20_000,
			);
			expect(allowed).toBe(true);
			expect(
				await scoped.write("x.txt", "no", { bucket: "archive" }).then(
					() => "written",
					() => "denied",
				),
			).toBe("denied");
			expect(
				await scoped.list({}, { bucket: "archive" }).then(
					() => "listed",
					() => "denied",
				),
			).toBe("denied");
			expect((await call("GET", `${s}/keys`)).json).toEqual([
				expect.objectContaining({
					accessKeyId: key.json.accessKeyId,
					buckets: ["photos"],
				}),
			]);
			expect((await call("DELETE", `${s}/keys/${key.json.id}`)).status).toBe(
				204,
			);
			expect(
				await waitFor(
					"key revoked",
					() =>
						scoped.write("late.txt", "no", { bucket: "photos" }).then(
							() => false,
							() => true,
						),
					20_000,
				),
			).toBe(true);

			const dest = await call("POST", `${s}/backup-destination`, {
				bucket: "backups",
			});
			expect(dest.status).toBe(201);
			const [row] = await db
				.select()
				.from(s3Destination)
				.where(eq(s3Destination.id, dest.json.id));
			expect(row).toMatchObject({
				storageServiceId: id,
				bucket: "backups",
				forcePathStyle: true,
			});

			expect(
				(await call("POST", `${s}/buckets/photos/delete`, { keys: ["2026/"] }))
					.status,
			).toBe(200);
			expect(
				(await call("GET", `${s}/buckets/photos/objects?prefix=2026/`)).json
					.objects,
			).toEqual([]);
			expect(
				(await call("DELETE", `${s}/buckets/photos?confirm=nope`)).status,
			).toBe(400);
			expect(
				(await call("DELETE", `${s}/buckets/photos?confirm=photos`)).status,
			).toBe(200);
			expect(
				(await call("GET", `${s}/buckets`)).json.map(
					(b: { name: string }) => b.name,
				),
			).toEqual(["archive", "backups"]);
		}, 600_000);

	for (const engine of ["garage", "seaweedfs"] as const)
		test(`${engine}: deploy to healthy and create a bucket`, async () => {
			const id = await deployStorage(engine);
			const s = `/api/storage/${id}`;
			const created = await call("POST", `${s}/buckets`, { name: "assets" });
			expect(created.status).toBe(201);
			const buckets = await call("GET", `${s}/buckets`);
			expect(buckets.json.map((b: { name: string }) => b.name)).toContain(
				"assets",
			);
			const conn = await call("GET", `${s}/connection`);
			expect(conn.json).toMatchObject({
				engine,
				internalEndpoint: `http://${engine}-files:${storageEngineDefs[engine].s3Port}`,
				capabilities: storageEngineDefs[engine].capabilities,
			});
		}, 600_000);

	test("a storage service never joins ingress and always joins the storage network", async () => {
		const storageNet = await docker.networks.inspect(`${PREFIX}storage`);
		const ingress = await docker.networks.inspect(`${PREFIX}ingress`);
		for (const id of Object.values(services)) {
			const svc = await docker.services.inspect(
				`${PREFIX}${dockerName("svc", id as string)}`,
			);
			const targets =
				svc.Spec.TaskTemplate.Networks?.map((n) => n.Target) ?? [];
			expect(targets).toContain(storageNet.Id);
			expect(targets).not.toContain(ingress.Id);
		}
	});
});
