import { describe, expect, test } from "bun:test";
import type { LogDrainConfig, LogRecord } from "@logistack/contracts";
import {
	DrainShipper,
	parseTimestamped,
	type Transport,
} from "../src/drains.ts";

const config: LogDrainConfig = {
	kind: "http",
	url: "http://drain.invalid/",
	headers: {},
};
const meta = {
	organizationId: "org",
	organization: "org",
	projectId: "prj",
	project: "p",
	environmentId: "env",
	environment: "e",
	serviceId: "svc",
	service: "s",
};
const rec = (line: string): LogRecord => ({
	at: Date.now(),
	stream: "stdout",
	line,
	meta,
	deploymentId: "dep",
	node: "n",
});
const limits = {
	maxQueueBytes: 1024 * 1024,
	maxBatchLines: 100,
	maxBatchBytes: 64 * 1024,
	flushMs: 5,
	timeoutMs: 1000,
	maxBackoffMs: 20,
};

test("parseTimestamped splits Docker's RFC 3339 prefix", () => {
	expect(
		parseTimestamped("2026-11-07T10:00:00.123456789Z hello world"),
	).toEqual({
		at: Date.UTC(2026, 10, 7, 10, 0, 0, 123),
		nanos: 456789,
		line: "hello world",
	});
	expect(parseTimestamped("2026-11-07T10:00:00Z")?.line).toBe("");
	expect(parseTimestamped("no timestamp")).toBeUndefined();
});

describe("DrainShipper", () => {
	test("delivers everything in bounded batches while the drain is up", async () => {
		const sent: number[] = [];
		const transport: Transport = async (b) => {
			if (b.kind === "http") sent.push(JSON.parse(b.body).length);
			return { status: 204 };
		};
		const s = new DrainShipper("d", config, transport, limits);
		for (let i = 0; i < 1000; i++) s.push(rec(`line ${i}`));
		const deadline = Date.now() + 5000;
		while (s.status.sentLines < 1000 && Date.now() < deadline)
			await Bun.sleep(5);
		s.close();
		expect(s.status.sentLines).toBe(1000);
		expect(s.status.droppedLines).toBe(0);
		expect(s.status.state).toBe("ok");
		expect(Math.max(...sent)).toBeLessThanOrEqual(limits.maxBatchLines);
	});

	test("memory stays bounded while the drain is down", async () => {
		let attempts = 0;
		const down: Transport = async () => {
			attempts++;
			throw new Error("connect ECONNREFUSED");
		};
		const s = new DrainShipper("d", config, down, limits);
		const line = "x".repeat(1024);
		Bun.gc(true);
		const before = process.memoryUsage().heapUsed;
		// 200 MB of logs into a 1 MB buffer, with the sender failing and retrying throughout.
		for (let round = 0; round < 20; round++) {
			for (let i = 0; i < 10_000; i++) s.push(rec(line));
			expect(s.heldBytes).toBeLessThanOrEqual(limits.maxQueueBytes);
			await Bun.sleep(10);
		}
		Bun.gc(true);
		const grown = process.memoryUsage().heapUsed - before;
		const snap = s.snapshot();
		s.close();
		expect(attempts).toBeGreaterThan(0);
		expect(snap.state).toBe("failing");
		expect(snap.lastError).toBe("connect ECONNREFUSED");
		expect(snap.queuedBytes).toBeLessThanOrEqual(limits.maxQueueBytes);
		expect(snap.droppedLines).toBeGreaterThan(190_000);
		// The buffer plus allocator slack; unbounded would be ~200 MB.
		expect(grown).toBeLessThan(16 * 1024 * 1024);
	});

	test("a failed batch goes back in front and is delivered after recovery", async () => {
		let up = false;
		const got: string[] = [];
		const flaky: Transport = async (b) => {
			if (!up) throw new Error("down");
			if (b.kind === "http")
				for (const r of JSON.parse(b.body)) got.push(r.message);
			return {};
		};
		const s = new DrainShipper("d", config, flaky, limits);
		for (let i = 0; i < 10; i++) s.push(rec(`l${i}`));
		await Bun.sleep(30);
		expect(s.status.state).toBe("failing");
		up = true;
		const deadline = Date.now() + 3000;
		while (got.length < 10 && Date.now() < deadline) await Bun.sleep(5);
		s.close();
		expect(got).toEqual(Array.from({ length: 10 }, (_, i) => `l${i}`));
		expect(s.status.state).toBe("ok");
	});

	test("a slow but healthy drain is congested, so readers pause instead of dropping", () => {
		const never: Transport = () => new Promise(() => {});
		const s = new DrainShipper("d", config, never, {
			...limits,
			flushMs: 60_000,
		});
		for (let i = 0; i < 900; i++) s.push(rec("y".repeat(1024)));
		expect(s.congested).toBe(true);
		s.close();
	});
});
