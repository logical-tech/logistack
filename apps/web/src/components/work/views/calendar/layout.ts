/** Calendar geometry: the month grid and how multi-day items stack into lanes per week. */
import { addDays, daysBetween, startOfWeek } from "@logistack/core/work";

export type CalItem = { id: string; start: string; end: string };

export type Segment<T extends CalItem> = {
	item: T;
	/** 0 = Monday. */
	col: number;
	span: number;
	lane: number;
	/** The item started before this week (draw a flat left end). */
	clippedStart: boolean;
	clippedEnd: boolean;
};

/** 42 days, Monday first, covering the month of `date`. */
export function monthGrid(date: string): string[] {
	const first = `${date.slice(0, 7)}-01`;
	const start = startOfWeek(first);
	return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/**
 * The week's slice of every item that overlaps it, each in the first lane free across its
 * days. Earlier starts go first, and among those the longer one, so long spans stay on top.
 */
export function layoutWeek<T extends CalItem>(
	items: readonly T[],
	weekStart: string,
): Segment<T>[] {
	const weekEnd = addDays(weekStart, 6);
	const overlapping = items
		.filter((i) => i.start <= weekEnd && i.end >= weekStart)
		.sort(
			(a, b) =>
				a.start.localeCompare(b.start) ||
				daysBetween(b.start, b.end) - daysBetween(a.start, a.end) ||
				a.id.localeCompare(b.id),
		);
	const laneEnds: number[] = [];
	return overlapping.map((item) => {
		const from = item.start < weekStart ? weekStart : item.start;
		// biome-ignore lint/complexity/useMathMinMax: ISO date strings, not numbers
		const to = item.end > weekEnd ? weekEnd : item.end;
		const col = daysBetween(weekStart, from);
		const last = daysBetween(weekStart, to);
		let lane = laneEnds.findIndex((end) => end < col);
		if (lane < 0) lane = laneEnds.length;
		laneEnds[lane] = last;
		return {
			item,
			col,
			span: last - col + 1,
			lane,
			clippedStart: item.start < weekStart,
			clippedEnd: item.end > weekEnd,
		};
	});
}

/** Per day of the week (0–6), how many segments sit in lanes at or past `maxLanes`. */
export function hiddenPerDay<T extends CalItem>(
	segments: readonly Segment<T>[],
	maxLanes: number,
): number[] {
	const out = [0, 0, 0, 0, 0, 0, 0];
	for (const s of segments)
		if (s.lane >= maxLanes)
			for (let c = s.col; c < s.col + s.span; c++) out[c] = (out[c] ?? 0) + 1;
	return out;
}

/** Items on `date`, for the "+N more" list. */
export const itemsOn = <T extends CalItem>(items: readonly T[], date: string) =>
	items.filter((i) => i.start <= date && i.end >= date);
