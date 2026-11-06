import { afterAll, describe, expect, test } from "bun:test";
import { Worker } from "bullmq";
import { drain, resume, waitingFor } from "../src/drain.ts";
import { createQueues, redisConnection } from "../src/queues.ts";

// Real BullMQ on the dev Redis, under a prefix no other suite or the running worker uses.
const connection = redisConnection(
	process.env.REDIS_URL ?? "redis://127.0.0.1:6380",
);
const prefix = `ls-test-pupd-${Date.now()}`;
const queues = createQueues(connection, prefix);
const lines: string[] = [];
const report = {
	step: async () => {},
	line: async (t: string) => {
		lines.push(t);
	},
};

afterAll(async () => {
	for (const q of Object.values(queues)) {
		await q.obliterate({ force: true });
		await q.close();
	}
});

describe("waitingFor", () => {
	test("names what still runs, in queue order", () => {
		expect(waitingFor([0, 0, 0])).toBeNull();
		expect(waitingFor([1, 0, 0])).toBe("Waiting for 1 deployment");
		expect(waitingFor([2, 1, 0])).toBe(
			"Waiting for 2 deployments and 1 backup",
		);
		expect(waitingFor([2, 1, 3])).toBe(
			"Waiting for 2 deployments, 1 backup and 3 migration steps",
		);
	});
});

describe("drain", () => {
	test("waits for a running job, starts no new one until resumed, and times out cleanly", async () => {
		const started: string[] = [];
		let finish = () => {};
		const running = new Promise<void>((r) => {
			finish = r;
		});
		const worker = new Worker(
			"deploy",
			async (job) => {
				started.push(job.name);
				if (job.name === "first") await running;
			},
			{ connection, prefix, concurrency: 4 },
		);
		try {
			await queues.deploy.add("first", {});
			for (let i = 0; i < 50 && !started.length; i++) await Bun.sleep(100);
			expect(started).toEqual(["first"]);

			// A drain that cannot finish gives up and says what it waited for.
			const timedOut = await drain(queues, report, {
				timeoutMs: 300,
				pollMs: 100,
			});
			expect(timedOut).toEqual({
				ok: false,
				error:
					"Gave up after 0 min: waiting for 1 deployment. No service was changed.",
			});
			expect(await queues.deploy.isPaused()).toBe(true);

			const drained = drain(queues, report, { timeoutMs: 10_000, pollMs: 100 });
			await queues.deploy.add("second", {});
			await Bun.sleep(500);
			expect(started).toEqual(["first"]);
			finish();
			expect(await drained).toEqual({ ok: true });
			expect(lines).toContain("Waiting for 1 deployment");
			expect(lines.at(-1)).toBe("Nothing is running");
			await Bun.sleep(300);
			expect(started).toEqual(["first"]);

			await resume(queues);
			for (let i = 0; i < 50 && started.length < 2; i++) await Bun.sleep(100);
			expect(started).toEqual(["first", "second"]);
			expect(await queues.deploy.isPaused()).toBe(false);
			expect(await queues.backup.isPaused()).toBe(false);
			expect(await queues.migration.isPaused()).toBe(false);
		} finally {
			finish();
			await worker.close();
		}
	}, 30_000);
});
