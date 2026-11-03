import { expect, test } from "bun:test";
import { selectForDeletion } from "../src/index.ts";

const now = new Date("2026-11-03T00:00:00Z");
const daysAgo = (d: number) => ({
	key: `b-${d}`,
	lastModified: new Date(now.getTime() - d * 86_400_000),
});
// Deliberately unsorted: selection must not depend on input order.
const objects = [5, 0, 30, 1, 10, 2].map(daysAgo);
const keys = (os: { key: string }[]) => os.map((o) => o.key).sort();

test("no rules deletes nothing", () => {
	expect(selectForDeletion(objects, {}, now)).toEqual([]);
});

test("count keeps the newest N", () => {
	expect(keys(selectForDeletion(objects, { count: 3 }, now))).toEqual([
		"b-10",
		"b-30",
		"b-5",
	]);
});

test("days keeps everything younger than the cutoff", () => {
	expect(keys(selectForDeletion(objects, { days: 7 }, now))).toEqual([
		"b-10",
		"b-30",
	]);
});

test("an object survives if either rule keeps it", () => {
	expect(keys(selectForDeletion(objects, { count: 4, days: 3 }, now))).toEqual([
		"b-10",
		"b-30",
	]);
	expect(keys(selectForDeletion(objects, { count: 1, days: 7 }, now))).toEqual([
		"b-10",
		"b-30",
	]);
});

test("the newest object always survives", () => {
	const old = [40, 50, 60].map(daysAgo);
	expect(keys(selectForDeletion(old, { days: 7 }, now))).toEqual([
		"b-50",
		"b-60",
	]);
});

test("exactly at the cutoff is kept", () => {
	expect(selectForDeletion([daysAgo(0), daysAgo(7)], { days: 7 }, now)).toEqual(
		[],
	);
});
