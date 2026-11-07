import type { AiAllowance } from "@logistack/core/ai-providers";
import type { ReactNode } from "react";
import type { AiTier } from "@/lib/api/ai";
import { formatCount, formatUsd } from "@/lib/api/ai";
import { cn } from "@/lib/utils";

/** Free models chart in the first series colour, paid in the second, everywhere on the AI pages. */
export const TIER_COLOR: Record<AiTier, string> = {
	free: "var(--chart-1)",
	paid: "var(--chart-2)",
};

export function TierBadge({ tier }: { tier: AiTier }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-2xs font-medium",
				tier === "free"
					? "bg-muted text-muted-foreground"
					: "bg-[color-mix(in_oklch,var(--chart-2)_12%,transparent)] text-foreground",
			)}
		>
			<span
				aria-hidden
				className="size-1.5 rounded-full"
				style={{ background: TIER_COLOR[tier] }}
			/>
			{tier === "free" ? "Free" : "Paid"}
		</span>
	);
}

/** A KPI tile, matching the Monitoring usage tiles. */
export function Tile({
	label,
	value,
	detail,
	loading,
}: {
	label: string;
	value: ReactNode;
	detail?: ReactNode;
	loading: boolean;
}) {
	return (
		<div className="min-w-0 rounded-xl bg-card p-4 shadow-card ring-1 ring-border">
			<p className="text-sm text-muted-foreground">{label}</p>
			<p className="mt-1 flex h-7 items-baseline gap-2 text-xl font-semibold tabular [font-stretch:108%]">
				{loading ? (
					<span className="t-skel inline-block h-5 w-16 self-center rounded bg-muted-foreground/15" />
				) : (
					value
				)}
			</p>
			<p className="mt-0.5 h-4 truncate text-xs text-muted-foreground tabular">
				{!loading && detail}
			</p>
		</div>
	);
}

/**
 * Spend against a monthly cap. `null` cap is unlimited (no bar, just the spend); a `0` cap
 * means the tier is off for this person.
 */
export function BudgetMeter({
	spent,
	cap,
	tier,
	compact,
}: {
	spent: number;
	cap: number | null;
	tier: AiTier;
	compact?: boolean;
}) {
	const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
	const tone =
		cap === null ? null : pct >= 100 ? "bad" : pct >= 80 ? "warn" : null;
	const label =
		cap === null
			? `${formatUsd(spent)}, no cap`
			: cap === 0
				? "Off"
				: `${formatUsd(spent)} of ${formatUsd(cap)}`;
	return (
		<div className="min-w-0">
			<div
				className={cn(
					"flex items-baseline justify-between gap-2 tabular",
					compact ? "text-xs" : "text-sm",
				)}
			>
				<span
					className={cn(
						"truncate",
						cap === 0 && "text-muted-foreground",
						tone === "bad" && "text-bad-text",
						tone === "warn" && "text-warn-text",
					)}
				>
					{label}
				</span>
				{cap !== null && cap > 0 && (
					<span className="shrink-0 text-xs text-muted-foreground">
						{Math.round(pct)}%
					</span>
				)}
			</div>
			{cap ? (
				<div
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={cap}
					aria-valuenow={Math.min(spent, cap)}
					aria-label={`${tier === "free" ? "Free" : "Paid"} budget used`}
					className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
				>
					<div
						className="h-full rounded-full transition-[width] duration-(--duration-slow) ease-(--ease-smooth-out)"
						style={{
							width: `${pct}%`,
							background:
								tone === "bad"
									? "var(--bad)"
									: tone === "warn"
										? "var(--warn)"
										: TIER_COLOR[tier],
						}}
					/>
				</div>
			) : (
				<div
					aria-hidden
					className="mt-1.5 h-1.5 rounded-full bg-muted opacity-50"
				/>
			)}
		</div>
	);
}

/** "1,000" below ten thousand, "100K" and "1M" above, so small limits stay exact. */
export const formatAmount = (n: number) =>
	n >= 10_000 ? formatCount(n) : n.toLocaleString("en");

const SCOPE = { account: "", model: " per model", ip: " per IP" } as const;

/** "100K tokens/day per model"; `short` drops the scope. */
export function formatAllowance(a: AiAllowance, short = false) {
	const amount =
		a.unit === "usd"
			? `${formatUsd(a.amount)} credit`
			: `${formatAmount(a.amount)} ${a.amount === 1 ? a.unit.slice(0, -1) : a.unit}`;
	return `${amount}/${a.per}${short ? "" : SCOPE[a.scope ?? "account"]}`;
}

/** Every published limit in words, or "Unpublished". */
export const formatAllowances = (limits: readonly AiAllowance[] = []) =>
	limits.length
		? limits.map((a) => formatAllowance(a)).join(" · ")
		: "Unpublished";
