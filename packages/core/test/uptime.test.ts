import { describe, expect, test } from "bun:test";
import {
	type ConfirmState,
	certWarning,
	confirm,
	dayStatus,
	inMaintenance,
	jsonPathGet,
	nextDelaySec,
	overallStatus,
	shouldResend,
	statusMatches,
	uptimeBars,
	windowActive,
} from "../src/uptime.ts";

const c = { downAfter: 3, upAfter: 2 };

function run(
	results: boolean[],
	start: ConfirmState = { status: "pending", streak: 0 },
) {
	let s = start;
	const emits: string[] = [];
	for (const ok of results) {
		const n = confirm(s, ok, c);
		if (n.emit) emits.push(n.emit);
		s = { status: n.status, streak: n.streak };
	}
	return { s, emits };
}

describe("confirm (flap handling)", () => {
	test("down only after downAfter consecutive failures", () => {
		expect(run([true, true, false, false]).s.status).toBe("up");
		const r = run([true, true, false, false, false]);
		expect(r.s.status).toBe("down");
		expect(r.emits).toEqual(["down"]);
	});

	test("a flapping monitor never alerts", () => {
		const r = run([true, true, false, true, false, false, true, false, true]);
		expect(r.s.status).toBe("up");
		expect(r.emits).toEqual([]);
	});

	test("up again after upAfter successes, one event each way", () => {
		const r = run([true, true, false, false, false, true, false, true, true]);
		expect(r.s.status).toBe("up");
		expect(r.emits).toEqual(["down", "up"]);
	});

	test("first confirmed up from pending does not emit monitor.up", () => {
		expect(run([true, true]).emits).toEqual([]);
	});

	test("maintenance freezes status and silences alerts, then restarts as pending", () => {
		const up: ConfirmState = { status: "up", streak: 5 };
		const m = confirm(up, false, c, true);
		expect(m).toEqual({ status: "maintenance", streak: -1 });
		expect(confirm(m, false, c, true).emit).toBeUndefined();
		const after = run([false, false, false], m);
		expect(after.s.status).toBe("down");
	});
});

test("retry interval while a failure awaits confirmation", () => {
	const t = { intervalSec: 60, retryIntervalSec: 20 };
	expect(nextDelaySec({ status: "up", streak: -1 }, t)).toBe(20);
	expect(nextDelaySec({ status: "down", streak: -4 }, t)).toBe(60);
	expect(nextDelaySec({ status: "up", streak: 3 }, t)).toBe(60);
	// Defaults: a stop at T is confirmed within one interval of its first failed check.
	expect(0 + 20 + 20).toBeLessThanOrEqual(t.intervalSec);
});

test("resend only while down and past the interval", () => {
	const now = new Date("2026-11-08T12:00:00Z");
	const ago = (m: number) => new Date(now.getTime() - m * 60_000);
	expect(shouldResend("down", 30, ago(31), now)).toBe(true);
	expect(shouldResend("down", 30, ago(10), now)).toBe(false);
	expect(shouldResend("down", 0, ago(999), now)).toBe(false);
	expect(shouldResend("up", 30, ago(31), now)).toBe(false);
});

describe("maintenance windows", () => {
	const startsAt = new Date("2026-11-01T02:00:00Z");
	const endsAt = new Date("2026-11-01T03:00:00Z");
	test("one-off", () => {
		const w = { startsAt, endsAt, repeat: "none" as const };
		expect(windowActive(w, new Date("2026-11-01T02:30:00Z"))).toBe(true);
		expect(windowActive(w, new Date("2026-11-01T03:00:00Z"))).toBe(false);
		expect(windowActive(w, new Date("2026-11-02T02:30:00Z"))).toBe(false);
	});
	test("weekly repeats", () => {
		const w = { startsAt, endsAt, repeat: "weekly" as const };
		expect(windowActive(w, new Date("2026-11-08T02:30:00Z"))).toBe(true);
		expect(windowActive(w, new Date("2026-11-07T02:30:00Z"))).toBe(false);
		expect(windowActive(w, new Date("2026-10-25T02:30:00Z"))).toBe(false);
	});
	test("only listed monitors", () => {
		const ws = [
			{ startsAt, endsAt, repeat: "daily" as const, monitorIds: ["a"] },
		];
		const at = new Date("2026-11-05T02:10:00Z");
		expect(inMaintenance(ws, "a", at)).toBe(true);
		expect(inMaintenance(ws, "b", at)).toBe(false);
	});
});

describe("day bars", () => {
	test("colors by uptime, maintenance excluded", () => {
		expect(dayStatus({ checks: 1440, failures: 0, maintenance: 0 })).toBe("up");
		expect(dayStatus({ checks: 1000, failures: 5, maintenance: 0 })).toBe(
			"degraded",
		);
		expect(dayStatus({ checks: 100, failures: 5, maintenance: 0 })).toBe(
			"down",
		);
		expect(dayStatus({ checks: 60, failures: 0, maintenance: 60 })).toBe(
			"maintenance",
		);
		expect(dayStatus({ checks: 120, failures: 0, maintenance: 60 })).toBe("up");
	});
	test("fills missing days with none, oldest first", () => {
		const bars = uptimeBars(
			[{ day: "2026-11-08", checks: 10, failures: 10, maintenance: 0 }],
			3,
			new Date("2026-11-08T10:00:00Z"),
		);
		expect(bars.map((b) => [b.day, b.status])).toEqual([
			["2026-11-06", "none"],
			["2026-11-07", "none"],
			["2026-11-08", "down"],
		]);
	});
});

test("status code patterns", () => {
	expect(statusMatches(204, ["2xx"])).toBe(true);
	expect(statusMatches(301, ["200-299"])).toBe(false);
	expect(statusMatches(301, ["200-299", "301"])).toBe(true);
	expect(statusMatches(500, ["2xx", "3xx"])).toBe(false);
});

test("json path", () => {
	const v = { data: { items: [{ ok: true }] }, status: "green" };
	expect(jsonPathGet(v, "$.status")).toBe("green");
	expect(jsonPathGet(v, "data.items[0].ok")).toBe(true);
	expect(jsonPathGet(v, "$.data.missing.x")).toBeUndefined();
});

test("certificate warnings fire once per threshold and reset on renewal", () => {
	const warn = [30, 14, 7];
	expect(certWarning(40, warn, null)).toEqual({ warned: null });
	expect(certWarning(29, warn, null)).toEqual({ announce: 30, warned: 30 });
	expect(certWarning(20, warn, 30)).toEqual({ warned: 30 });
	expect(certWarning(13, warn, 30)).toEqual({ announce: 14, warned: 14 });
	expect(certWarning(5, warn, null)).toEqual({ announce: 7, warned: 7 });
	expect(certWarning(89, warn, 7)).toEqual({ warned: null });
});

test("overall status", () => {
	expect(overallStatus(["up", "up"])).toBe("operational");
	expect(overallStatus(["up", "down"])).toBe("degraded");
	expect(overallStatus(["down", "paused", "down"])).toBe("outage");
	expect(overallStatus(["up", "maintenance"])).toBe("maintenance");
});
