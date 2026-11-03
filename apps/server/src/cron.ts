import { z } from "@hono/zod-openapi";
import { CronExpressionParser } from "cron-parser";

/** An IANA zone the runtime knows, e.g. `Europe/Rome`. */
export const Timezone = z
	.string()
	.min(1)
	.refine((tz) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: tz });
			return true;
		} catch {
			return false;
		}
	}, "unknown time zone");

/** Five-field cron (minute hour day month weekday), the form BullMQ and the UI preview share. */
export const Cron = z
	.string()
	.trim()
	.refine((expr) => {
		if (expr.split(/\s+/).length !== 5) return false;
		try {
			CronExpressionParser.parse(expr);
			return true;
		} catch {
			return false;
		}
	}, "use five cron fields: minute hour day month weekday");

export function nextRuns(
	expr: string,
	tz: string,
	count: number,
	from = new Date(),
): string[] {
	const it = CronExpressionParser.parse(expr, { tz, currentDate: from });
	return Array.from({ length: count }, () => it.next().toISOString() as string);
}

export const nextRun = (expr: string | null, tz: string, enabled = true) =>
	expr && enabled ? (nextRuns(expr, tz, 1)[0] ?? null) : null;
