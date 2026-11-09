import type { WorkColor } from "@logistack/contracts";

/** Palette token → literal Tailwind classes (kept whole so the scanner finds them). */
export const WORK_DOT: Record<WorkColor, string> = {
	gray: "bg-slate-400 dark:bg-slate-500",
	blue: "bg-blue-500",
	amber: "bg-amber-500",
	green: "bg-emerald-500",
	red: "bg-red-500",
	violet: "bg-violet-500",
	pink: "bg-pink-500",
	teal: "bg-teal-500",
};

/** Timeline and calendar bars: a quiet fill with a solid edge, text that passes 4.5:1. */
export const WORK_BAR: Record<WorkColor, string> = {
	gray: "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-500/20 dark:text-slate-200 dark:ring-slate-500/50",
	blue: "bg-blue-50 text-blue-800 ring-blue-300 dark:bg-blue-500/20 dark:text-blue-100 dark:ring-blue-400/50",
	amber:
		"bg-amber-50 text-amber-900 ring-amber-300 dark:bg-amber-500/20 dark:text-amber-100 dark:ring-amber-400/50",
	green:
		"bg-emerald-50 text-emerald-800 ring-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-100 dark:ring-emerald-400/50",
	red: "bg-red-50 text-red-800 ring-red-300 dark:bg-red-500/20 dark:text-red-100 dark:ring-red-400/50",
	violet:
		"bg-violet-50 text-violet-800 ring-violet-300 dark:bg-violet-500/20 dark:text-violet-100 dark:ring-violet-400/50",
	pink: "bg-pink-50 text-pink-800 ring-pink-300 dark:bg-pink-500/20 dark:text-pink-100 dark:ring-pink-400/50",
	teal: "bg-teal-50 text-teal-800 ring-teal-300 dark:bg-teal-500/20 dark:text-teal-100 dark:ring-teal-400/50",
};

/** Progress fill inside a bar. */
export const WORK_FILL: Record<WorkColor, string> = {
	gray: "bg-slate-300/70 dark:bg-slate-400/30",
	blue: "bg-blue-200/80 dark:bg-blue-400/30",
	amber: "bg-amber-200/80 dark:bg-amber-400/30",
	green: "bg-emerald-200/80 dark:bg-emerald-400/30",
	red: "bg-red-200/80 dark:bg-red-400/30",
	violet: "bg-violet-200/80 dark:bg-violet-400/30",
	pink: "bg-pink-200/80 dark:bg-pink-400/30",
	teal: "bg-teal-200/80 dark:bg-teal-400/30",
};
