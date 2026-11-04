import { CronExpressionParser } from "cron-parser";

/** Five fields only (minute hour day month weekday), the form the server accepts. */
export function cronError(expr: string): string | null {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5 || !fields[0])
		return "Use five fields: minute hour day month weekday.";
	try {
		CronExpressionParser.parse(expr.trim());
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : "Not a valid cron expression.";
	}
}

/** The next `count` fire times as ISO strings, or [] when the expression is invalid. */
export function nextRuns(
	expr: string,
	timezone: string,
	count = 5,
	from = new Date(),
): string[] {
	if (cronError(expr)) return [];
	try {
		const it = CronExpressionParser.parse(expr.trim(), {
			tz: timezone,
			currentDate: from,
		});
		return Array.from({ length: count }, () =>
			it.next().toDate().toISOString(),
		);
	} catch {
		return [];
	}
}

const DAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
const pad = (n: number) => String(n).padStart(2, "0");

function ordinal(n: number) {
	if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
	return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function list(items: string[]) {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "03:00", or "02:00 and 14:00" for an hour list; null when the hour field is not a plain list. */
function clock(minute: number, hourField: string) {
	const hours = hourField.split(",").map(num);
	if (hours.some((h) => h === null)) return null;
	return list(hours.map((h) => `${pad(h as number)}:${pad(minute)}`));
}

/**
 * The common shapes in words ("Every day at 03:00", "Weekdays at 09:30"). Null for anything
 * else, so callers fall back to showing the expression itself rather than a wrong sentence.
 */
export function describeCron(expr: string): string | null {
	if (cronError(expr)) return null;
	const [m = "", h = "", dom = "", mon = "", dow = ""] = expr
		.trim()
		.split(/\s+/);
	if (mon !== "*") return null;
	const minute = num(m);

	if (dom === "*" && dow === "*") {
		if (m === "*" && h === "*") return "Every minute";
		const everyMin = /^\*\/(\d+)$/.exec(m);
		if (everyMin && h === "*") return `Every ${everyMin[1]} minutes`;
		if (minute === null) return null;
		if (h === "*")
			return minute === 0 ? "Every hour" : `Every hour at :${pad(minute)}`;
		const everyHour = /^\*\/(\d+)$/.exec(h);
		if (everyHour)
			return `Every ${everyHour[1]} hours${minute ? ` at :${pad(minute)}` : ""}`;
		const at = clock(minute, h);
		return at ? `Every day at ${at}` : null;
	}

	if (minute === null) return null;
	const at = clock(minute, h);
	if (!at) return null;

	if (dom === "*") {
		if (dow === "1-5") return `Weekdays at ${at}`;
		if (dow === "0,6" || dow === "6,0") return `Weekends at ${at}`;
		const days = dow.split(",").map(num);
		if (days.some((d) => d === null || d > 7)) return null;
		const names = days.map((d) => DAYS[(d as number) % 7] as string);
		return names.length === 1
			? `Every ${names[0]} at ${at}`
			: `${list(names.map((n) => `${n}s`))} at ${at}`;
	}

	if (dow !== "*") return null;
	const day = num(dom);
	if (day === null) return null;
	return `Monthly on the ${ordinal(day)} at ${at}`;
}

/** The shapes the visual builder edits; anything else stays a raw expression. */
export type SimpleCron =
	| { every: "minutes"; step: number }
	| { every: "hours"; step: number; minute: number }
	| { every: "day"; hour: number; minute: number }
	| { every: "week"; days: number[]; hour: number; minute: number }
	| { every: "month"; day: number; hour: number; minute: number };

export type CronEvery = SimpleCron["every"];

const step = (n: number) => (n === 1 ? "*" : `*/${n}`);

export function toCron(s: SimpleCron): string {
	switch (s.every) {
		case "minutes":
			return `${step(s.step)} * * * *`;
		case "hours":
			return `${s.minute} ${step(s.step)} * * *`;
		case "day":
			return `${s.minute} ${s.hour} * * *`;
		case "week": {
			const days = [...new Set(s.days)].sort((a, b) => a - b).join(",");
			return `${s.minute} ${s.hour} * * ${days === "1,2,3,4,5" ? "1-5" : days || "*"}`;
		}
		case "month":
			return `${s.minute} ${s.hour} ${s.day} * *`;
	}
}

/** "*" → 1, "*\/N" → N, anything else null. */
function stepOf(field: string) {
	if (field === "*") return 1;
	const m = /^\*\/(\d+)$/.exec(field);
	return m ? Number(m[1]) : null;
}

/** "1-5", "0,6", "1,3-4" → day numbers 0-6 (7 counts as Sunday); null for steps or names. */
function weekdays(field: string): number[] | null {
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const range = /^(\d)(?:-(\d))?$/.exec(part);
		if (!range) return null;
		const from = Number(range[1]);
		const to = range[2] === undefined ? from : Number(range[2]);
		if (from > 7 || to > 7 || to < from) return null;
		for (let d = from; d <= to; d++) out.add(d % 7);
	}
	return [...out].sort((a, b) => a - b);
}

/** The builder form of an expression, or null when it needs the raw editor. */
export function fromCron(expr: string): SimpleCron | null {
	if (cronError(expr)) return null;
	const [m = "", h = "", dom = "", mon = "", dow = ""] = expr
		.trim()
		.split(/\s+/);
	if (mon !== "*") return null;
	const minute = num(m);
	const daily = dom === "*" && dow === "*";

	if (daily && h === "*" && minute === null) {
		const n = stepOf(m);
		return n ? { every: "minutes", step: n } : null;
	}
	if (minute === null) return null;
	if (daily && stepOf(h))
		return { every: "hours", step: stepOf(h) as number, minute };
	const hour = num(h);
	if (hour === null) return null;
	if (daily) return { every: "day", hour, minute };
	if (dom === "*") {
		const days = weekdays(dow);
		return days ? { every: "week", days, hour, minute } : null;
	}
	const day = num(dom);
	if (day !== null && dow === "*") return { every: "month", day, hour, minute };
	return null;
}

/** Another frequency, keeping the time of day where both have one. */
export function switchEvery(
	from: SimpleCron | null,
	every: CronEvery,
): SimpleCron {
	const hour = from && "hour" in from ? from.hour : 3;
	const minute = from && "minute" in from ? from.minute : 0;
	switch (every) {
		case "minutes":
			return { every, step: 15 };
		case "hours":
			return { every, step: 1, minute };
		case "day":
			return { every, hour, minute };
		case "week":
			return { every, days: [1], hour, minute };
		case "month":
			return { every, day: 1, hour, minute };
	}
}

/** "Tue 4 Nov, 03:00 CET" in the schedule's own zone. */
export function formatInZone(iso: string, timezone: string) {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(iso));
}

export const browserTimezone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

/** Every IANA zone the browser knows, UTC first. */
export function timezones(): string[] {
	const all =
		(
			Intl as { supportedValuesOf?: (k: string) => string[] }
		).supportedValuesOf?.("timeZone") ?? [];
	return ["UTC", ...all.filter((z) => z !== "UTC")];
}
