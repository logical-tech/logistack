import { addDays, daysBetween } from "./dates.ts";

export type TimelineZoom = "day" | "week" | "month" | "quarter";

const SCALES: Record<TimelineZoom, { pxPerDay: number; tick: TimelineZoom }> = {
	day: { pxPerDay: 40, tick: "day" },
	week: { pxPerDay: 16, tick: "week" },
	month: { pxPerDay: 5, tick: "month" },
	quarter: { pxPerDay: 2, tick: "quarter" },
};

/** Pixels per day and the header tick unit for a zoom level. */
export const scaleFor = (zoom: TimelineZoom) => SCALES[zoom];

/** Left edge of `date`'s column, `origin` at x = 0. */
export const dateToX = (date: string, origin: string, pxPerDay: number) =>
	daysBetween(origin, date) * pxPerDay;

/** The day under `x`, snapped to the nearest day boundary. */
export const xToDate = (x: number, origin: string, pxPerDay: number) =>
	addDays(origin, Math.round(x / pxPerDay));

/** Dates to render for a scroll window, padded by `overscan` screens on each side. */
export function visibleRange(
	scrollLeft: number,
	width: number,
	origin: string,
	pxPerDay: number,
	overscan = 1,
): { from: string; to: string } {
	const pad = width * overscan;
	return {
		from: addDays(origin, Math.floor((scrollLeft - pad) / pxPerDay)),
		to: addDays(origin, Math.ceil((scrollLeft + width + pad) / pxPerDay)),
	};
}

export type BarGeometry = {
	x: number;
	width: number;
	kind: "bar" | "milestone" | "due_only" | "start_only";
};

/**
 * Where a task's bar sits: start to due inclusive; a milestone is one day wide at its due date
 * (drawn as a diamond); a due-only task is one day ending on the due date (dashed start).
 * Null without dates.
 */
export function barGeometry(
	task: {
		startDate: string | null;
		dueDate: string | null;
		isMilestone?: boolean;
	},
	origin: string,
	pxPerDay: number,
): BarGeometry | null {
	const { startDate: s, dueDate: d } = task;
	if (task.isMilestone && (d ?? s)) {
		return {
			x: dateToX((d ?? s) as string, origin, pxPerDay),
			width: pxPerDay,
			kind: "milestone",
		};
	}
	if (s && d) {
		const [a, b] = s <= d ? [s, d] : [d, s];
		return {
			x: dateToX(a, origin, pxPerDay),
			width: (daysBetween(a, b) + 1) * pxPerDay,
			kind: "bar",
		};
	}
	if (d)
		return {
			x: dateToX(d, origin, pxPerDay),
			width: pxPerDay,
			kind: "due_only",
		};
	if (s)
		return {
			x: dateToX(s, origin, pxPerDay),
			width: pxPerDay,
			kind: "start_only",
		};
	return null;
}
