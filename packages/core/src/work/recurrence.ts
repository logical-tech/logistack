import type { RecurrenceRule } from "@logistack/contracts";
import {
	addDays,
	addWorkingDays,
	daysBetween,
	isWorkingDay,
	startOfWeek,
	weekdayOf,
} from "./dates.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const daysInMonth = (y: number, m: number) =>
	new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number) => {
	const date = new Date(Date.UTC(y, m, 1));
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(d)}`;
};

/** Day `day` (−1 = last) of month `m` (0-based, may overflow) clamped to the month's length. */
function dayOfMonth(y: number, m: number, day: number): string {
	const first = new Date(Date.UTC(y, m, 1));
	const len = daysInMonth(first.getUTCFullYear(), first.getUTCMonth());
	return ymd(y, m, day === -1 ? len : Math.min(day, len));
}

function nthWeekday(y: number, m: number, n: number, weekday: number): string {
	const first = ymd(y, m, 1);
	const firstOcc = addDays(first, (weekday - weekdayOf(first) + 7) % 7);
	if (n > 0) return addDays(firstOcc, (n - 1) * 7);
	const last = dayOfMonth(y, m, -1);
	return addDays(last, -((weekdayOf(last) - weekday + 7) % 7));
}

function nextAnchor(rule: RecurrenceRule, anchor: string): string {
	const [y, mo, d] = anchor.split("-").map(Number) as [number, number, number];
	switch (rule.freq) {
		case "daily":
			return addDays(anchor, rule.interval);
		case "weekly": {
			const days = rule.byWeekday?.length ? rule.byWeekday : null;
			if (!days) return addDays(anchor, 7 * rule.interval);
			const week0 = startOfWeek(anchor);
			for (let i = 1; i <= 7 * rule.interval + 7; i++) {
				const c = addDays(anchor, i);
				const weeks = daysBetween(week0, startOfWeek(c)) / 7;
				if (weeks % rule.interval === 0 && days.includes(weekdayOf(c)))
					return c;
			}
			return addDays(anchor, 7 * rule.interval);
		}
		case "monthly": {
			const m = mo - 1 + rule.interval;
			const spec = rule.monthly;
			if (spec?.kind === "nthWeekday")
				return nthWeekday(y, m, spec.n, spec.weekday);
			return dayOfMonth(y, m, spec?.kind === "dayOfMonth" ? spec.day : d);
		}
		case "yearly":
			return dayOfMonth(y + rule.interval, mo - 1, d);
	}
}

/**
 * The next occurrence's dates, shifted from the previous *scheduled* dates (late completion doesn't drift
 * the series), keeping the start→due span. Null when the series has ended or there are no dates.
 */
export function nextOccurrence(
	rule: RecurrenceRule,
	prev: { startDate: string | null; dueDate: string | null },
): { startDate: string | null; dueDate: string | null } | null {
	const anchor = prev.dueDate ?? prev.startDate;
	if (!anchor) return null;
	if (rule.ends.kind === "after" && remainingOf(rule) <= 0) return null;
	let next = nextAnchor(rule, anchor);
	if (rule.skipWeekends && !isWorkingDay(next)) next = addWorkingDays(next, 1);
	if (rule.ends.kind === "on" && next > rule.ends.date) return null;
	if (!prev.dueDate) return { startDate: next, dueDate: null };
	const span = prev.startDate
		? daysBetween(prev.startDate, prev.dueDate)
		: null;
	return {
		startDate: span === null ? null : addDays(next, -span),
		dueDate: next,
	};
}

/** Occurrences still to create for `ends.kind = "after"` (the first counts as created). */
export const remainingOf = (rule: RecurrenceRule) =>
	rule.remaining ??
	(rule.ends.kind === "after" ? rule.ends.count - 1 : Number.POSITIVE_INFINITY);

/** The rule stored on the new occurrence: one fewer remaining. */
export function consumeOccurrence(rule: RecurrenceRule): RecurrenceRule {
	return rule.ends.kind === "after"
		? { ...rule, remaining: Math.max(0, remainingOf(rule) - 1) }
		: rule;
}

const ordinal = (n: number) => {
	const s = ["th", "st", "nd", "rd"];
	const v = n % 100;
	return n + (s[(v - 20) % 10] ?? s[v] ?? "th");
};

/** "Every 2 weeks on Mon, Wed, 5 times". English phrasing; weekday names follow `locale`. */
export function describeRule(rule: RecurrenceRule, locale = "en"): string {
	const dayName = (wd: number) =>
		new Intl.DateTimeFormat(locale, {
			weekday: "short",
			timeZone: "UTC",
		}).format(new Date(Date.UTC(2023, 0, 1 + wd)));
	const unit = {
		daily: "day",
		weekly: "week",
		monthly: "month",
		yearly: "year",
	}[rule.freq];
	let s =
		rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
	if (rule.freq === "weekly" && rule.byWeekday?.length) {
		const sorted = [...rule.byWeekday].sort(
			(a, b) => ((a + 6) % 7) - ((b + 6) % 7),
		);
		s =
			rule.interval === 1 && sorted.join() === "1,2,3,4,5"
				? "Every weekday"
				: `${s} on ${sorted.map(dayName).join(", ")}`;
	}
	const m = rule.monthly;
	if (rule.freq === "monthly" && m) {
		if (m.kind === "dayOfMonth")
			s += m.day === -1 ? " on the last day" : ` on the ${ordinal(m.day)}`;
		else
			s += ` on the ${m.n === -1 ? "last" : ordinal(m.n)} ${new Intl.DateTimeFormat(
				locale,
				{ weekday: "long", timeZone: "UTC" },
			).format(new Date(Date.UTC(2023, 0, 1 + m.weekday)))}`;
	}
	if (rule.ends.kind === "on") s += `, until ${rule.ends.date}`;
	if (rule.ends.kind === "after") s += `, ${rule.ends.count} times`;
	return s;
}
