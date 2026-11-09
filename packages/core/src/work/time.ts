import type { WorkTimeGroup } from "@logistack/contracts";
import { addDays, localDate, startOfWeek, zonedMidnight } from "./dates.ts";

export type TimeEntryLike = {
	id: string;
	userId: string;
	projectId: string;
	taskId: string;
	startedAt: Date | string;
	/** Null: the timer is running (counted up to `now`). */
	endedAt: Date | string | null;
	billable: boolean;
};

export type TimeRollupRow = {
	key: string;
	seconds: number;
	billableSeconds: number;
	entries: number;
};

const ms = (d: Date | string) => new Date(d).getTime();

/**
 * Sum entries per group within `[from, to]` (local dates in `tz`). Entries crossing local midnight
 * are split by day; running timers count up to `now`.
 */
export function rollupTime(
	entries: readonly TimeEntryLike[],
	groupBy: WorkTimeGroup,
	range: { from: string; to: string },
	tz: string,
	now: Date,
): { rows: TimeRollupRow[]; totals: Omit<TimeRollupRow, "key"> } {
	const lo = zonedMidnight(range.from, tz).getTime();
	const hi = zonedMidnight(addDays(range.to, 1), tz).getTime();
	const rows = new Map<string, TimeRollupRow & { ids: Set<string> }>();
	const add = (key: string, e: TimeEntryLike, sec: number) => {
		const row = rows.get(key) ?? {
			key,
			seconds: 0,
			billableSeconds: 0,
			entries: 0,
			ids: new Set<string>(),
		};
		row.seconds += sec;
		if (e.billable) row.billableSeconds += sec;
		row.ids.add(e.id);
		row.entries = row.ids.size;
		rows.set(key, row);
	};
	for (const e of entries) {
		let a = Math.max(ms(e.startedAt), lo);
		const b = Math.min(e.endedAt === null ? now.getTime() : ms(e.endedAt), hi);
		while (a < b) {
			const day = localDate(new Date(a), tz);
			const end = Math.min(b, zonedMidnight(addDays(day, 1), tz).getTime());
			const sec = Math.round((end - a) / 1000);
			const key =
				groupBy === "project"
					? e.projectId
					: groupBy === "user"
						? e.userId
						: groupBy === "task"
							? e.taskId
							: groupBy === "day"
								? day
								: startOfWeek(day);
			if (sec > 0) add(key, e, sec);
			a = end;
		}
	}
	const list = [...rows.values()]
		.map(({ ids: _, ...r }) => r)
		.sort((x, y) =>
			groupBy === "day" || groupBy === "week"
				? x.key.localeCompare(y.key)
				: y.seconds - x.seconds,
		);
	const ids = new Set([...rows.values()].flatMap((r) => [...r.ids]));
	return {
		rows: list,
		totals: {
			seconds: list.reduce((s, r) => s + r.seconds, 0),
			billableSeconds: list.reduce((s, r) => s + r.billableSeconds, 0),
			entries: ids.size,
		},
	};
}

/** First entry of the same user that overlaps `candidate` (running entries are open-ended up to `now`). */
export function overlaps(
	entries: readonly TimeEntryLike[],
	candidate: Pick<TimeEntryLike, "id" | "userId" | "startedAt" | "endedAt">,
	now: Date,
): TimeEntryLike | null {
	const end = (e: { endedAt: Date | string | null }) =>
		e.endedAt === null ? now.getTime() : ms(e.endedAt);
	const a = ms(candidate.startedAt);
	const b = end(candidate);
	return (
		entries.find(
			(e) =>
				e.id !== candidate.id &&
				e.userId === candidate.userId &&
				ms(e.startedAt) < b &&
				a < end(e),
		) ?? null
	);
}

/** `1h 30m`, `45m`, `0m`; seconds are dropped. */
export function formatDuration(seconds: number): string {
	const m = Math.floor(Math.max(0, seconds) / 60);
	const h = Math.floor(m / 60);
	if (!h) return `${m}m`;
	return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Seconds from `1h30`, `1h 30m`, `90m`, `1.5h`, `1:30`, or a bare number of minutes; null if unparsable. */
export function parseDuration(input: string): number | null {
	const s = input.trim().toLowerCase().replace(",", ".");
	let m = s.match(/^(\d+):([0-5]\d)$/);
	if (m) return (Number(m[1]) * 60 + Number(m[2])) * 60;
	m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m?)?$/);
	if (m && (m[1] || m[2])) {
		const sec = Math.round((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60);
		return sec > 0 ? sec : null;
	}
	return null;
}
