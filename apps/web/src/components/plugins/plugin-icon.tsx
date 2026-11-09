import {
	Activity,
	BadgeCheck,
	BarChart3,
	Bell,
	BookOpen,
	Boxes,
	Calendar,
	Database,
	Gauge,
	Globe,
	Hand,
	Heart,
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
	Smile,
	Sparkles,
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
	sparkles: Sparkles,
	heart: Heart,
	smile: Smile,
	hand: Hand,
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

/** A version a maintainer reviewed on its index. */
export function VerifiedBadge() {
	return (
		<span
			className="inline-flex items-center gap-1 rounded-sm bg-ok/10 px-1.5 py-px text-2xs font-medium text-ok-text"
			title="A maintainer reviewed this version's source on its index"
		>
			<BadgeCheck className="size-3" strokeWidth={2} aria-hidden />
			Verified
		</span>
	);
}

/** Listed on an index, passed its automatic checks, not reviewed by a person. */
export function UnverifiedBadge() {
	return (
		<span
			className="rounded-sm bg-warn/10 px-1.5 py-px text-2xs font-medium text-warn-text"
			title="Listed on its index and passed automatic checks, but nobody reviewed the source"
		>
			Unverified
		</span>
	);
}

/** Where an install or entry comes from: verified, unverified marketplace entry, or Unlisted. */
export function SourceBadge({
	indexId,
	verified,
}: {
	indexId: string | null;
	verified: boolean;
}) {
	if (!indexId) return <UnlistedBadge />;
	return verified ? <VerifiedBadge /> : <UnverifiedBadge />;
}
