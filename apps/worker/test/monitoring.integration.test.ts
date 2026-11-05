import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt, importMasterKey } from "@logistack/core";
import {
	environment,
	node,
	nodeJoin,
	organization,
	project,
	service,
	serviceThreshold,
	sshKey,
} from "@logistack/db";
import { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import type { Ctx } from "../src/ctx.ts";
import { createMetricsConsumer } from "../src/metrics-consumer.ts";
import {
	applyRetention,
	ensurePartitions,
	type MetricsEntry,
	rollup,
} from "../src/metrics-store.ts";
import { claimJoin, runJoinStep } from "../src/node-join.ts";
import {
	evaluateServiceThresholds,
	evaluateThresholds,
} from "../src/thresholds.ts";
import {
	hasDocker,
	MON_PREFIX,
	removeContainers,
	runContainer,
	startMonInfra,
} from "./monitoring-harness.ts";

const STREAM = "ls:test:metrics";

function sample(at: number, i: number, containers = 2): MetricsEntry {
	return {
		type: "metrics",
		at,
		host: {
			cpuPercent: 10 * (i + 1),
			load: [i, 0, 0],
			memory: { totalBytes: 1000, availableBytes: 500, usedBytes: 500 },
			swap: { totalBytes: 0, usedBytes: 0 },
			disks: [
				{
					mount: "/",
					device: "/dev/sda",
					fsType: "ext4",
					totalBytes: 100,
					usedBytes: 20,
					availableBytes: 80,
				},
			],
			// 1000 B/s receive, 500 B/s transmit at a 10s interval.
			network: { rxBytes: 10_000 * i, txBytes: 5_000 * i },
			uptimeSec: i,
		},
		containers: Array.from({ length: containers }, (_, c) => ({
			containerId: `ctr-${c}`,
			name: `ls-svc-x.${c}`,
			resourceId: "svc_x",
			cpuPercent: 50,
			memoryBytes: 100,
			memoryLimitBytes: 200,
			network: { rxBytes: 100 * i, txBytes: 0 },
			blockIo: { readBytes: 0, writeBytes: 0 },
		})),
	};
}

describe.skipIf(!hasDocker)(
	"monitoring storage on real Postgres and Redis",
	() => {
		let infra: Awaited<ReturnType<typeof startMonInfra>>;
		let redis: RedisClient;
		beforeAll(async () => {
			infra = await startMonInfra();
			redis = new RedisClient(infra.redisUrl);
		}, 120_000);
		afterAll(async () => {
			redis?.close();
			await infra?.stop();
		});

		const add = (nodeId: string, m: MetricsEntry) =>
			redis.send("XADD", [
				STREAM,
				"*",
				"node",
				nodeId,
				"at",
				String(m.at),
				"data",
				JSON.stringify(m),
			]);
		const count = async (table: string) =>
			Number(
				(await infra.sql.unsafe(`select count(*)::int as n from ${table}`))[0]
					?.n,
			);

		test("the consumer stores each sample once, across duplicates and a crashed consumer", async () => {
			const t0 = Date.now() - 60_000;
			for (let i = 0; i < 3; i++)
				await add("node-a", sample(t0 + i * 10_000, i));
			await add("node-a", sample(t0, 0)); // the agent resent a sample
			// A consumer that read two entries and died before acking them.
			await redis.send("XGROUP", ["CREATE", STREAM, "g", "0", "MKSTREAM"]);
			await redis.send("XREADGROUP", [
				"GROUP",
				"g",
				"dead",
				"COUNT",
				"2",
				"STREAMS",
				STREAM,
				">",
			]);

			const consumer = createMetricsConsumer({
				sql: infra.sql,
				redisUrl: infra.redisUrl,
				stream: STREAM,
				group: "g",
				consumer: "alive",
				claimIdleMs: 1,
				blockMs: 10,
			});
			await Bun.sleep(5);
			for (let i = 0; i < 4; i++) await consumer.poll();
			consumer.close();

			expect(await count("metric_host_raw")).toBe(3);
			expect(await count("metric_container_raw")).toBe(6);
			const pending = (await redis.send("XPENDING", [
				STREAM,
				"g",
			])) as unknown[];
			expect(pending[0]).toBe(0);
		});

		test("rollups average, rate counters, weight hours by samples, and converge on rerun", async () => {
			await infra.sql`truncate metric_host_raw, metric_container_raw, metric_host_1m, metric_container_1m, metric_host_1h, metric_container_1h, metric_rollup_state`;
			const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
			const consumer = createMetricsConsumer({
				sql: infra.sql,
				redisUrl: infra.redisUrl,
				stream: `${STREAM}:r`,
				group: "g",
				blockMs: 10,
			});
			// Two full minutes at 10s: minute 0 has cpu 10..60, minute 1 has cpu 70..120.
			for (let i = 0; i < 12; i++)
				await add("node-r", sample(hour + i * 10_000, i, 1));
			// Rewire the samples into the rollup stream used by this test's consumer.
			const entries = (await redis.send("XRANGE", [STREAM, "-", "+"])) as [
				string,
				string[],
			][];
			for (const [, f] of entries.slice(-12))
				await redis.send("XADD", [`${STREAM}:r`, "*", ...f]);
			while ((await consumer.poll()) > 0);
			consumer.close();

			// The first pass rolls minutes; a pass after the hour closes rolls the hour.
			await rollup(infra.sql, new Date(hour + 10 * 60_000));
			const now = new Date(hour + 3_600_000 + 5 * 60_000);
			await rollup(infra.sql, now);
			const minutes = await infra.sql<
				{
					cpu: number;
					cpu_max: number;
					rx: number;
					tx: number;
					samples: number;
				}[]
			>`
			select cpu, cpu_max, rx, tx, samples from metric_host_1m where node_id = 'node-r' order by ts`;
			expect(minutes.map((m) => [m.cpu, m.cpu_max, m.samples])).toEqual([
				[35, 60, 6],
				[95, 120, 6],
			]);
			expect(minutes.map((m) => [m.rx, m.tx])).toEqual([
				[1000, 500],
				[1000, 500],
			]);
			const [ctr] = await infra.sql<{ rx: number; cpu: number }[]>`
			select rx, cpu from metric_container_1m where container_id = 'ctr-0' order by ts limit 1`;
			expect(ctr).toEqual({ rx: 10, cpu: 50 });

			const [h1] = await infra.sql<
				{ cpu: number; samples: number; rx: number }[]
			>`
			select cpu, samples, rx from metric_host_1h where node_id = 'node-r'`;
			expect(h1).toEqual({ cpu: 65, samples: 12, rx: 1000 });

			const before =
				await infra.sql`select * from metric_host_1m order by node_id, ts`;
			await infra.sql`delete from metric_rollup_state`;
			await rollup(infra.sql, new Date(hour + 10 * 60_000));
			await rollup(infra.sql, now);
			await rollup(infra.sql, now);
			expect(
				await infra.sql`select * from metric_host_1m order by node_id, ts`,
			).toEqual(before);
			expect(await count("metric_host_1h")).toBe(1);
		});

		test("retention drops whole expired day partitions and trims hourly rows", async () => {
			await ensurePartitions(infra.sql);
			await infra.sql`select metric_ensure_partitions('metric_host_raw', (now() at time zone 'UTC')::date - 5, (now() at time zone 'UTC')::date - 5)`;
			await infra.sql`select metric_ensure_partitions('metric_host_1m', (now() at time zone 'UTC')::date - 9, (now() at time zone 'UTC')::date - 9)`;
			await infra.sql`insert into metric_host_1h (node_id, ts, cpu, cpu_max, load1, mem_used, mem_total, disk_used, disk_total, samples)
			values ('old', now() - interval '100 days', 1, 1, 0, 0, 0, 0, 0, 1)`;
			const dropped = await applyRetention(infra.sql, {
				rawHours: 24,
				minuteDays: 7,
				hourDays: 90,
			});
			const day = (n: number) =>
				new Date(Date.now() - n * 86_400_000)
					.toISOString()
					.slice(0, 10)
					.replaceAll("-", "");
			expect(dropped.sort()).toEqual([
				`metric_host_1m_${day(9)}`,
				`metric_host_raw_${day(5)}`,
			]);
			expect(
				await infra.sql`select 1 from metric_host_1h where node_id = 'old'`,
			).toHaveLength(0);
			// Today's partitions survive, so inserts keep working.
			const [today] =
				await infra.sql`select to_regclass(${`metric_host_raw_${day(0)}`})::text as t`;
			expect(today?.t).toBe(`metric_host_raw_${day(0)}`);
		});

		test("thresholds fire once and resolve once", async () => {
			const [org] = await infra.db
				.insert(organization)
				.values({
					id: "org_mon",
					name: "Mon",
					slug: "mon",
					createdAt: new Date(),
				})
				.returning();
			const [n] = await infra.db
				.insert(node)
				.values({
					organizationId: org?.id as string,
					swarmNodeId: "node-t",
					hostname: "t1",
					address: "10.0.0.9",
					role: "worker",
				})
				.returning();
			await infra.sql`insert into metric_threshold (id, organization_id, metric, percent, for_sec) values ('thr_cpu', 'org_mon', 'cpu', 80, 60)`;
			const events: unknown[] = [];
			const bus = { publish: async (...a: unknown[]) => void events.push(a) };
			const at = (cpu: number, ago: number) =>
				infra.sql`insert into metric_host_raw values ('node-t', now() - make_interval(secs => ${ago}), ${cpu}, 0, 1, 2, 1, 2, 0, 0)`;

			await at(95, 5);
			await at(90, 15);
			expect(
				(await evaluateThresholds(infra.sql, bus)).map((e) => e.state),
			).toEqual(["firing"]);
			expect(await evaluateThresholds(infra.sql, bus)).toEqual([]);
			await infra.sql`delete from metric_host_raw where node_id = 'node-t'`;
			await at(20, 5);
			const resolved = await evaluateThresholds(infra.sql, bus);
			expect(resolved).toMatchObject([
				{ state: "resolved", nodeId: n?.id, metric: "cpu", value: 20 },
			]);
			expect(events).toHaveLength(2);
			expect((events[0] as unknown[]).slice(0, 3)).toEqual([
				"metric.threshold",
				"org_mon",
				{ type: "node", id: n?.id },
			]);
		});

		test("service thresholds read the worst replica and cross once each way", async () => {
			const [p] = await infra.db
				.insert(project)
				.values({ organizationId: "org_mon", name: "P", slug: "p" })
				.returning();
			const [e] = await infra.db
				.insert(environment)
				.values({
					projectId: p?.id as string,
					name: "Prod",
					slug: "prod",
					kind: "production",
					isDefault: true,
				})
				.returning();
			const [s] = await infra.db
				.insert(service)
				.values({
					environmentId: e?.id as string,
					name: "api",
					slug: "api",
					kind: "application",
					spec: {
						kind: "application",
						source: { type: "image", image: "nginx:1" },
						build: { type: "image" },
						ports: [],
						replicas: 2,
						resources: { memoryMb: 100 },
						placement: [],
					},
				})
				.returning();
			const svc = s?.id as string;
			await infra.db.insert(serviceThreshold).values([
				{
					id: "sth_mem",
					organizationId: "org_mon",
					serviceId: svc,
					metric: "memoryPercent",
					above: 80,
					forSec: 60,
				},
				{
					id: "sth_mb",
					organizationId: "org_mon",
					serviceId: svc,
					metric: "memoryMb",
					above: 500,
					forSec: 60,
				},
			]);
			const MiB = 1_048_576;
			const at = (ctr: string, used: number, ago: number) =>
				infra.sql`insert into metric_container_raw values ('node-t', ${ctr},
					now() - make_interval(secs => ${ago}), ${svc}, ${ctr}, 1, ${used}, ${100 * MiB}, 0, 0, 0, 0)`;
			const events: unknown[][] = [];
			const bus = { publish: async (...a: unknown[]) => void events.push(a) };

			// One replica at 90% of its limit, the other idle: the worst one counts.
			await at("ctr-a", 90 * MiB, 5);
			await at("ctr-a", 90 * MiB, 15);
			await at("ctr-b", 10 * MiB, 5);
			expect(await evaluateServiceThresholds(infra.sql, bus)).toMatchObject([
				{
					thresholdId: "sth_mem",
					serviceId: svc,
					service: "api",
					state: "firing",
					value: 90,
				},
			]);
			expect(await evaluateServiceThresholds(infra.sql, bus)).toEqual([]);
			const [row] =
				await infra.sql`select firing, value from service_threshold where id = 'sth_mb'`;
			expect(row).toEqual({ firing: false, value: 90 });

			await infra.sql`delete from metric_container_raw where service_id = ${svc}`;
			await at("ctr-a", 20 * MiB, 5);
			expect(
				(await evaluateServiceThresholds(infra.sql, bus)).map((x) => [
					x.thresholdId,
					x.state,
				]),
			).toEqual([["sth_mem", "resolved"]]);
			expect(events.map((x) => x.slice(0, 3))).toEqual([
				["service.threshold", "org_mon", { type: "service", id: svc }],
				["service.threshold", "org_mon", { type: "service", id: svc }],
			]);
		});

		describe("Add-server steps against a local sshd", () => {
			const sshd = `${MON_PREFIX}${crypto.randomUUID().slice(0, 8)}-sshd`;
			let dir: string;
			let ctx: Ctx;
			let port: number;
			beforeAll(async () => {
				dir = mkdtempSync(join(tmpdir(), "ls-test-mon-key-"));
				Bun.spawnSync([
					"ssh-keygen",
					"-q",
					"-t",
					"ed25519",
					"-N",
					"",
					"-f",
					join(dir, "id"),
				]);
				const addr = runContainer(
					sshd,
					"lscr.io/linuxserver/openssh-server:10.3_p1-r1-ls241",
					2222,
					[
						"-e",
						`PUBLIC_KEY=${readFileSync(join(dir, "id.pub"), "utf8").trim()}`,
						"-e",
						"USER_NAME=deploy",
						"-e",
						"SUDO_ACCESS=true",
					],
				);
				port = Number(addr.split(":").at(-1));
				const masterKey = await importMasterKey(
					crypto.getRandomValues(new Uint8Array(32)).toBase64(),
				);
				ctx = {
					db: infra.db,
					masterKey,
					bus: { redis, publish: async () => {} },
					docker: { info: async () => ({ Swarm: { NodeAddr: "127.0.0.1" } }) },
				} as unknown as Ctx;
				await infra.db.insert(sshKey).values({
					id: "ssh_mon",
					organizationId: "org_mon",
					name: "test",
					publicKey: readFileSync(join(dir, "id.pub"), "utf8"),
					privateKeyEncrypted: await encrypt(
						masterKey,
						readFileSync(join(dir, "id"), "utf8"),
					),
					fingerprint: "SHA256:test",
				});
				// sshd generates host keys and starts after the image's init scripts.
				for (let i = 0; i < 60; i++) {
					const r = Bun.spawnSync(
						["ssh-keyscan", "-p", String(port), "127.0.0.1"],
						{ stderr: "ignore" },
					);
					if (r.stdout.toString().includes("ssh-")) break;
					await Bun.sleep(1_000);
				}
			}, 180_000);
			afterAll(() => {
				removeContainers([sshd]);
				rmSync(dir, { recursive: true, force: true });
			});

			const run = async () => {
				const row = await claimJoin(ctx);
				expect(row).toBeDefined();
				if (row) await runJoinStep(ctx, row);
				const [after] = await infra.db
					.select()
					.from(nodeJoin)
					.where(eq(nodeJoin.id, row?.id ?? ""));
				return after;
			};

			test("test pins the host key, preflight reports checks", async () => {
				const [join_] = await infra.db
					.insert(nodeJoin)
					.values({
						organizationId: "org_mon",
						name: "edge",
						host: "127.0.0.1",
						port,
						sshUser: "deploy",
						sshKeyId: "ssh_mon",
					})
					.returning();
				const tested = await run();
				expect({ state: tested?.state, error: tested?.error }).toEqual({
					state: "succeeded",
					error: null,
				});
				expect(tested?.hostKey).toContain("ssh-");
				expect(
					tested?.log.some((l) => l.startsWith("Connected as deploy")),
				).toBe(true);

				await infra.db
					.update(nodeJoin)
					.set({ step: "preflight", state: "queued" })
					.where(eq(nodeJoin.id, join_?.id ?? ""));
				const checked = await run();
				const byId = Object.fromEntries(
					(checked?.checks ?? []).map((c) => [c.id, c.status]),
				);
				expect(byId.privileges).toBe("ok");
				expect(byId.arch).toBe("ok");
				expect(Object.keys(byId)).toContain("manager");
			}, 60_000);

			test("a changed host key is refused once pinned", async () => {
				const [j] = await infra.db
					.insert(nodeJoin)
					.values({
						organizationId: "org_mon",
						name: "spoofed",
						host: "127.0.0.1",
						port,
						sshUser: "deploy",
						sshKeyId: "ssh_mon",
						hostKey: `[127.0.0.1]:${port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n`,
					})
					.returning();
				const after = await run();
				expect(after?.id).toBe(j?.id);
				expect(after?.state).toBe("failed");
				expect(after?.error).toMatch(/host key|verification/i);
			}, 60_000);
		});
	},
);
