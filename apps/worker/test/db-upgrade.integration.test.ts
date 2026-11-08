// Real Swarm, agent, api and worker: a Postgres 16 service upgraded to 17 through the api, and an
// upgrade that fails before the switch leaving the database as it was. Every object is
// `ls-test-dbupg-*` labelled `logistack.test=dbupg`. Opt in with DBOPS_IT=1; takes a few minutes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt, orgDbNetworkName } from "@logistack/core";
import {
	createDb,
	type Db,
	envVar,
	project,
	runMigrations,
	service,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { loadConfig as serverConfig } from "../../server/src/config.ts";
import { startServer } from "../../server/src/index.ts";
import { setLogLevel as serverLogLevel } from "../../server/src/log.ts";
import { locateTask } from "../src/backups.ts";
import { loadConfig } from "../src/config.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";

const AREA = "ls-test-dbupg-";
const PREFIX = `${AREA}${Date.now().toString(36)}-`;
const LABEL = { "logistack.test": "dbupg" };
const ENROLLMENT = "d".repeat(64);
const enabled = (() => {
	try {
		return (
			process.env.DBOPS_IT === "1" &&
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

function container(suffix: string, image: string, port: number, env: string[]) {
	const name = `${PREFIX}${suffix}`;
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=dbupg",
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
	ms = 60_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(500);
	}
}

/** Removes every object of this area (any run); nothing outside the `ls-test-dbupg-` prefix. */
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
		60_000,
	).catch(() => {});
	for (const n of await docker.networks.list({ name: [AREA] }))
		if (ours(n.Name)) await docker.networks.remove(n.Id).catch(() => {});
	for (const v of await docker.volumes.list({ name: [AREA] }))
		if (ours(v.Name)) await docker.volumes.remove(v.Name, true).catch(() => {});
	for (const s of await docker.secrets.list({ name: [AREA] }))
		if (ours(s.Spec.Name)) await docker.secrets.remove(s.ID).catch(() => {});
}

describe.skipIf(!enabled)("database major-version upgrade end to end", () => {
	let db: Db;
	let api: Awaited<ReturnType<typeof startServer>>;
	let worker: RunningWorker | undefined;
	let agent: ReturnType<typeof Bun.spawn> | undefined;
	let cookie = "";
	let envId = "";
	let pgId = "";
	let orgId = "";
	const tokenDir = mkdtempSync(join(tmpdir(), PREFIX));

	const call = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(`http://127.0.0.1:${api.server.port}${path}`, {
			method,
			headers: {
				cookie,
				origin: "http://localhost:5173",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		// biome-ignore lint/suspicious/noExplicitAny: tests poke at JSON.
		let json: any = text;
		try {
			json = JSON.parse(text);
		} catch {}
		return { status: res.status, json };
	};
	const ctx = () => (worker as RunningWorker).ctx;

	async function psql(query: string) {
		const t = await waitFor(
			"a running task",
			() => locateTask(ctx(), pgId),
			180_000,
		);
		const job = ctx().nodes.runJob(t.nodeId, {
			kind: "exec",
			target: { kind: "task", taskId: t.taskId },
			cmd: ["psql", "-U", "postgres", "-d", "shop", "-tAc", query],
			timeoutSec: 60,
		});
		let out = "";
		for await (const c of job) out += new TextDecoder().decode(c.data);
		const r = await job.result;
		if (r.exitCode !== 0) throw new Error(`psql: ${out}`);
		return out.trim();
	}

	async function upgradeTo(version: string) {
		const r = await call("POST", `/api/databases/${pgId}/upgrades`, {
			version,
		});
		expect(r.status).toBe(202);
		return waitFor(
			`upgrade to ${version}`,
			async () => {
				const u = await call(
					"GET",
					`/api/databases/${pgId}/upgrades/${r.json.id}`,
				);
				return u.json.status !== "running" ? u.json : undefined;
			},
			420_000,
		);
	}

	beforeAll(async () => {
		serverLogLevel("silent");
		await sweep();
		for (const img of ["postgres:16", "postgres:17", "redis:7-alpine"])
			await docker.images.inspect(img).catch(() => docker.images.pull(img));
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
		for (const net of ["control", "ingress"])
			await docker.networks.create({
				Name: `${PREFIX}${net}`,
				Driver: "overlay",
				Attachable: true,
				Labels: LABEL,
			});

		api = await startServer(
			serverConfig({
				DATABASE_URL: databaseUrl,
				REDIS_URL: redisUrl,
				LOGISTACK_MASTER_KEY: crypto
					.getRandomValues(new Uint8Array(32))
					.toBase64(),
				BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
				BETTER_AUTH_URL: "http://localhost:3000",
				WEB_ORIGIN: "http://localhost:5173",
				PUBLIC_IP: "203.0.113.7",
				LOG_LEVEL: "silent",
				PORT: "0",
				WEB_DIST_DIR: join(tokenDir, "no-web"),
				LOGISTACK_AGENT_TOKEN: ENROLLMENT,
			}),
		);
		const masterKey = api.deps.config.LOGISTACK_MASTER_KEY;
		const owner = {
			name: "Olivia Owner",
			email: "owner@example.com",
			password: "correct horse battery",
		};
		expect(
			(
				await call("POST", "/api/setup", {
					owner,
					organization: { name: "Acme" },
					instance: {
						publicUrl: "https://ls.example.com",
						generatedDomainBase: "sslip",
						letsencryptEmail: "ops@example.com",
						localRegistryEnabled: false,
					},
				})
			).status,
		).toBe(201);
		const signIn = await fetch(
			`http://127.0.0.1:${api.server.port}/api/auth/sign-in/email`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:5173",
				},
				body: JSON.stringify({ email: owner.email, password: owner.password }),
			},
		);
		cookie = signIn.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");

		const nodeId = (await docker.info()).Swarm.NodeID;
		agent = Bun.spawn(
			["bun", join(import.meta.dir, "../../agent/src/index.ts")],
			{
				env: {
					...process.env,
					LOGISTACK_API_URL: `http://127.0.0.1:${api.server.port}`,
					LOGISTACK_AGENT_TOKEN: ENROLLMENT,
					LOGISTACK_AGENT_TOKEN_PATH: join(tokenDir, "node-token"),
					LOGISTACK_NODE_ID: nodeId,
					LOGISTACK_NODE_HOSTNAME: "dbupg-node",
					LOGISTACK_AGENT_INTERVAL_MS: "1000",
					LOGISTACK_AGENT_METRICS_PORT: "0",
				},
				stdout: "ignore",
				stderr: "inherit",
			},
		);
		await waitFor(
			"agent connected",
			() => api.agents.connected().some((n) => n.nodeId === nodeId),
			40_000,
		);

		worker = await startWorker(
			loadConfig({
				DATABASE_URL: databaseUrl,
				REDIS_URL: redisUrl,
				LOGISTACK_MASTER_KEY: masterKey,
				LS_WORK_DIR: tokenDir,
				LS_CONTROL_NETWORK: `${PREFIX}control`,
				LS_INGRESS_NETWORK: `${PREFIX}ingress`,
				LS_CADDY_SERVICE: `${PREFIX}caddy`,
				LS_NAME_PREFIX: PREFIX,
				LS_SCOPE_LABELS: JSON.stringify(LABEL),
				LS_STACK_NAME: `${PREFIX}nostack`,
				LS_RECONCILE_INTERVAL_MS: "0",
				LS_METRICS_INTERVAL_MS: "0",
				LS_NODE_SYNC_INTERVAL_MS: "0",
				LOG_LEVEL: "silent",
			}),
		);

		const prj = await call("POST", "/api/projects", { name: "Shop" });
		orgId =
			(
				await db
					.select({ org: project.organizationId })
					.from(project)
					.where(eq(project.id, prj.json.id))
			)[0]?.org ?? "";
		envId = (await call("GET", `/api/projects/${prj.json.id}/environments`))
			.json[0].id;
		const svc = await call("POST", `/api/environments/${envId}/services`, {
			name: "orders-db",
			spec: {
				kind: "database",
				engine: "postgres",
				version: "16",
				credentialsRef: "test",
				resources: {},
			},
		});
		expect(svc.status).toBe(201);
		pgId = svc.json.id;
		await db
			.insert(envVar)
			.values({
				scope: "service",
				scopeId: pgId,
				key: "POSTGRES_DB",
				valueEncrypted: await encrypt(ctx().masterKey, "shop"),
			})
			.onConflictDoNothing();
		expect((await call("POST", `/api/services/${pgId}/deploy`)).status).toBe(
			202,
		);
		await waitFor("database running", () => locateTask(ctx(), pgId), 180_000);
		await waitFor(
			"postgres accepting queries",
			() =>
				psql("select 1").then(
					(r) => r === "1",
					() => false,
				),
			120_000,
		);
		await psql(
			"create table orders(id int primary key, total numeric, note text); insert into orders select g, g * 1.5, 'n' || g from generate_series(1, 2500) g; create table empty_one(x int); create role reporter login password 'r3port'",
		);
	}, 480_000);

	afterAll(async () => {
		await worker?.stop().catch(() => {});
		agent?.kill();
		await api?.stop().catch(() => {});
		await sweep();
		for (const s of ["pg", "redis"])
			Bun.spawnSync(["docker", "rm", "-f", "-v", `${PREFIX}${s}`], {
				stdout: "ignore",
				stderr: "ignore",
			});
		rmSync(tokenDir, { recursive: true, force: true });
	}, 180_000);

	test("the database joins its organization's network, not the shared one", async () => {
		const live = await docker.services.inspect(
			`${PREFIX}ls-svc-${pgId.slice(4)}`,
		);
		const orgNet = await docker.networks.inspect(
			orgDbNetworkName(orgId, PREFIX),
		);
		expect(live.Spec.TaskTemplate.Networks?.map((n) => n.Target)).toContain(
			orgNet.Id,
		);
		expect(orgNet.Labels?.["logistack.org"]).toBe(orgId);
	});

	test("an upgrade that fails before the switch leaves the database as it was", async () => {
		const u = await upgradeTo("99");
		expect(u.status).toBe("failed");
		expect(u.step).toBe("instance");
		const [row] = await db.select().from(service).where(eq(service.id, pgId));
		expect(row?.spec).toMatchObject({ version: "16" });
		expect(row?.dataVolumeId).toBeNull();
		expect(await psql("select count(*) from orders")).toBe("2500");
	}, 480_000);

	test("a Postgres 16 to 17 upgrade keeps the data", async () => {
		const u = await upgradeTo("17");
		expect(u).toMatchObject({
			status: "succeeded",
			step: "done",
			fromVersion: "16",
			toVersion: "17",
		});
		expect(u.tables).toBe(2);
		expect(await psql("show server_version")).toStartWith("17.");
		expect(await psql("select count(*), sum(total) from orders")).toBe(
			"2500|4689375.0",
		);
		expect(await psql("select note from orders where id = 2500")).toBe("n2500");
		expect(
			await psql("select rolcanlogin from pg_roles where rolname = 'reporter'"),
		).toBe("t");
		const [row] = await db.select().from(service).where(eq(service.id, pgId));
		expect(row?.spec).toMatchObject({ version: "17" });
		expect(row?.dataVolumeId).toBe(u.id);
		// The old volume is kept, untouched, as the way back.
		expect(
			sh(
				"docker",
				"volume",
				"ls",
				"-q",
				"--filter",
				`name=${PREFIX}ls-vol-${pgId.slice(4)}`,
			),
		).not.toBe("");
	}, 600_000);
});
