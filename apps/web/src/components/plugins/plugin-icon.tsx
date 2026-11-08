import {
	Activity,
	BarChart3,
	Bell,
	BookOpen,
	Boxes,
	Calendar,
	Database,
	Gauge,
	Globe,
	KeyRound,
	LayoutDashboard,
	ListChecks,
	type LucideIcon,
	Puzzle,
	Receipt,
	Rocket,
	ScrollText,
	Settings2,
	Shield,
	Wallet,
} from "lucide-react";

// shortcut: a fixed set keeps the bundle small; widen it when plugins ask for more names.
const ICONS: Record<string, LucideIcon> = {
	activity: Activity,
	"bar-chart": BarChart3,
	chart: BarChart3,
	bell: Bell,
	book: BookOpen,
	boxes: Boxes,
	calendar: Calendar,
	database: Database,
	gauge: Gauge,
	globe: Globe,
	key: KeyRound,
	dashboard: LayoutDashboard,
	"list-checks": ListChecks,
	receipt: Receipt,
	rocket: Rocket,
	logs: ScrollText,
	settings: Settings2,
	shield: Shield,
	wallet: Wallet,
};

/** A page's manifest icon name, or the puzzle piece every plugin falls back to. */
export const pluginIcon = (name?: string): LucideIcon =>
	(name && ICONS[name]) || Puzzle;

/** The neutral "Unlisted" badge: not from a reviewed marketplace entry. */
export function UnlistedBadge() {
	return (
		<span
			className="rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground"
			title="Not from a reviewed marketplace entry"
		>
			Unlisted
		</span>
	);
}
