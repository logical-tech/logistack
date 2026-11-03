const rtf = new Intl.RelativeTimeFormat("en", {
	numeric: "auto",
	style: "short",
});

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 31_536_000],
	["month", 2_592_000],
	["week", 604_800],
	["day", 86_400],
	["hour", 3_600],
	["minute", 60],
];

/** "14 min. ago", "in 6 days". Under a minute reads "just now". */
export function relativeTime(iso: string, now = Date.now()): string {
	const seconds = (new Date(iso).getTime() - now) / 1000;
	const abs = Math.abs(seconds);
	if (abs < 60) return "just now";
	for (const [unit, size] of UNITS) {
		if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
	}
	return "just now";
}

/** "1m 36s", "48s", "2h 4m". */
export function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const daysUntil = (iso: string, now = Date.now()) =>
	Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
