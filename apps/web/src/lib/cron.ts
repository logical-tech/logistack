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

export const CRON_PRESETS = [
	{ value: "0 * * * *", label: "Hourly" },
	{ value: "0 3 * * *", label: "Daily" },
	{ value: "0 3 * * 0", label: "Weekly" },
] as const;

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
