import type {
	IncidentImpact,
	IncidentStatus,
	Monitor,
	MonitorStatus,
	UptimeDay,
} from "@/lib/api/uptime";
import type { StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export const MONITOR_STATUS: Record<MonitorStatus, StatusMeta> = {
	up: { label: "Up", tone: "ok" },
	down: { label: "Down", tone: "bad" },
	pending: { label: "Checking", tone: "busy", live: true },
	maintenance: { label: "Maintenance", tone: "info" },
	paused: { label: "Paused", tone: "idle" },
};

export const INCIDENT_STATUS: Record<IncidentStatus, StatusMeta> = {
	investigating: { label: "Investigating", tone: "bad" },
	identified: { label: "Identified", tone: "warn" },
	monitoring: { label: "Monitoring", tone: "info" },
	resolved: { label: "Resolved", tone: "ok" },
};

export const IMPACT_LABEL: Record<IncidentImpact, string> = {
	minor: "Minor",
	major: "Major",
	critical: "Critical",
};

/** `99.97%`, `100%`, or an en dash without data. */
export const pct = (n: number | null | undefined) =>
	n === null || n === undefined
		? "–"
		: `${n >= 99.995 ? "100" : n.toFixed(2)}%`;

const DAY_TONE: Record<UptimeDay["status"], string> = {
	up: "bg-ok",
	degraded: "bg-warn",
	down: "bg-bad",
	maintenance: "bg-info",
	none: "bg-muted-foreground/15",
};

const dayLabel = (d: UptimeDay) =>
	`${new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	})}: ${
		d.status === "none"
			? "no data"
			: d.status === "maintenance"
				? "maintenance"
				: `${pct(d.uptime)} up`
	}`;

/** One bar per day, oldest left. The title carries the value for pointer users, the list for readers. */
export function UptimeBars({
	days,
	className,
}: {
	days: UptimeDay[];
	className?: string;
}) {
	const bad = days.filter(
		(d) => d.status === "down" || d.status === "degraded",
	);
	return (
		<div className={className}>
			<div
				role="img"
				aria-label={`Daily uptime over ${days.length} days: ${
					bad.length === 0
						? "no outages"
						: `${bad.length} day${bad.length === 1 ? "" : "s"} below 99.9%`
				}`}
				className="flex h-8 items-stretch gap-[2px]"
			>
				{days.map((d) => (
					<span
						key={d.day}
						title={dayLabel(d)}
						className={cn(
							"min-w-0 flex-1 rounded-[2px] transition-opacity duration-(--duration-quick) hover:opacity-70",
							DAY_TONE[d.status],
						)}
					/>
				))}
			</div>
			<div className="mt-1.5 flex justify-between text-xs text-muted-foreground tabular">
				<span>{days.length} days ago</span>
				<span>Today</span>
			</div>
		</div>
	);
}

/** The last checks as thin ticks; a failed one is red and full height. */
export function CheckStrip({
	checks,
	className,
}: {
	checks: Monitor["recent"];
	className?: string;
}) {
	if (checks.length === 0)
		return (
			<span className={cn("text-xs text-muted-foreground", className)}>
				No checks yet
			</span>
		);
	const failed = checks.filter((c) => !c.ok).length;
	return (
		<span
			role="img"
			aria-label={`Last ${checks.length} checks: ${failed} failed`}
			className={cn("flex h-5 items-end gap-px", className)}
		>
			{checks.map((c) => (
				<span
					key={c.at}
					className={cn(
						"w-[3px] shrink-0 rounded-[1px]",
						c.ok ? "h-3 bg-ok/70" : "h-5 bg-bad",
					)}
				/>
			))}
		</span>
	);
}

/** A labelled number for the detail header. */
export function Stat({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: "bad" | "warn";
}) {
	return (
		<div className="grid gap-0.5">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd
				className={cn(
					"text-lg font-semibold tabular",
					tone === "bad" && "text-bad-text",
					tone === "warn" && "text-warn-text",
				)}
			>
				{value}
			</dd>
		</div>
	);
}
