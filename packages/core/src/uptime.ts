import type {
	DayStatus,
	MaintenanceRepeat,
	MonitorStatus,
	UptimeDay,
} from "@logistack/contracts";

// Pure uptime logic: confirmation (flap handling), scheduling, maintenance, day bars and the
// HTTP assertions. Design: docs/plans/uptime-status.md.

export type Confirmation = { downAfter: number; upAfter: number };

export type ConfirmState = { status: MonitorStatus; streak: number };

/**
 * Folds one check result into the confirmed status. `streak` counts consecutive equal results
 * (negative for failures); the status flips only once it reaches `downAfter` / `upAfter`. During
 * maintenance results are recorded but never move the status nor alert.
 */
export function confirm(
	prev: ConfirmState,
	ok: boolean,
	c: Confirmation,
	maintenance = false,
): ConfirmState & { emit?: "down" | "up" } {
	const streak = ok
		? prev.streak > 0
			? prev.streak + 1
			: 1
		: prev.streak < 0
			? prev.streak - 1
			: -1;
	if (maintenance) return { status: "maintenance", streak };
	// Leaving maintenance or pause: start over as pending, as if freshly created.
	const base: MonitorStatus =
		prev.status === "maintenance" || prev.status === "paused"
			? "pending"
			: prev.status;
	if (!ok && -streak >= c.downAfter && base !== "down")
		return { status: "down", streak, emit: "down" };
	if (ok && streak >= c.upAfter && base !== "up")
		return { status: "up", streak, ...(base === "down" && { emit: "up" }) };
	return { status: base, streak };
}

/** Seconds until the next check: the retry interval while a failure awaits confirmation. */
export function nextDelaySec(
	s: ConfirmState,
	t: { intervalSec: number; retryIntervalSec: number },
): number {
	const confirming = s.streak < 0 && s.status !== "down";
	return confirming
		? Math.min(t.retryIntervalSec, t.intervalSec)
		: t.intervalSec;
}

/** Whether a still-down monitor should repeat its `monitor.down`. */
export function shouldResend(
	status: MonitorStatus,
	resendMinutes: number,
	lastNotifiedAt: Date | null,
	now: Date,
): boolean {
	if (status !== "down" || resendMinutes <= 0 || !lastNotifiedAt) return false;
	return now.getTime() - lastNotifiedAt.getTime() >= resendMinutes * 60_000;
}

export type Window = {
	monitorIds: readonly string[];
	startsAt: Date;
	endsAt: Date;
	repeat: MaintenanceRepeat;
};

const PERIOD_MS = { daily: 86_400_000, weekly: 7 * 86_400_000 } as const;

/** True while `now` falls in the window or in one of its repeats. */
export function windowActive(
	w: Omit<Window, "monitorIds">,
	now: Date,
): boolean {
	const t = now.getTime();
	const start = w.startsAt.getTime();
	const span = w.endsAt.getTime() - start;
	if (span <= 0 || t < start) return false;
	if (w.repeat === "none") return t < start + span;
	const period = PERIOD_MS[w.repeat];
	return (t - start) % period < Math.min(span, period);
}

export function inMaintenance(
	windows: readonly Window[],
	monitorId: string,
	now: Date,
): boolean {
	return windows.some(
		(w) => w.monitorIds.includes(monitorId) && windowActive(w, now),
	);
}

export type DailyRow = {
	day: string;
	checks: number;
	failures: number;
	maintenance: number;
};

/** Percent of non-maintenance checks that passed; null when there were none. */
export function uptimePercent(r: Omit<DailyRow, "day">): number | null {
	const counted = r.checks - r.maintenance;
	if (counted <= 0) return null;
	return (100 * (counted - r.failures)) / counted;
}

export function dayStatus(r: Omit<DailyRow, "day">): DayStatus {
	const up = uptimePercent(r);
	if (up === null) return r.maintenance > 0 ? "maintenance" : "none";
	if (up >= 99.9) return "up";
	if (up >= 99) return "degraded";
	return "down";
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** `days` bars ending today (UTC), oldest first; days without rows are `none`. */
export function uptimeBars(
	rows: readonly DailyRow[],
	days: number,
	now: Date,
): UptimeDay[] {
	const byDay = new Map(rows.map((r) => [r.day, r]));
	const out: UptimeDay[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const day = isoDay(new Date(now.getTime() - i * 86_400_000));
		const r = byDay.get(day);
		out.push(
			r
				? { day, uptime: uptimePercent(r), status: dayStatus(r) }
				: { day, uptime: null, status: "none" },
		);
	}
	return out;
}

/** Uptime over several rollup rows (a window), maintenance excluded. */
export function totalUptime(rows: readonly Omit<DailyRow, "day">[]) {
	return uptimePercent(
		rows.reduce(
			(a, r) => ({
				checks: a.checks + r.checks,
				failures: a.failures + r.failures,
				maintenance: a.maintenance + r.maintenance,
			}),
			{ checks: 0, failures: 0, maintenance: 0 },
		),
	);
}

/** `200`, `200-299` or `2xx`. */
export function statusMatches(code: number, patterns: readonly string[]) {
	return patterns.some((p) => {
		if (/^[1-5]xx$/.test(p)) return Math.floor(code / 100) === Number(p[0]);
		const [lo, hi = lo] = p.split("-").map(Number);
		return code >= (lo as number) && code <= (hi as number);
	});
}

/** Reads `$.a.b[0].c` (the `$.` is optional); undefined when any step is missing. */
export function jsonPathGet(value: unknown, path: string): unknown {
	const steps = path
		.replace(/^\$\.?/, "")
		.split(/\.|\[(\d+)\]/)
		.filter((s) => s !== undefined && s !== "");
	let cur: unknown = value;
	for (const step of steps) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[step];
	}
	return cur;
}

/** Text form used to compare a JSON value with the expected string. */
export const jsonText = (v: unknown) =>
	typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);

/**
 * The threshold to announce now, if any: the smallest `warnDays` at or above `daysLeft` that is
 * below the last one announced. A renewed certificate (more days than any threshold) resets.
 */
export function certWarning(
	daysLeft: number,
	warnDays: readonly number[],
	warned: number | null,
): { announce?: number; warned: number | null } {
	const crossed = warnDays.filter((d) => daysLeft <= d);
	if (crossed.length === 0) return { warned: null };
	const smallest = Math.min(...crossed);
	if (warned !== null && smallest >= warned) return { warned };
	return { announce: smallest, warned: smallest };
}

/** Overall status of a set of monitor statuses, for a status page header. */
export function overallStatus(
	statuses: readonly MonitorStatus[],
): "operational" | "degraded" | "outage" | "maintenance" {
	const live = statuses.filter((s) => s !== "paused");
	const down = live.filter((s) => s === "down").length;
	if (down > 0) return down === live.length ? "outage" : "degraded";
	if (live.some((s) => s === "maintenance")) return "maintenance";
	return "operational";
}
