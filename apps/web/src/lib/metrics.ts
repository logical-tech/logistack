import type { MetricRange } from "@logistack/contracts";

/** One x position of a chart: epoch ms plus one value per series key. `null` breaks the line. */
export type ChartRow = { t: number } & { [series: string]: number | null };

export type SeriesInput<P> = { key: string; points: P[] };

/**
 * Merges series into rows keyed by bucket time. Where two consecutive buckets are more
 * than 1.5 steps apart (the agent was silent), a row of nulls is inserted so the line
 * breaks instead of drawing a straight bridge over the outage.
 */
export function toRows<P extends { t: number }>(
	series: SeriesInput<P>[],
	value: (p: P, key: string) => number | null,
	stepSec: number,
): ChartRow[] {
	const byT = new Map<number, ChartRow>();
	for (const s of series) {
		for (const p of s.points) {
			let row = byT.get(p.t);
			if (!row) {
				row = { t: p.t } as ChartRow;
				byT.set(p.t, row);
			}
			row[s.key] = value(p, s.key);
		}
	}
	const keys = series.map((s) => s.key);
	const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
	const stepMs = stepSec * 1000;
	const rows: ChartRow[] = [];
	for (const row of sorted) {
		for (const k of keys) row[k] ??= null;
		const prev = rows.at(-1);
		if (prev && row.t - prev.t > stepMs * 1.5) {
			const gap = { t: prev.t + stepMs } as ChartRow;
			for (const k of keys) gap[k] = null;
			rows.push(gap);
		}
		rows.push(row);
	}
	return rows;
}

/** used / total as 0..100, or null when either side is unknown. */
export function pct(used: number | null, total: number | null): number | null {
	if (used === null || total === null || total <= 0) return null;
	return (used / total) * 100;
}

/** Sum of two rates; null only when both are unknown. */
export function sum(a: number | null, b: number | null): number | null {
	return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

export type SeriesStats = {
	latest: number | null;
	avg: number | null;
	max: number | null;
};

/** Latest, mean and peak of one series key, ignoring gaps. */
export function stats(rows: ChartRow[], key: string): SeriesStats {
	let total = 0;
	let n = 0;
	let max: number | null = null;
	let latest: number | null = null;
	for (const r of rows) {
		const v = r[key];
		if (v === null || v === undefined) continue;
		total += v;
		n += 1;
		max = max === null ? v : Math.max(max, v);
		latest = v;
	}
	return { latest, avg: n ? total / n : null, max };
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** 1536 -> "1.50 KiB" ("1.5 KiB" compact, for axes). Binary units, as memory and disks report. */
export function formatBytes(
	n: number | null | undefined,
	compact = false,
): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "–";
	let v = Math.abs(n);
	let u = 0;
	while (v >= 1024 && u < UNITS.length - 1) {
		v /= 1024;
		u += 1;
	}
	const digits =
		u === 0 || v >= 100 || (compact && v >= 10)
			? 0
			: v >= 10 || compact
				? 1
				: 2;
	return `${n < 0 ? "-" : ""}${v.toFixed(digits)} ${UNITS[u]}`;
}

export const formatRate = (n: number | null | undefined, compact = false) =>
	n === null || n === undefined ? "–" : `${formatBytes(n, compact)}/s`;

/** 0..100 -> "38%", "4.2%", "0.3%". */
export function formatPct(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "–";
	if (n !== 0 && Math.abs(n) < 10) return `${n.toFixed(1)}%`;
	return `${Math.round(n)}%`;
}

const time = new Intl.DateTimeFormat("en", {
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const full = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

/** Axis label for a bucket: clock time inside a day, the date beyond it. */
export const tickLabel = (range: MetricRange) => (t: number) =>
	range === "7d" || range === "30d" ? day.format(t) : time.format(t);

export const tooltipLabel = (t: number) => full.format(t);

const TICK_EVERY: Record<MetricRange, number> = {
	"1h": 15 * 60_000,
	"6h": 3_600_000,
	"24h": 4 * 3_600_000,
	"7d": 86_400_000,
	"30d": 5 * 86_400_000,
};

/** Round-time x ticks inside the window, aligned to the local clock. */
export function timeTicks(
	range: MetricRange,
	from: number,
	to: number,
): number[] {
	const every = TICK_EVERY[range];
	const offset = new Date(from).getTimezoneOffset() * 60_000;
	const ticks: number[] = [];
	const first = Math.ceil((from - offset) / every) * every + offset;
	for (let t = first; t <= to; t += every) ticks.push(t);
	return ticks;
}

const compact = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});
/** 12345 -> "12.3K". */
export const formatCount = (n: number | null | undefined) =>
	n === null || n === undefined ? "–" : compact.format(n);
/** Milliseconds: "4.2 ms", "212 ms", "1.8 s". */
export const formatMs = (n: number | null | undefined) =>
	n === null || n === undefined
		? "–"
		: n >= 1000
			? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s`
			: `${n >= 100 ? Math.round(n) : n.toFixed(1)} ms`;
