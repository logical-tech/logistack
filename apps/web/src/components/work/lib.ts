/* Small shared vocabulary for Work screens: colours, priorities, health, dates, people. */
import type {
	WorkColor,
	WorkHealth,
	WorkPerson,
	WorkPriority,
	WorkStatus,
	WorkTaskListItem,
} from "@logistack/contracts";
import type { CSSProperties } from "react";
import type { Tone } from "@/lib/status";

/** CSS variables `--wc` (solid) and `--wc-text` for a palette token; use `bg-(--wc)`, `text-(--wc-text)`. */
export const wc = (color: WorkColor | null | undefined): CSSProperties =>
	({
		"--wc": `var(--wc-${color ?? "gray"})`,
		"--wc-text": `var(--wc-${color ?? "gray"}-text)`,
	}) as CSSProperties;

export const WORK_COLORS: WorkColor[] = [
	"gray",
	"blue",
	"teal",
	"green",
	"amber",
	"red",
	"pink",
	"violet",
];

export const PRIORITIES: {
	id: WorkPriority;
	label: string;
	tone: Tone | null;
}[] = [
	{ id: "urgent", label: "Urgent", tone: "bad" },
	{ id: "high", label: "High", tone: "warn" },
	{ id: "normal", label: "Normal", tone: "info" },
	{ id: "low", label: "Low", tone: "idle" },
	{ id: "none", label: "No priority", tone: null },
];
export const priorityMeta = (p: WorkPriority) =>
	PRIORITIES.find((x) => x.id === p) ??
	(PRIORITIES[4] as (typeof PRIORITIES)[4]);

export const HEALTH: Record<
	WorkHealth,
	{ label: string; tone: Tone; copy: string }
> = {
	operational: {
		label: "Operational",
		tone: "ok",
		copy: "Everything is up and responding normally.",
	},
	degraded: {
		label: "Degraded",
		tone: "warn",
		copy: "Working, but slower or partly unavailable.",
	},
	down: {
		label: "Down",
		tone: "bad",
		copy: "Not reachable right now. The team is looking at it.",
	},
	maintenance: {
		label: "Maintenance",
		tone: "info",
		copy: "Planned work in progress. It may be briefly unavailable.",
	},
	paused: {
		label: "Off",
		tone: "idle",
		copy: "Switched off on purpose.",
	},
	unknown: {
		label: "No data yet",
		tone: "idle",
		copy: "No health reports yet.",
	},
};

/** "Operational", "Degraded since 14:02", "Down for 12 min", "Maintenance", "Off". */
export function healthLabel(
	health: WorkHealth,
	since: string | null,
	now = Date.now(),
): string {
	const base = HEALTH[health].label;
	if (!since || (health !== "degraded" && health !== "down")) return base;
	const at = new Date(since);
	if (health === "down") return `Down for ${duration(now - at.getTime())}`;
	const sameDay = new Date(now).toDateString() === at.toDateString();
	return `Degraded since ${
		sameDay
			? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
			: at.toLocaleDateString(undefined, { day: "numeric", month: "short" })
	}`;
}

/** "45 s", "12 min", "3 h", "2 d". */
export function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.round(s / 60)} min`;
	if (s < 86_400) return `${Math.round(s / 3600)} h`;
	return `${Math.round(s / 86_400)} d`;
}

export const initials = (name: string | undefined | null) =>
	(name ?? "?")
		.split(/\s+/)
		.filter(Boolean)
		.map((p) => p[0])
		.slice(0, 2)
		.join("")
		.toUpperCase() || "?";

export const isClosed = (s: WorkStatus | undefined) =>
	s?.category === "done" || s?.category === "cancelled";

export const todayIso = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const asDate = (iso: string) => new Date(`${iso}T00:00:00`);
const dayDiff = (iso: string) =>
	Math.round(
		(asDate(iso).getTime() - asDate(todayIso()).getTime()) / 86_400_000,
	);

/** "Today", "Tomorrow", "Yesterday", "Fri", "12 Nov", "12 Nov 2027". */
export function formatDay(iso: string | null | undefined): string {
	if (!iso) return "";
	const diff = dayDiff(iso);
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	const d = asDate(iso);
	if (diff > 1 && diff < 7)
		return d.toLocaleDateString(undefined, { weekday: "short" });
	return d.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		...(d.getFullYear() !== new Date().getFullYear()
			? { year: "numeric" }
			: {}),
	});
}

/** Due date tone: overdue (open tasks only), today, or nothing. */
export function dueTone(
	due: string | null,
	closed: boolean,
): "overdue" | "today" | null {
	if (!due || closed) return null;
	const diff = dayDiff(due);
	return diff < 0 ? "overdue" : diff === 0 ? "today" : null;
}

/** "3 min ago", "2 h ago", "Yesterday", "12 Nov". */
export function timeAgo(iso: string, now = Date.now()): string {
	const ms = now - new Date(iso).getTime();
	if (ms < 60_000) return "Just now";
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
	if (ms < 2 * 86_400_000) return "Yesterday";
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});
}

/** "2h 30m", "45m", "" for null. */
export function formatMinutes(min: number | null | undefined): string {
	if (!min) return "";
	const h = Math.floor(min / 60);
	const m = min % 60;
	return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** "1h30", "90m", "1.5h", "2h 15m", "45" (minutes) → minutes; null when unreadable. */
export function parseMinutes(input: string): number | null {
	const s = input.trim().toLowerCase().replace(",", ".");
	if (!s) return null;
	if (/^\d+$/.test(s)) return Number(s);
	const hm = /^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/.exec(s);
	if (hm) return Math.round(Number(hm[1]) * 60 + Number(hm[2] ?? 0));
	const m = /^(\d+)\s*m(in)?$/.exec(s);
	return m ? Number(m[1]) : null;
}

export const personName = (
	people: WorkPerson[],
	id: string | null | undefined,
) => (id ? (people.find((p) => p.userId === id)?.name ?? "Former member") : "");

/** The task with its status category, as core `matchesTask` reads it. */
/** Takes a list row or a full task: their `dependencies` differ (array of edges vs both directions). */
export const matchable = (
	t: Omit<WorkTaskListItem, "dependencies">,
	statuses: WorkStatus[],
) => ({
	...t,
	statusCategory: statuses.find((s) => s.id === t.statusId)?.category ?? "",
	assigneeIds: t.assigneeIds ?? [],
	tagIds: t.tagIds ?? [],
	fields: t.fields ?? {},
	blocked: t.blocked ?? false,
	descriptionText: null,
});
