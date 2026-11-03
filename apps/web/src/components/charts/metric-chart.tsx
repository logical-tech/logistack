import type { MetricRange } from "@logistack/contracts";
import type { ReactNode } from "react";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Line,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from "recharts";
import {
	type ChartRow,
	stats,
	tickLabel,
	timeTicks,
	tooltipLabel,
} from "@/lib/metrics";
import { cn } from "@/lib/utils";

export type ChartSeries = {
	key: string;
	label: string;
	color: string;
	/** A reference line (a limit), drawn dashed and never filled. */
	dashed?: boolean;
};

/** Series colour by position; the fifth series and beyond fold into idle grey. */
export const seriesColor = (i: number) => `var(--chart-${Math.min(i, 4) + 1})`;

export type MetricChartProps = {
	title: string;
	rows: ChartRow[] | undefined;
	series: ChartSeries[];
	format: (v: number) => string;
	/** Shorter labels for the y axis; defaults to `format`. */
	axisFormat?: (v: number) => string;
	range: MetricRange;
	window: { from: number; to: number } | undefined;
	/** Fixed y domain, e.g. [0, 100] for percentages. */
	domain?: [number, number];
	/** Secondary text beside the latest value, e.g. "18 GiB of 32 GiB". */
	detail?: ReactNode;
	/** One line per node has no single latest value worth a headline. */
	showLatest?: boolean;
	empty: string;
	/** `step` for counts that change in whole units, like replicas. */
	curve?: "monotone" | "step";
	height?: number;
	className?: string;
};

function ChartTooltip({
	active,
	payload,
	label,
	series,
	format,
}: Pick<TooltipContentProps<number, string>, "active" | "payload" | "label"> & {
	series: ChartSeries[];
	format: (v: number) => string;
}) {
	if (!active || !payload?.length) return null;
	const byKey = new Map(payload.map((p) => [String(p.dataKey), p.value]));
	return (
		<div className="min-w-40 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-float ring-1 ring-border">
			<p className="mb-1.5 text-muted-foreground tabular">
				{tooltipLabel(Number(label))}
			</p>
			<ul className="grid gap-1">
				{series.map((s) => {
					const v = byKey.get(s.key);
					return (
						<li key={s.key} className="flex items-center gap-2">
							<span
								aria-hidden
								className={cn(
									"h-0.5 w-2.5 shrink-0 rounded-full",
									s.dashed && "opacity-60",
								)}
								style={{ background: s.color }}
							/>
							<span className="min-w-0 truncate text-muted-foreground">
								{s.label}
							</span>
							<span className="ml-auto pl-3 font-medium tabular">
								{typeof v === "number" ? format(v) : "–"}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/**
 * One metric over the selected range, in the house chart style: recessive grid, 2px
 * lines, a faint flat fill under a lone series, crosshair tooltip, tabular figures.
 */
export function MetricChart({
	title,
	rows,
	series,
	format,
	axisFormat = format,
	range,
	window,
	domain,
	detail,
	showLatest = true,
	empty,
	curve = "monotone",
	height = 168,
	className,
}: MetricChartProps) {
	const loading = rows === undefined;
	const hasData =
		!!rows && rows.some((r) => series.some((s) => r[s.key] !== null));
	const primary = series.find((s) => !s.dashed);
	const latest = primary && rows ? stats(rows, primary.key) : undefined;
	const solo = series.filter((s) => !s.dashed).length === 1;
	const ticks = window ? timeTicks(range, window.from, window.to) : undefined;

	return (
		<figure
			className={cn(
				"min-w-0 rounded-xl bg-card p-4 shadow-card ring-1 ring-border",
				className,
			)}
		>
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<span className="text-sm font-medium">{title}</span>
				{series.length > 1 && (
					<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						{series.map((s) => (
							<span key={s.key} className="inline-flex items-center gap-1.5">
								<span
									aria-hidden
									className={cn(
										"h-0.5 w-2.5 rounded-full",
										s.dashed && "opacity-60",
									)}
									style={{ background: s.color }}
								/>
								{s.label}
							</span>
						))}
					</span>
				)}
			</figcaption>
			{showLatest && (
				<p className="mt-1 flex h-7 items-baseline gap-2 text-xl font-semibold tabular [font-stretch:108%]">
					{loading ? (
						<span className="t-skel inline-block h-5 w-16 self-center rounded bg-muted-foreground/15" />
					) : typeof latest?.latest === "number" ? (
						<>
							{format(latest.latest)}
							{detail && (
								<span className="truncate text-xs font-normal text-muted-foreground [font-stretch:100%]">
									{detail}
								</span>
							)}
						</>
					) : (
						<span className="text-muted-foreground">–</span>
					)}
				</p>
			)}
			{hasData && latest && solo && (
				<p className="sr-only">
					{title}: latest {format(latest.latest ?? 0)}, average{" "}
					{format(latest.avg ?? 0)}, peak {format(latest.max ?? 0)}.
				</p>
			)}

			<div className="mt-3" style={{ height }}>
				{loading ? (
					<div className="t-skel size-full rounded-md bg-muted-foreground/8" />
				) : !hasData ? (
					<div className="t-reveal grid size-full place-items-center rounded-md bg-muted/50 px-6 text-center text-xs text-muted-foreground dark:bg-muted/30">
						{empty}
					</div>
				) : (
					<div className="t-reveal size-full text-2xs tabular">
						<ResponsiveContainer width="100%" height="100%">
							<ComposedChart
								data={rows}
								margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
							>
								<CartesianGrid
									vertical={false}
									stroke="var(--border)"
									strokeDasharray="0"
								/>
								<XAxis
									dataKey="t"
									type="number"
									scale="time"
									domain={window ? [window.from, window.to] : ["auto", "auto"]}
									ticks={ticks}
									tickFormatter={tickLabel(range)}
									tickLine={false}
									axisLine={false}
									tickMargin={8}
									minTickGap={24}
									stroke="var(--muted-foreground)"
									fontSize={11}
								/>
								<YAxis
									domain={domain ?? [0, "auto"]}
									ticks={
										domain
											? [domain[0], (domain[0] + domain[1]) / 2, domain[1]]
											: undefined
									}
									tickCount={3}
									tickFormatter={axisFormat}
									tickLine={false}
									axisLine={false}
									width={domain ? 44 : 72}
									stroke="var(--muted-foreground)"
									fontSize={11}
								/>
								<Tooltip
									cursor={{
										stroke: "var(--muted-foreground)",
										strokeOpacity: 0.4,
									}}
									isAnimationActive={false}
									content={(p) => (
										<ChartTooltip
											active={p.active}
											payload={
												p.payload as TooltipContentProps<
													number,
													string
												>["payload"]
											}
											label={p.label}
											series={series}
											format={format}
										/>
									)}
								/>
								{series.map((s) =>
									solo && !s.dashed ? (
										<Area
											key={s.key}
											dataKey={s.key}
											name={s.label}
											type={curve === "step" ? "stepAfter" : "monotone"}
											stroke={s.color}
											strokeWidth={2}
											fill={s.color}
											fillOpacity={0.08}
											isAnimationActive={false}
											dot={false}
											activeDot={{
												r: 4,
												strokeWidth: 2,
												stroke: "var(--card)",
											}}
										/>
									) : (
										<Line
											key={s.key}
											dataKey={s.key}
											name={s.label}
											type={curve === "step" ? "stepAfter" : "monotone"}
											stroke={s.color}
											strokeWidth={s.dashed ? 1.5 : 2}
											strokeDasharray={s.dashed ? "4 4" : undefined}
											strokeOpacity={s.dashed ? 0.6 : 1}
											isAnimationActive={false}
											dot={false}
											activeDot={
												s.dashed
													? false
													: { r: 4, strokeWidth: 2, stroke: "var(--card)" }
											}
										/>
									),
								)}
							</ComposedChart>
						</ResponsiveContainer>
					</div>
				)}
			</div>
		</figure>
	);
}
