// Backups to an SFTP server (through rclone) and to a folder on the node, end to end: real
// Swarm, agent, Postgres, Redis and an SFTP container. Opt in with BACKUP_IT=1; needs rclone on
// PATH. Takes a couple of minutes (a database deploy and a few dumps).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt } from "@logistack/core";
import {
	backupRun,
	createDb,
	type Db,
	envVar,
	instanceSettings,
	runMigrations,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import {
	type BackupDestination,
	rcloneDestination,
} from "@logistack/providers";
import { eq } from "drizzle-orm";
import { loadConfig as serverConfig } from "../../server/src/config.ts";
import { startServer } from "../../server/src/index.ts";
import { setLogLevel as serverLogLevel } from "../../server/src/log.ts";
import { locateTask } from "../src/backups.ts";
import { loadConfig } from "../src/config.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";

const AREA = "ls-test-backupdest-";
const PREFIX = `${AREA}${Date.now().toString(36)}-`;
const LABEL = { "logistack.test": "backupdest" };
const SFTP_IMAGE = "atmoz/sftp:alpine";
const SFTP_USER = { user: "backup", password: "sftp-secret-pw" };
const ENROLLMENT = "d".repeat(64);

const enabled = (() => {
	try {
		return (
			process.env.BACKUP_IT === "1" &&
			Bun.which("rclone") !== null &&
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
	const at = args.indexOf("--");
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=backupdest",
		"-p",
		`127.0.0.1::${port}`,
		...args.slice(0, at),
		image,
		...args.slice(at + 1),
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

/** Removes this area's objects (any run); nothing outside the `ls-test-backupdest-` prefix. */
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
}

describe.skipIf(!enabled)("backups to SFTP and to a node folder", () => {
	let db: Db;
	let api: Awaited<ReturnType<typeof startServer>>;
	let worker: RunningWorker | undefined;
	let agent: ReturnType<typeof Bun.spawn> | undefined;
	let cookie = "";
	let sftpPort = 0;
	let pgServiceId = "";
	let sftpDestinationId = "";
	let policyId = "";
	let localNodeId = "";
	const tokenDir = mkdtempSync(join(tmpdir(), PREFIX));
	// Docker binds the host path, so resolve macOS's /var -> /private/var symlink.
	const localDir = join(realpathSync(tokenDir), "local-backups");

	const sftpSettings = () => ({
		host: "127.0.0.1",
		port: sftpPort,
		user: SFTP_USER.user,
		path: "data/logistack",
	});
	const sftp = (): BackupDestination =>
		rcloneDestination({
			kind: "sftp",
			settings: sftpSettings(),
			secrets: { password: SFTP_USER.password },
		});

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

	async function settle(runId: string) {
		return waitFor(
			`run ${runId}`,
			async () => {
				const r = await call("GET", `/api/backup-runs/${runId}`);
				return r.json.status && r.json.status !== "running"
					? r.json
					: undefined;
			},
			240_000,
		);
	}
	async function runPolicy(id: string, kind: "backup" | "verify" = "backup") {
		const r = await call("POST", `/api/backup-policies/${id}/run`, { kind });
		expect(r.status).toBe(202);
		return settle(r.json.id);
	}

	beforeAll(async () => {
		serverLogLevel("silent");
		await sweep();
		for (const img of ["postgres:17-alpine", "alpine:3.22", SFTP_IMAGE])
			await docker.images.inspect(img).catch(() => docker.images.pull(img));
		const pg = container("pg", "postgres:17-alpine", 5432, [
			"-e",
			"POSTGRES_PASSWORD=test",
			"--",
		]);
		const redisUrl = `redis://${container("redis", "redis:7-alpine", 6379, ["--"])}`;
		const sftpAddr = container("sftp", SFTP_IMAGE, 22, [
			"--",
			`${SFTP_USER.user}:${SFTP_USER.password}:::data`,
		]);
		sftpPort = Number(sftpAddr.split(":").at(-1));
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
		// The SFTP server listens on loopback.
		await db.update(instanceSettings).set({ allowPrivateHosts: true });

		const swarmNodeId = (await docker.info()).Swarm.NodeID;
		agent = Bun.spawn(
			["bun", join(import.meta.dir, "../../agent/src/index.ts")],
			{
				env: {
					...process.env,
					LOGISTACK_API_URL: `http://127.0.0.1:${api.server.port}`,
					LOGISTACK_AGENT_TOKEN: ENROLLMENT,
					LOGISTACK_AGENT_TOKEN_PATH: join(tokenDir, "node-token"),
					LOGISTACK_NODE_ID: swarmNodeId,
					LOGISTACK_NODE_HOSTNAME: "backupdest-node",
					LOGISTACK_AGENT_INTERVAL_MS: "1000",
					LOGISTACK_AGENT_METRICS_PORT: "0",
				},
				stdout: "ignore",
				stderr: "inherit",
			},
		);
		await waitFor(
			"agent connected",
			() => api.agents.connected().some((n) => n.nodeId === swarmNodeId),
			40_000,
		);
		localNodeId = (
			await waitFor(
				"node row",
				async () => (await call("GET", "/api/nodes")).json[0],
			)
		).id;

		worker = await startWorker(
			loadConfig({
				DATABASE_URL: databaseUrl,
				REDIS_URL: redisUrl,
				LOGISTACK_MASTER_KEY: api.deps.config.LOGISTACK_MASTER_KEY,
				LS_WORK_DIR: tokenDir,
				LS_CONTROL_NETWORK: `${PREFIX}control`,
				LS_INGRESS_NETWORK: `${PREFIX}ingress`,
				LS_CADDY_SERVICE: `${PREFIX}caddy`,
				LS_NAME_PREFIX: PREFIX,
				LS_SCOPE_LABELS: JSON.stringify(LABEL),
				LS_RECONCILE_INTERVAL_MS: "0",
				LS_METRICS_INTERVAL_MS: "0",
				LS_NODE_SYNC_INTERVAL_MS: "0",
				LOG_LEVEL: "silent",
			}),
		);

		const prj = await call("POST", "/api/projects", { name: "Shop" });
		const envId = (
			await call("GET", `/api/projects/${prj.json.id}/environments`)
		).json[0].id;
		const svc = await call("POST", `/api/environments/${envId}/services`, {
			name: "orders-db",
			spec: {
				kind: "database",
				engine: "postgres",
				version: "17-alpine",
				credentialsRef: "test",
				resources: {},
			},
		});
		expect(svc.status).toBe(201);
		pgServiceId = svc.json.id;
		await db
			.insert(envVar)
			.values({
				scope: "service",
				scopeId: pgServiceId,
				key: "POSTGRES_PASSWORD",
				valueEncrypted: await encrypt(ctx().masterKey, "s3cret-pg"),
			})
			.onConflictDoNothing();
		expect(
			(await call("POST", `/api/services/${pgServiceId}/deploy`)).status,
		).toBe(202);
		const t = await waitFor(
			"database task running",
			() => locateTask(ctx(), pgServiceId),
			180_000,
		);
		const seed = ctx().nodes.runJob(t.nodeId, {
			kind: "exec",
			target: { kind: "task", taskId: t.taskId },
			cmd: [
				"psql",
				"-U",
				"postgres",
				"-c",
				"create table orders(id int primary key, total numeric); insert into orders select g, g * 1.5 from generate_series(1, 2500) g",
			],
			timeoutSec: 60,
		});
		for await (const _ of seed);
		expect((await seed.result).exitCode).toBe(0);
	}, 400_000);

	afterAll(async () => {
		await worker?.stop().catch(() => {});
		agent?.kill();
		await api?.stop().catch(() => {});
		await sweep();
		for (const s of ["pg", "redis", "sftp"])
			Bun.spawnSync(["docker", "rm", "-f", "-v", `${PREFIX}${s}`], {
				stdout: "ignore",
				stderr: "ignore",
			});
		rmSync(tokenDir, { recursive: true, force: true });
	}, 120_000);

	test("the wizard's probe writes, reads and deletes a file over SFTP", async () => {
		const body = {
			kind: "sftp",
			settings: sftpSettings(),
			secrets: { password: SFTP_USER.password },
		};
		const bad = await call("POST", "/api/backup-destinations/test", {
			...body,
			secrets: { password: "wrong" },
		});
		expect(bad.json).toMatchObject({
			ok: false,
			message: "The destination refused the probe",
		});
		expect(JSON.stringify(bad.json)).not.toContain("wrong");
		const ok = await call("POST", "/api/backup-destinations/test", body);
		expect(ok.json).toMatchObject({ ok: true });
		expect(await sftp().list()).toEqual([]);
		const created = await call("POST", "/api/backup-destinations", {
			...body,
			name: "NAS",
		});
		expect(created.status).toBe(201);
		sftpDestinationId = created.json.id;
	}, 60_000);

	test("a Postgres backup lands on the SFTP server with a matching sha256", async () => {
		const p = await call(
			"POST",
			`/api/services/${pgServiceId}/backup-policies`,
			{
				target: "database",
				s3DestinationId: sftpDestinationId,
				cron: "0 3 * * *",
				retention: { count: 1 },
			},
		);
		expect(p.status).toBe(201);
		policyId = p.json.id;
		const run = await runPolicy(policyId);
		expect(run).toMatchObject({
			status: "succeeded",
			kind: "backup",
			error: null,
		});
		const bytes = await new Response(sftp().download(run.objectKey)).bytes();
		expect(bytes.byteLength).toBe(run.sizeBytes);
		expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("PGDMP");
		expect(run.checksum).toBe(
			`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
		);
	}, 180_000);

	test("verify restores the SFTP backup into a throwaway database", async () => {
		const run = await runPolicy(policyId, "verify");
		expect(run).toMatchObject({
			status: "succeeded",
			kind: "verify",
			detail: "1 table restored",
		});
	}, 240_000);

	test("retention deletes the older backup from the SFTP server", async () => {
		const second = await runPolicy(policyId);
		expect(second).toMatchObject({
			status: "succeeded",
			detail: "Retention deleted 1 older backup",
		});
		const listed = await sftp().list(`backups/${policyId}/`);
		expect(listed.map((o) => o.key)).toEqual([second.objectKey]);
		const runs = await db
			.select({ key: backupRun.objectKey, prunedAt: backupRun.prunedAt })
			.from(backupRun)
			.where(eq(backupRun.policyId, policyId));
		expect(
			runs
				.filter((r) => r.key)
				.map((r) => (r.key === second.objectKey) === (r.prunedAt === null)),
		).toEqual([true, true]);
	}, 180_000);

	test("a folder on the node: probe, backup and verify through the agent", async () => {
		mkdirSync(localDir, { recursive: true });
		const body = {
			kind: "local",
			nodeId: localNodeId,
			settings: { path: localDir },
		};
		expect(
			(await call("POST", "/api/backup-destinations/test", body)).json,
		).toMatchObject({ ok: true });
		const created = await call("POST", "/api/backup-destinations", {
			...body,
			name: "Node disk",
		});
		expect(created.status).toBe(201);
		const p = await call(
			"POST",
			`/api/services/${pgServiceId}/backup-policies`,
			{
				target: "database",
				s3DestinationId: created.json.id,
				cron: "0 3 * * *",
				retention: { count: 1 },
			},
		);
		const run = await runPolicy(p.json.id);
		expect(run).toMatchObject({ status: "succeeded", kind: "backup" });
		expect(readdirSync(join(localDir, "backups", p.json.id))).toEqual([
			run.objectKey.split("/").at(-1),
		]);
		expect(await runPolicy(p.json.id, "verify")).toMatchObject({
			status: "succeeded",
			detail: "1 table restored",
		});
		const helpers = (await docker.services.list({ name: [PREFIX] })).filter(
			(s) => s.Spec.Name.includes("ls-dst-"),
		);
		expect(helpers).toHaveLength(0);
	}, 300_000);
});
