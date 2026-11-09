import { addDays, localDate, startOfWeek, weekdayOf } from "./dates.ts";

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];
const MONTHS = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];

const weekdayIndex = (w: string) =>
	w.length >= 2 ? WEEKDAYS.findIndex((d) => d.startsWith(w)) : -1;
const monthIndex = (w: string) =>
	w.length >= 3 ? MONTHS.findIndex((m) => w.startsWith(m)) : -1;

function validDate(y: number, m: number, d: number): string | null {
	const date = new Date(Date.UTC(y, m, d));
	if (date.getUTCMonth() !== m || date.getUTCDate() !== d) return null;
	return date.toISOString().slice(0, 10);
}

function addMonths(date: string, n: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const len = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
	return new Date(Date.UTC(y, m - 1 + n, Math.min(d, len)))
		.toISOString()
		.slice(0, 10);
}

/**
 * Natural date input for pickers: "today", "tomorrow", "yesterday", "fri" (the coming Friday),
 * "next fri" (Friday of next week), "next week" / "next month" (their first day), "in 3 days",
 * "in 2 weeks", "in 1 month", "2026-12-03", "dec 3", "3 december" (next such date from today).
 */
export function parseHumanDate(
	input: string,
	now: Date,
	tz = "UTC",
): { date: string } | null {
	const s = input
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.,]$/, "");
	const today = localDate(now, tz);
	const ok = (date: string | null) => (date ? { date } : null);
	if (!s) return null;
	if (s === "today" || s === "tod") return ok(today);
	if (s === "tomorrow" || s === "tmr" || s === "tom")
		return ok(addDays(today, 1));
	if (s === "yesterday") return ok(addDays(today, -1));
	if (s === "next week") return ok(addDays(startOfWeek(today), 7));
	if (s === "next month")
		return ok(`${addMonths(`${today.slice(0, 8)}01`, 1)}`);
	let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (m) return ok(validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	m = s.match(/^in (\d{1,3}) (day|days|d|week|weeks|w|month|months)$/);
	if (m) {
		const n = Number(m[1]);
		const unit = m[2] as string;
		if (unit.startsWith("d")) return ok(addDays(today, n));
		if (unit.startsWith("w")) return ok(addDays(today, 7 * n));
		return ok(addMonths(today, n));
	}
	m = s.match(/^(next |this )?([a-z]+)$/);
	if (m) {
		const wd = weekdayIndex(m[2] as string);
		if (wd >= 0) {
			if (m[1] === "next ")
				return ok(addDays(addDays(startOfWeek(today), 7), (wd + 6) % 7));
			return ok(addDays(today, (wd - weekdayOf(today) + 7) % 7 || 7));
		}
	}
	m = s.match(/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/) ?? null;
	let month = -1;
	let day = 0;
	let year: number | null = null;
	if (m) {
		month = monthIndex(m[1] as string);
		day = Number(m[2]);
		year = m[3] ? Number(m[3]) : null;
	} else {
		m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/);
		if (m) {
			month = monthIndex(m[2] as string);
			day = Number(m[1]);
			year = m[3] ? Number(m[3]) : null;
		}
	}
	if (month < 0) return null;
	const thisYear = Number(today.slice(0, 4));
	if (year !== null) return ok(validDate(year, month, day));
	const candidate = validDate(thisYear, month, day);
	if (candidate && candidate >= today) return ok(candidate);
	return ok(validDate(thisYear + 1, month, day));
}
