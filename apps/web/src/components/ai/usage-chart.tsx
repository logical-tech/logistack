import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { TIER_COLOR } from "@/components/ai/parts";
import type { AiFigures, AiUsage } from "@/lib/api/ai";
import { cn } from "@/lib/utils";

export type UsageMetric = "requests" | "tokens" | "cost";

const pick = (f: AiFigures, m: UsageMetric) =>
	m === "requests"
		? f.requests
		: m === "tokens"
			? f.inputTokens + f.outputTokens
			: f.cost;

const LABEL: Record<AiUsage["step"], Intl.DateTimeFormat> = {
	hour: new Intl.DateTimeFormat("en", {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}),
	day: new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }),
	week: new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }),
	month: new Intl.DateTimeFormat("en", { month: "short", year: "2-digit" }),
};

const TIERS = [
	{ key: "free", label: "Free models" },
	{ key: "paid", label: "Paid models" },
] as const;

/** Free and paid stacked per bucket, so the share the free chain absorbs is visible at a glance. */
export function UsageChart({
	data,
	metric,
	format,
	axisFormat = format,
}: {
	data: AiUsage | undefined;
	metric: UsageMetric;
	format: (v: number) => string;
	axisFormat?: (v: number) => string;
}) {
	const rows = data?.buckets.map((b) => ({
		label: LABEL[data.step].format(new Date(b.t)),
		week: data.step === "week",
		free: pick(b.free, metric),
		paid: pick(b.paid, metric),
	}));
	const hasData = rows?.some((r) => r.free + r.paid > 0);

	return (
		<div className="h-60">
			{!rows ? (
				<div className="t-skel size-full rounded-md bg-muted-foreground/8" />
			) : !hasData ? (
				<div className="t-reveal grid size-full place-items-center rounded-md bg-muted/50 px-6 text-center text-xs text-muted-foreground dark:bg-muted/30">
					No requests in this range yet.
				</div>
			) : (
				<div className="t-reveal size-full text-2xs tabular">
					<ResponsiveContainer width="100%" height="100%">
						<BarChart
							data={rows}
							margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
							barCategoryGap="22%"
							maxBarSize={32}
						>
							<CartesianGrid vertical={false} stroke="var(--border)" />
							<XAxis
								dataKey="label"
								tickLine={false}
								axisLine={false}
								tickMargin={8}
								minTickGap={16}
								stroke="var(--muted-foreground)"
								fontSize={11}
							/>
							<YAxis
								tickCount={3}
								tickFormatter={axisFormat}
								tickLine={false}
								axisLine={false}
								width={56}
								stroke="var(--muted-foreground)"
								fontSize={11}
							/>
							<Tooltip
								cursor={{ fill: "var(--muted)", opacity: 0.6 }}
								isAnimationActive={false}
								content={({ active, payload, label }) => {
									if (!active || !payload?.length) return null;
									const row = payload[0]?.payload as {
										free: number;
										paid: number;
										week: boolean;
									};
									return (
										<div className="min-w-44 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-float ring-1 ring-border">
											<p className="mb-1.5 text-muted-foreground tabular">
												{row.week ? `Week of ${label}` : label}
											</p>
											<ul className="grid gap-1">
												{TIERS.map((t) => (
													<li key={t.key} className="flex items-center gap-2">
														<span
															aria-hidden
															className="size-2 shrink-0 rounded-[2px]"
															style={{ background: TIER_COLOR[t.key] }}
														/>
														<span className="text-muted-foreground">
															{t.label}
														</span>
														<span className="ml-auto pl-3 font-medium tabular">
															{format(row[t.key])}
														</span>
													</li>
												))}
											</ul>
										</div>
									);
								}}
							/>
							{TIERS.map((t, i) => (
								<Bar
									key={t.key}
									dataKey={t.key}
									name={t.label}
									stackId="tier"
									fill={TIER_COLOR[t.key]}
									radius={i === TIERS.length - 1 ? [3, 3, 0, 0] : 0}
									isAnimationActive={false}
								/>
							))}
						</BarChart>
					</ResponsiveContainer>
				</div>
			)}
		</div>
	);
}

export function TierLegend({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
				className,
			)}
		>
			{TIERS.map((t) => (
				<span key={t.key} className="inline-flex items-center gap-1.5">
					<span
						aria-hidden
						className="size-2 rounded-[2px]"
						style={{ background: TIER_COLOR[t.key] }}
					/>
					{t.label}
				</span>
			))}
		</span>
	);
}
