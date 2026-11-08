import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
	acquireLease,
	type Cluster,
	createCluster,
	withLock,
} from "../src/cluster.ts";
import { createRuns } from "../src/database.ts";
import { setLogLevel } from "../src/log.ts";
import { hasDocker, startInfra } from "./harness.ts";

/** Two api replicas share only Redis; each gets its own connections and run registry here. */
describe.skipIf(!hasDocker)("state shared across api replicas", () => {
	let infra: Awaited<ReturnType<typeof startInfra>>;
	let a: RedisClient;
	let b: RedisClient;
	let busA: Cluster;
	let busB: Cluster;

	beforeAll(async () => {
		setLogLevel("silent");
		infra = await startInfra("cluster", "cluster");
		a = new RedisClient(infra.redisUrl);
		b = new RedisClient(infra.redisUrl);
		busA = createCluster(infra.redisUrl);
		busB = createCluster(infra.redisUrl);
	}, 60_000);

	afterAll(() => {
		for (const c of [a, b]) c.close();
		busA?.close();
		busB?.close();
		infra?.stop();
	});

	test("a lease has one holder; it renews while held and lapses when its holder dies", async () => {
		const held = await acquireLease(a, "ls:test:lease", 300);
		expect(held).toBeDefined();
		expect(await acquireLease(b, "ls:test:lease", 300)).toBeUndefined();
		// Renewal keeps it past its first TTL.
		await Bun.sleep(500);
		expect(held?.lost).toBe(false);
		expect(await acquireLease(b, "ls:test:lease", 300)).toBeUndefined();
		await held?.release();
		const next = await acquireLease(b, "ls:test:lease", 300);
		expect(next).toBeDefined();
		await next?.release();

		// A dead holder never renews: another replica takes over once the TTL runs out.
		await a.send("SET", ["ls:test:dead", "gone", "PX", "200"]);
		expect(await acquireLease(b, "ls:test:dead", 300)).toBeUndefined();
		await Bun.sleep(250);
		const taken = await acquireLease(b, "ls:test:dead", 300);
		expect(taken).toBeDefined();
		await taken?.release();
	});

	test("a holder whose key was taken over learns it lost the lease", async () => {
		const held = await acquireLease(a, "ls:test:stolen", 300);
		await b.send("SET", ["ls:test:stolen", "someone else"]);
		await Bun.sleep(250);
		expect(held?.lost).toBe(true);
		// Releasing a lost lease leaves the new holder's key alone.
		await held?.release();
		expect(await b.get("ls:test:stolen")).toBe("someone else");
	});

	test("withLock serializes the same key across replicas", async () => {
		const order: string[] = [];
		const step = (name: string, ms: number) => async () => {
			order.push(`${name} in`);
			await Bun.sleep(ms);
			order.push(`${name} out`);
			return name;
		};
		const results = await Promise.all([
			withLock(a, "ls:test:lock", step("a", 150), { pollMs: 10 }),
			Bun.sleep(20).then(() =>
				withLock(b, "ls:test:lock", step("b", 10), { pollMs: 10 }),
			),
		]);
		expect(results).toEqual(["a", "b"]);
		expect(order).toEqual(["a in", "a out", "b in", "b out"]);
	});

	test("a query cancel sent to one replica aborts the run on the other", async () => {
		const runsA = createRuns(a, busA);
		const runsB = createRuns(b, busB);
		const owner = { serviceId: "svc_1", actorId: "usr_1" };
		const runId = crypto.randomUUID();
		const running = runsA.run(
			owner,
			runId,
			(signal) =>
				new Promise<string>((resolve) => {
					const t = setTimeout(() => resolve("finished"), 5000);
					signal.addEventListener("abort", () => {
						clearTimeout(t);
						resolve("aborted");
					});
				}),
		);
		await Bun.sleep(50);
		// The run id is taken cluster-wide.
		await expect(runsB.run(owner, runId, async () => "twice")).rejects.toThrow(
			"run already started",
		);
		expect(await runsB.cancel("svc_1", "someone else", runId)).toBe(false);
		expect(await runsB.cancel("svc_2", "usr_1", runId)).toBe(false);
		expect(await runsB.cancel("svc_1", "usr_1", runId)).toBe(true);
		expect(await running).toBe("aborted");
		// Finished: nothing left to cancel.
		expect(await runsB.cancel("svc_1", "usr_1", runId)).toBe(false);
	});
});
