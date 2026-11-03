import { expect, test } from "bun:test";
import {
	formatBytes,
	formatPct,
	formatRate,
	pct,
	stats,
	sum,
	timeTicks,
	toRows,
} from "./metrics";

test("x ticks land on round local times inside the window", () => {
	const from = new Date(2026, 10, 3, 9, 7).getTime();
	const ticks = timeTicks("6h", from, from + 6 * 3_600_000);
	expect(ticks).toHaveLength(6);
	expect(ticks.every((t) => new Date(t).getMinutes() === 0)).toBe(true);
	expect(new Date(ticks[0] ?? 0).getHours()).toBe(10);
});

const p = (t: number, cpu: number | null) => ({ t, cpu });

test("series merge into one row per bucket, missing values as null", () => {
	const rows = toRows(
		[
			{ key: "a", points: [p(0, 1), p(10_000, 2)] },
			{ key: "b", points: [p(10_000, 5)] },
		],
		(x) => x.cpu,
		10,
	);
	expect(rows).toEqual([
		{ t: 0, a: 1, b: null },
		{ t: 10_000, a: 2, b: 5 },
	]);
});

test("a silent stretch breaks the line with a null row", () => {
	const rows = toRows(
		[{ key: "a", points: [p(30_000, 3), p(0, 1), p(10_000, 2)] }],
		(x) => x.cpu,
		10,
	);
	expect(rows.map((r) => [r.t, r.a])).toEqual([
		[0, 1],
		[10_000, 2],
		[20_000, null],
		[30_000, 3],
	]);
});

test("one-step jitter does not count as a gap", () => {
	const rows = toRows(
		[{ key: "a", points: [p(0, 1), p(14_000, 2)] }],
		(x) => x.cpu,
		10,
	);
	expect(rows).toHaveLength(2);
});

test("ratios and sums keep unknown distinct from zero", () => {
	expect(pct(1, 4)).toBe(25);
	expect(pct(null, 4)).toBeNull();
	expect(pct(1, 0)).toBeNull();
	expect(sum(null, null)).toBeNull();
	expect(sum(null, 3)).toBe(3);
});

test("stats skip gaps", () => {
	const rows = [
		{ t: 0, a: 10 },
		{ t: 1, a: null },
		{ t: 2, a: 30 },
	];
	expect(stats(rows, "a")).toEqual({ latest: 30, avg: 20, max: 30 });
	expect(stats([{ t: 0, a: null }], "a")).toEqual({
		latest: null,
		avg: null,
		max: null,
	});
});

test("units", () => {
	expect(formatBytes(0)).toBe("0 B");
	expect(formatBytes(1536)).toBe("1.50 KiB");
	expect(formatBytes(16 * 1024 ** 3)).toBe("16.0 GiB");
	expect(formatBytes(512 * 1024 ** 3)).toBe("512 GiB");
	expect(formatBytes(null)).toBe("–");
	expect(formatRate(2.5 * 1024 ** 2)).toBe("2.50 MiB/s");
	expect(formatRate(17.2 * 1024 ** 2, true)).toBe("17 MiB/s");
	expect(formatBytes(4.29 * 1024 ** 2, true)).toBe("4.3 MiB");
	expect(formatPct(38.4)).toBe("38%");
	expect(formatPct(4.23)).toBe("4.2%");
	expect(formatPct(0)).toBe("0%");
	expect(formatPct(null)).toBe("–");
});
