// Real Swarm, agent, MinIO, Postgres and Redis, with two worker replicas. Opt in with BACKUP_IT=1;
// takes a few minutes (database deploys and a wait for a real cron minute).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt } from "@logistack/core";
import {
	backupPolicy,
	createDb,
	type Db,
	envVar,
	instanceSettings,
	runMigrations,
	scheduleRun,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { sha256Hex, signV4 } from "@logistack/providers";
import { S3Client } from "bun";
import { asc, eq } from "drizzle-orm";
import { loadConfig as serverConfig } from "../../server/src/config.ts";
import { startServer } from "../../server/src/index.ts";
import { setLogLevel as serverLogLevel } from "../../server/src/log.ts";
import { applyRetention, locateTask, openDestination } from "../src/backups.ts";
import { loadConfig } from "../src/config.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import type { NodeRunner } from "../src/node-runner.ts";

const AREA = "ls-test-backup-";
const PREFIX = `${AREA}${Date.now().toString(36)}-`;
const LABEL = { "logistack.test": "backup" };
const MINIO_IMAGE =
	"cgr.dev/chainguard/minio@sha256:3c60a2a8c4d33409a9bc7a623a7fcbfb4605adc3d89422d2f53b3f673a6e5597";
const S3_CREDS = {
	accessKeyId: "lsbackup",
	secretAccessKey: "lsbackupsecret1",
};
const BUCKET = "ls-test-backup";
const ENROLLMENT = "b".repeat(64);
const OUTPUT_LIMIT = 64 * 1024;

const enabled = (() => {
	try {
		return (
			process.env.BACKUP_IT === "1" &&
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
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=backup",
		"-p",
		`127.0.0.1::${port}`,
		...args.slice(0, args.indexOf("--")),
		image,
		...args.slice(args.indexOf("--") + 1),
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

/** Removes every object of this area (any run); nothing outside the `ls-test-backup-` prefix. */
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

describe.skipIf(!enabled)("backups, restores and schedules end to end", () => {
	let db: Db;
	let api: Awaited<ReturnType<typeof startServer>>;
	let workers: RunningWorker[] = [];
	let agent: ReturnType<typeof Bun.spawn> | undefined;
	let cookie = "";
	let s3Endpoint = "";
	let envId = "";
	let pgServiceId = "";
	let destinationId = "";
	let policyId = "";
	let nodeId = "";
	const tokenDir = mkdtempSync(join(tmpdir(), PREFIX));
	const timings: Record<string, number> = {};

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
	const ctx0 = () => (workers[0] as RunningWorker).ctx;
	const runner = (): NodeRunner => ctx0().nodes;

	async function psql(serviceId: string, query: string) {
		const t = await locateTask(ctx0(), serviceId);
		if (!t) throw new Error("no task");
		const job = runner().runJob(t.nodeId, {
			kind: "exec",
			target: { kind: "task", taskId: t.taskId },
			cmd: ["psql", "-U", "postgres", "-tAc", query],
			timeoutSec: 60,
		});
		let out = "";
		for await (const c of job) out += new TextDecoder().decode(c.data);
		const r = await job.result;
		if (r.exitCode !== 0) throw new Error(`psql: ${out}`);
		return out.trim();
	}

	async function databaseService(name: string) {
		const svc = await call("POST", `/api/environments/${envId}/services`, {
			name,
			spec: {
				kind: "database",
				engine: "postgres",
				version: "17-alpine",
				credentialsRef: "test",
				resources: {},
			},
		});
		expect(svc.status).toBe(201);
		await db.insert(envVar).values({
			scope: "service",
			scopeId: svc.json.id,
			key: "POSTGRES_PASSWORD",
			valueEncrypted: await encrypt(ctx0().masterKey, "s3cret-pg"),
		});
		return svc.json.id as string;
	}

	async function deploy(serviceId: string) {
		expect(
			(await call("POST", `/api/services/${serviceId}/deploy`)).status,
		).toBe(202);
		await waitFor(
			"database task running",
			() => locateTask(ctx0(), serviceId),
			180_000,
		);
	}

	async function settle(runId: string, path = "backup-runs", ms = 240_000) {
		return waitFor(
			`run ${runId}`,
			async () => {
				const r = await call("GET", `/api/${path}/${runId}`);
				return r.json.status && r.json.status !== "running"
					? r.json
					: undefined;
			},
			ms,
		);
	}

	async function runPolicy(id: string, kind: "backup" | "verify" = "backup") {
		const started = performance.now();
		const r = await call("POST", `/api/backup-policies/${id}/run`, { kind });
		expect(r.status).toBe(202);
		const done = await settle(r.json.id);
		timings[`${kind} ${r.json.id}`] = Math.round(performance.now() - started);
		return done;
	}

	beforeAll(async () => {
		serverLogLevel("silent");
		await sweep();
		for (const img of ["postgres:17-alpine", "alpine:3.22", "busybox:1.37"])
			await docker.images.inspect(img).catch(() => docker.images.pull(img));
		const pg = container("pg", "postgres:17-alpine", 5432, [
			"-e",
			"POSTGRES_PASSWORD=test",
			"--",
		]);
		const redisUrl = `redis://${container("redis", "redis:7-alpine", 6379, ["--"])}`;
		const minio = container("minio", MINIO_IMAGE, 9000, [
			"-e",
			`MINIO_ROOT_USER=${S3_CREDS.accessKeyId}`,
			"-e",
			`MINIO_ROOT_PASSWORD=${S3_CREDS.secretAccessKey}`,
			"--",
			"server",
			"/tmp/data",
		]);
		s3Endpoint = `http://${minio}`;
		const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
		await waitFor("postgres", () =>
			runMigrations(databaseUrl).then(
				() => true,
				() => false,
			),
		);
		db = createDb(databaseUrl, { onnotice: () => {} });
		await waitFor(
			"minio",
			async () =>
				(await fetch(`${s3Endpoint}/minio/health/ready`).catch(() => null))?.ok,
		);
		const url = `${s3Endpoint}/${BUCKET}`;
		const headers = { "x-amz-content-sha256": await sha256Hex("") };
		const signed = await signV4(
			{ method: "PUT", url, headers },
			{ credentials: S3_CREDS, region: "us-east-1", service: "s3" },
		);
		expect(
			(await fetch(url, { method: "PUT", headers: { ...headers, ...signed } }))
				.status,
		).toBe(200);
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
		// MinIO listens on loopback over http.
		await db.update(instanceSettings).set({ allowPrivateHosts: true });

		nodeId = (await docker.info()).Swarm.NodeID;
		agent = Bun.spawn(
			["bun", join(import.meta.dir, "../../agent/src/index.ts")],
			{
				env: {
					...process.env,
					LOGISTACK_API_URL: `http://127.0.0.1:${api.server.port}`,
					LOGISTACK_AGENT_TOKEN: ENROLLMENT,
					LOGISTACK_AGENT_TOKEN_PATH: join(tokenDir, "node-token"),
					LOGISTACK_NODE_ID: nodeId,
					LOGISTACK_NODE_HOSTNAME: "backup-node",
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

		const config = loadConfig({
			DATABASE_URL: databaseUrl,
			REDIS_URL: redisUrl,
			LOGISTACK_MASTER_KEY: masterKey,
			LS_WORK_DIR: tokenDir,
			LS_CONTROL_NETWORK: `${PREFIX}control`,
			LS_INGRESS_NETWORK: `${PREFIX}ingress`,
			LS_CADDY_SERVICE: `${PREFIX}caddy`,
			LS_NAME_PREFIX: PREFIX,
			LS_SCOPE_LABELS: JSON.stringify(LABEL),
			LS_RECONCILE_INTERVAL_MS: "0",
			LS_METRICS_INTERVAL_MS: "0",
			LS_NODE_SYNC_INTERVAL_MS: "0",
			LS_SCHEDULE_OUTPUT_LIMIT: String(OUTPUT_LIMIT),
			LOG_LEVEL: "silent",
		});
		// Two replicas of the worker, as two Swarm tasks would run them.
		workers = [await startWorker(config), await startWorker(config)];

		const prj = await call("POST", "/api/projects", { name: "Shop" });
		envId = (await call("GET", `/api/projects/${prj.json.id}/environments`))
			.json[0].id;
		pgServiceId = await databaseService("orders-db");
		await deploy(pgServiceId);
		await psql(
			pgServiceId,
			"create table orders(id int primary key, total numeric); insert into orders select g, g * 1.5 from generate_series(1, 2500) g",
		);

		const dest = await call("POST", "/api/s3-destinations", {
			name: "MinIO",
			endpoint: s3Endpoint,
			bucket: BUCKET,
			prefix: `${PREFIX}run`,
			forcePathStyle: true,
			...S3_CREDS,
		});
		expect(dest.status).toBe(201);
		destinationId = dest.json.id;
	}, 400_000);

	afterAll(async () => {
		console.log("timings (ms)", timings);
		for (const w of workers) await w.stop().catch(() => {});
		agent?.kill();
		await api?.stop().catch(() => {});
		await sweep();
		for (const s of ["pg", "redis", "minio"])
			Bun.spawnSync(["docker", "rm", "-f", "-v", `${PREFIX}${s}`], {
				stdout: "ignore",
				stderr: "ignore",
			});
		rmSync(tokenDir, { recursive: true, force: true });
	}, 120_000);

	const s3 = () =>
		new S3Client({ endpoint: s3Endpoint, bucket: BUCKET, ...S3_CREDS });

	test("the S3 wizard's test puts, reads and deletes a probe", async () => {
		const r = await call("POST", "/api/s3-destinations/test", {
			endpoint: s3Endpoint,
			bucket: BUCKET,
			prefix: `${PREFIX}probe`,
			forcePathStyle: true,
			...S3_CREDS,
		});
		expect(r.json).toMatchObject({ ok: true });
		const left = await s3().list({ prefix: `${PREFIX}probe` });
		expect(left.contents ?? []).toHaveLength(0);
	});

	test("a Postgres backup streams to MinIO with a matching sha256", async () => {
		const p = await call(
			"POST",
			`/api/services/${pgServiceId}/backup-policies`,
			{
				target: "database",
				s3DestinationId: destinationId,
				cron: "0 3 * * *",
				timezone: "Europe/Rome",
				retention: { count: 2 },
				verifyCron: "0 4 * * 0",
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
		expect(run.objectKey).toStartWith(`backups/${policyId}/`);
		expect(run.objectKey).toEndWith(".dump");
		expect(run.sizeBytes).toBeGreaterThan(10_000);
		const bytes = await s3().file(`${PREFIX}run/${run.objectKey}`).bytes();
		expect(bytes.byteLength).toBe(run.sizeBytes);
		// pg_dump's custom format starts with PGDMP.
		expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("PGDMP");
		expect(run.checksum).toBe(
			`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
		);
		console.log("pg backup", { sizeBytes: run.sizeBytes, key: run.objectKey });
	}, 120_000);

	test("restore into a new service: the data is there", async () => {
		const [last] = (await call("GET", `/api/services/${pgServiceId}/backups`))
			.json.runs;
		const wrong = await call("POST", `/api/backup-runs/${last.id}/restore`, {
			target: { kind: "new", name: "orders-copy" },
			confirm: "orders-db",
		});
		expect(wrong.status).toBe(400);
		const started = performance.now();
		const r = await call("POST", `/api/backup-runs/${last.id}/restore`, {
			target: { kind: "new", name: "orders-copy" },
			confirm: "orders-copy",
		});
		expect(r.status).toBe(202);
		const done = await settle(r.json.run.id, "backup-runs", 300_000);
		timings.restoreNewService = Math.round(performance.now() - started);
		expect(done).toMatchObject({ status: "succeeded", kind: "restore" });
		expect(done.detail).toBe("Restored into orders-copy");
		expect(
			await psql(
				r.json.targetServiceId,
				"select count(*), sum(total) from orders",
			),
		).toBe("2500|4689375.0");
	}, 360_000);

	test("verify restores into a throwaway database, then removes it", async () => {
		const run = await runPolicy(policyId, "verify");
		expect(run).toMatchObject({
			status: "succeeded",
			kind: "verify",
			detail: "1 table restored",
		});
		expect(run.sourceRunId).toBeString();
		const helpers = (await docker.services.list({ name: [PREFIX] })).filter(
			(s) => s.Spec.Name.includes("ls-vfy-"),
		);
		expect(helpers).toHaveLength(0);
	}, 240_000);

	test("retention keeps the newest per policy and marks the rest pruned", async () => {
		await runPolicy(policyId);
		await runPolicy(policyId);
		const runs = (
			await call("GET", `/api/services/${pgServiceId}/backups`)
		).json.runs
			.filter((r: { kind: string }) => r.kind === "backup")
			.sort((a: { startedAt: string }, b: { startedAt: string }) =>
				a.startedAt < b.startedAt ? -1 : 1,
			);
		expect(runs).toHaveLength(3);
		expect(
			runs.map((r: { prunedAt: string | null }) => r.prunedAt !== null),
		).toEqual([true, false, false]);
		const listed = await s3().list({
			prefix: `${PREFIX}run/backups/${policyId}/`,
		});
		expect((listed.contents ?? []).map((o) => o.key).sort()).toEqual(
			runs
				.slice(1)
				.map((r: { objectKey: string }) => `${PREFIX}run/${r.objectKey}`),
		);
		// Days: two days on, only the newest survives a one-day rule (the newest always does).
		const [policy] = await db
			.select()
			.from(backupPolicy)
			.where(eq(backupPolicy.id, policyId));
		const ctx = ctx0();
		const deleted = await applyRetention(
			ctx,
			{
				...(policy as typeof backupPolicy.$inferSelect),
				retention: { days: 1 },
			},
			await openDestination(ctx, destinationId),
			new Date(Date.now() + 2 * 86_400_000),
		);
		expect(deleted).toEqual([runs[1].objectKey]);
	}, 240_000);

	test("verify fails when the dump is corrupted", async () => {
		const runs = (await call("GET", `/api/services/${pgServiceId}/backups`))
			.json.runs;
		const newest = runs.find(
			(r: { kind: string; status: string }) =>
				r.kind === "backup" && r.status === "succeeded",
		);
		await s3().write(
			`${PREFIX}run/${newest.objectKey}`,
			`PGDMP${"garbage ".repeat(2000)}`,
		);
		const run = await runPolicy(policyId, "verify");
		expect(run.status).toBe("failed");
		expect(run.error).toContain("pg_restore");
		expect(run.sourceRunId).toBe(newest.id);
	}, 240_000);

	test("volume backup round trip, pausing the service", async () => {
		const p = await call(
			"POST",
			`/api/services/${pgServiceId}/backup-policies`,
			{
				target: "volume",
				volumeName: pgServiceId,
				s3DestinationId: destinationId,
				cron: "30 2 * * *",
				retention: { count: 3 },
				pauseService: true,
			},
		);
		expect(p.status).toBe(201);
		const run = await runPolicy(p.json.id);
		expect(run).toMatchObject({ status: "succeeded" });
		expect(run.objectKey).toEndWith(".tar.zst");
		const head = await s3()
			.file(`${PREFIX}run/${run.objectKey}`)
			.slice(0, 4)
			.bytes();
		expect([...head]).toEqual([0x28, 0xb5, 0x2f, 0xfd]); // zstd magic
		// Back up after the pause.
		await waitFor(
			"postgres back",
			() => locateTask(ctx0(), pgServiceId),
			120_000,
		);
		expect(await psql(pgServiceId, "select count(*) from orders")).toBe("2500");

		const restored = await call("POST", `/api/backup-runs/${run.id}/restore`, {
			target: { kind: "new", name: "scratch" },
			confirm: "scratch",
		});
		expect(restored.status).toBe(202);
		const done = await settle(restored.json.run.id);
		expect(done.status).toBe("succeeded");
		const volume = done.detail.replace("Restored into volume ", "");
		expect(volume).toStartWith(`${PREFIX}ls-vol-`);
		const read = runner().runJob(nodeId, {
			kind: "container",
			image: "busybox:1.37",
			containerName: `${PREFIX}read`,
			labels: LABEL,
			mounts: [
				{ type: "volume", source: volume, target: "/v", readOnly: true },
			],
			cmd: ["cat", "/v/PG_VERSION"],
			timeoutSec: 30,
		});
		let out = "";
		for await (const c of read) out += new TextDecoder().decode(c.data);
		expect(out.trim()).toBe("17");
	}, 300_000);

	async function schedule(body: Record<string, unknown>) {
		const r = await call("POST", "/api/schedules", {
			cron: "0 0 1 1 *",
			target: { kind: "ephemeral", image: "busybox:1.37" },
			timeoutS: 60,
			...body,
		});
		expect(r.status).toBe(201);
		return r.json.id as string;
	}

	test("a cron schedule fires exactly once per minute across two workers", async () => {
		const id = await schedule({
			name: "tick",
			cron: "* * * * *",
			script: "echo tick from $(hostname)",
		});
		const minute = Math.floor(Date.now() / 60_000) + 1;
		await waitFor(
			"the next minute plus a margin",
			() => Date.now() > minute * 60_000 + 8_000,
			80_000,
		);
		await call("PATCH", `/api/schedules/${id}`, { enabled: false });
		const runs = await db
			.select()
			.from(scheduleRun)
			.where(eq(scheduleRun.scheduleId, id))
			.orderBy(asc(scheduleRun.startedAt));
		const inMinute = runs.filter(
			(r) => Math.floor(r.startedAt.getTime() / 60_000) === minute,
		);
		expect(inMinute).toHaveLength(1);
		expect(inMinute[0]).toMatchObject({
			status: "succeeded",
			exitCode: 0,
			trigger: "cron",
		});
		expect(inMinute[0]?.output).toStartWith("tick from ");
	}, 120_000);

	test("forbid skips a run that overlaps the one still going", async () => {
		const id = await schedule({
			name: "slow",
			script: "sleep 4; echo done",
			concurrency: "forbid",
		});
		const first = await call("POST", `/api/schedules/${id}/run`);
		await waitFor("first run started", async () => {
			const [r] = await db
				.select()
				.from(scheduleRun)
				.where(eq(scheduleRun.id, first.json.id));
			return (
				r?.status === "running" && Date.now() - r.startedAt.getTime() > 500
			);
		});
		const second = await call("POST", `/api/schedules/${id}/run`);
		const b = await settle(second.json.id, "schedule-runs", 30_000);
		expect(b).toMatchObject({ status: "skipped" });
		expect(b.error).toContain(first.json.id);
		const a = await settle(first.json.id, "schedule-runs", 30_000);
		expect(a).toMatchObject({ status: "succeeded", output: "done\n" });
	}, 60_000);

	test("replace cancels the run still going", async () => {
		const id = await schedule({
			name: "replace",
			script: "sleep 30",
			concurrency: "replace",
		});
		const first = await call("POST", `/api/schedules/${id}/run`);
		await Bun.sleep(1500);
		const second = await call("POST", `/api/schedules/${id}/run`);
		const a = await settle(first.json.id, "schedule-runs", 20_000);
		expect(a.status).toBe("cancelled");
		const b = await settle(second.json.id, "schedule-runs", 60_000);
		expect(b.status).toBe("succeeded");
	}, 90_000);

	test("output beyond the limit is counted, not stored", async () => {
		const id = await schedule({
			name: "chatty",
			script: "head -c 300000 /dev/zero | tr '\\0' x; echo; exit 3",
		});
		const r = await call("POST", `/api/schedules/${id}/run`);
		const done = await settle(r.json.id, "schedule-runs", 30_000);
		expect(done).toMatchObject({
			status: "failed",
			exitCode: 3,
			outputBytes: 300_001,
		});
		expect(done.output).toHaveLength(OUTPUT_LIMIT);
		expect(done.output).toMatch(/^x+$/);
	}, 60_000);
});
