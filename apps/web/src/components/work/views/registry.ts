import type { WorkViewKind } from "@logistack/contracts";
import {
	CalendarDays,
	GanttChart,
	type LucideIcon,
	SquareKanban,
	Table2,
} from "lucide-react";
import { type ComponentType, type LazyExoticComponent, lazy } from "react";
import type { ViewProps } from "./types";

type ViewComponent = LazyExoticComponent<ComponentType<ViewProps>>;

/** One component per view kind, each its own chunk. */
export const VIEW_COMPONENTS: Record<WorkViewKind, ViewComponent> = {
	table: lazy(() =>
		import("./table-view").then((m) => ({ default: m.TableView })),
	),
	board: lazy(() =>
		import("./board-view").then((m) => ({ default: m.BoardView })),
	),
	timeline: lazy(() =>
		import("./timeline-view").then((m) => ({ default: m.TimelineView })),
	),
	calendar: lazy(() =>
		import("./calendar-view").then((m) => ({ default: m.CalendarView })),
	),
};

/** Labels and icons for tabs and the "+ View" wizard. */
export const VIEW_KINDS: Record<
	WorkViewKind,
	{ label: string; icon: LucideIcon; description: string }
> = {
	table: {
		label: "Table",
		icon: Table2,
		description: "Rows and columns, grouped and sortable, edited in place.",
	},
	board: {
		label: "Board",
		icon: SquareKanban,
		description:
			"Cards in columns by status, priority or person. Drag to move.",
	},
	timeline: {
		label: "Timeline",
		icon: GanttChart,
		description: "Bars on a calendar, with dependencies between tasks.",
	},
	calendar: {
		label: "Calendar",
		icon: CalendarDays,
		description: "Tasks on the days they are due.",
	},
};
