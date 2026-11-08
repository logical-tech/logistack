import type { DueBucket } from "@logistack/contracts";

/** Date-only maths on `YYYY-MM-DD` strings, in UTC so DST never shifts a day. */

const DAY_MS = 86_400_000;
/** Mon–Fri. Bitmask Mon=1 … Sun=64. */
export const DEFAULT_WORKING_DAYS = 31;

const toMs = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, days: number) =>
	fromMs(toMs(date) + days * DAY_MS);

/** Calendar days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: string, b: string) =>
	Math.round((toMs(b) - toMs(a)) / DAY_MS);

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string) => new Date(toMs(date)).getUTCDay();

/** Monday of the ISO week containing `date`. */
export const startOfWeek = (date: string) =>
	addDays(date, -((weekdayOf(date) + 6) % 7));

export const isWorkingDay = (
	date: string,
	workingDays = DEFAULT_WORKING_DAYS,
) => (workingDays & (1 << ((weekdayOf(date) + 6) % 7))) !== 0;

/** `n` working days after `date` (before it when negative). `n = 0` returns `date` unchanged. */
export function addWorkingDays(
	date: string,
	n: number,
	workingDays = DEFAULT_WORKING_DAYS,
): string {
	if ((workingDays & 127) === 0) throw new Error("no working days");
	const step = n < 0 ? -1 : 1;
	let left = Math.abs(n);
	let d = date;
	while (left > 0) {
		d = addDays(d, step);
		if (isWorkingDay(d, workingDays)) left--;
	}
	return d;
}

/** Working days in (a, b]; negative when `b` is before `a`. `addWorkingDays(a, result)` lands on `b` when `b` is a working day. */
export function workingDaysBetween(
	a: string,
	b: string,
	workingDays = DEFAULT_WORKING_DAYS,
): number {
	const span = daysBetween(a, b);
	// Forwards count (a, b]; backwards count [b, a), mirroring `addWorkingDays`.
	const [from, sign] = span >= 0 ? [a, 1] : [b, -1];
	let count = 0;
	for (let i = span >= 0 ? 1 : 0; i < Math.abs(span) + (span >= 0 ? 1 : 0); i++)
		if (isWorkingDay(addDays(from, i), workingDays)) count++;
	return sign * count;
}

/** The calendar date of `instant` in time zone `tz`. */
export function localDate(instant: Date | string, tz = "UTC"): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(typeof instant === "string" ? new Date(instant) : instant);
}

/** Minutes `tz` is ahead of UTC at `instant`. */
function tzOffsetMinutes(instant: number, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(instant);
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
	const asUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The UTC instant of local midnight starting `date` in `tz`. */
export function zonedMidnight(date: string, tz = "UTC"): Date {
	const guess = toMs(date);
	let ms = guess - tzOffsetMinutes(guess, tz) * 60_000;
	ms = guess - tzOffsetMinutes(ms, tz) * 60_000;
	return new Date(ms);
}

/** Which My-tasks bucket a due date falls in, seen from `now` in `tz` (weeks start on Monday). */
export function dueBucket(
	due: string | null | undefined,
	now: Date,
	tz = "UTC",
): DueBucket {
	if (!due) return "none";
	const today = localDate(now, tz);
	const diff = daysBetween(today, due);
	if (diff < 0) return "overdue";
	if (diff === 0) return "today";
	if (diff === 1) return "tomorrow";
	const weeks = daysBetween(startOfWeek(today), startOfWeek(due)) / 7;
	if (weeks === 0) return "this_week";
	if (weeks === 1) return "next_week";
	return "later";
}
