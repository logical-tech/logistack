import { expect, test } from "bun:test";
import { cronError, describeCron, nextRuns } from "./cron";

test("common shapes read as words", () => {
	expect(describeCron("0 3 * * *")).toBe("Every day at 03:00");
	expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
	expect(describeCron("0 * * * *")).toBe("Every hour");
	expect(describeCron("30 */6 * * *")).toBe("Every 6 hours at :30");
	expect(describeCron("30 9 * * 1-5")).toBe("Weekdays at 09:30");
	expect(describeCron("0 5 * * 0")).toBe("Every Sunday at 05:00");
	expect(describeCron("0 2,14 * * *")).toBe("Every day at 02:00 and 14:00");
	expect(describeCron("0 4 * * 1,4")).toBe("Mondays and Thursdays at 04:00");
	expect(describeCron("15 1 1 * *")).toBe("Monthly on the 1st at 01:15");
	expect(describeCron("0 0 22 * *")).toBe("Monthly on the 22nd at 00:00");
	expect(describeCron("0 0 11 * *")).toBe("Monthly on the 11th at 00:00");
});

test("anything unusual stays unworded instead of guessed", () => {
	expect(describeCron("0 3 * 1 *")).toBeNull();
	expect(describeCron("5-10 3 * * *")).toBeNull();
	expect(describeCron("0 3 1 * 1")).toBeNull();
});

test("only five-field expressions are valid", () => {
	expect(cronError("0 3 * * *")).toBeNull();
	expect(cronError("0 0 3 * * *")).not.toBeNull();
	expect(cronError("0 3 * *")).not.toBeNull();
	expect(cronError("61 3 * * *")).not.toBeNull();
	expect(nextRuns("nope", "UTC")).toEqual([]);
});

test("next runs follow the time zone", () => {
	const from = new Date("2026-11-03T12:00:00Z");
	expect(nextRuns("0 3 * * *", "Europe/Rome", 2, from)).toEqual([
		"2026-11-04T02:00:00.000Z",
		"2026-11-05T02:00:00.000Z",
	]);
	expect(nextRuns("0 3 * * *", "UTC", 1, from)).toEqual([
		"2026-11-04T03:00:00.000Z",
	]);
});
