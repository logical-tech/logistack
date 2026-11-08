import { type MetricRange, metricRanges } from "@logistack/contracts";
import {
	type ChartSeries,
	MetricChart,
	seriesColor,
} from "@/components/charts/metric-chart";
import { Segmented } from "@/components/segmented";
import type { ClusterNode, HostMetrics, HostPoint } from "@/lib/api/types";
import {
	formatBytes,
	formatPct,
	formatRate,
	pct,
	sum,
	toRows,
} from "@/lib/metrics";

const RANGE_LABEL: Record<MetricRange, string> = {
	"1h": "1 hour",
	"6h": "6 hours",
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
};

/** The five ranges the API serves. */
export function RangePicker({
	value,
	onChange,
}: {
	value: MetricRange;
	onChange: (r: MetricRange) => void;
}) {
	return (
		<Segmented
			label="Time range"
			value={value}
			onChange={onChange}
			options={metricRanges.map((r) => ({
				value: r,
				label: r,
				ariaLabel: `Last ${RANGE_LABEL[r]}`,
			}))}
		/>
	);
}

type Metric = {
	id: string;
	title: string;
	format: (v: number) => string;
	domain?: [number, number];
	value: (p: HostPoint) => number | null;
	/** "18.4 GiB of 96.0 GiB" beside the latest value. */
	detail?: (p: HostPoint) => string | undefined;
};

const usedOf = (used: number | null, total: number | null) =>
	`${formatBytes(used)} of ${formatBytes(total)}`;

const PERCENT: Metric[] = [
	{
		id: "cpu",
		title: "CPU",
		format: formatPct,
		domain: [0, 100],
		value: (p) => p.cpu,
		detail: (p) =>
			typeof p.iowait === "number"
				? `iowait ${formatPct(p.iowait)} · steal ${formatPct(p.steal)}`
				: undefined,
	},
	{
		id: "memory",
		title: "Memory",
		format: formatPct,
		domain: [0, 100],
		value: (p) => pct(p.memUsed, p.memTotal),
		detail: (p) => usedOf(p.memUsed, p.memTotal),
	},
	{
		id: "disk",
		title: "Disk",
		format: formatPct,
		domain: [0, 100],
		value: (p) => pct(p.diskUsed, p.diskTotal),
		detail: (p) => usedOf(p.diskUsed, p.diskTotal),
	},
];

/**
 * CPU, memory, disk and network for one host query. With `nodes` and several series it
 * draws one line per node, coloured by the node's position in `nodes`.
 */
export function HostCharts({
	data,
	nodes,
	range,
	empty,
}: {
	data: HostMetrics | undefined;
	nodes: ClusterNode[] | undefined;
	range: MetricRange;
	empty: string;
}) {
	const perNode =
		!!data && data.series.length > 1 && data.series.some((s) => s.nodeId);
	const order = new Map((nodes ?? []).map((n, i) => [n.id, i]));
	const nodeSeries: ChartSeries[] = perNode
		? data.series
				.map((s) => {
					const key = s.nodeId ?? "";
					const i = order.get(key) ?? order.size;
					return { key, i, label: nodes?.[i]?.hostname ?? "Unknown node" };
				})
				.sort((a, b) => a.i - b.i)
				.map(({ i, ...s }) => ({ ...s, color: seriesColor(i) }))
		: [];
	const input = perNode
		? data.series.map((s) => ({ key: s.nodeId ?? "", points: s.points }))
		: [{ key: "v", points: data?.series[0]?.points ?? [] }];
	const window = data && { from: data.from, to: data.to };
	const rowsFor = (value: (p: HostPoint) => number | null) =>
		data && toRows(input, value, data.stepSec);
	const last = data?.series[0]?.points.at(-1);
	const hasTemp = !!data?.series.some((s) =>
		s.points.some((p) => typeof p.temp === "number"),
	);
	/** In/out pairs for one host; one summed line per node otherwise. */
	const pairRows = (a: "rx" | "diskRead", b: "tx" | "diskWrite") =>
		data &&
		(perNode
			? toRows(input, (p) => sum(p[a] ?? null, p[b] ?? null), data.stepSec)
			: toRows(
					[a, b].map((key) => ({ key, points: input[0]?.points ?? [] })),
					(p, key) => p[key as typeof a] ?? null,
					data.stepSec,
				));

	return (
		<div className="grid gap-4 md:grid-cols-2">
			{PERCENT.map((m) => (
				<MetricChart
					key={m.id}
					title={m.title}
					rows={rowsFor(m.value)}
					series={
						perNode
							? nodeSeries
							: [{ key: "v", label: m.title, color: seriesColor(0) }]
					}
					format={m.format}
					domain={m.domain}
					range={range}
					window={window}
					empty={empty}
					showLatest={!perNode}
					detail={last && m.detail?.(last)}
				/>
			))}
			<MetricChart
				title="Network"
				rows={
					data &&
					(perNode
						? toRows(input, (p) => sum(p.rx, p.tx), data.stepSec)
						: toRows(
								["rx", "tx"].map((key) => ({
									key,
									points: input[0]?.points ?? [],
								})),
								(p, key) => (key === "rx" ? p.rx : p.tx),
								data.stepSec,
							))
				}
				series={
					perNode
						? nodeSeries
						: [
								{ key: "rx", label: "In", color: seriesColor(0) },
								{ key: "tx", label: "Out", color: seriesColor(1) },
							]
				}
				format={formatRate}
				axisFormat={(v) => formatRate(v, true)}
				range={range}
				window={window}
				empty={empty}
				showLatest={!perNode}
				detail={last && `out ${formatRate(last.tx)}`}
			/>
			<MetricChart
				title="Disk I/O"
				rows={pairRows("diskRead", "diskWrite")}
				series={
					perNode
						? nodeSeries
						: [
								{ key: "diskRead", label: "Read", color: seriesColor(0) },
								{ key: "diskWrite", label: "Write", color: seriesColor(1) },
							]
				}
				format={formatRate}
				axisFormat={(v) => formatRate(v, true)}
				range={range}
				window={window}
				empty="No disk I/O reported yet: the node's agent predates it."
				showLatest={!perNode}
				detail={last && `write ${formatRate(last.diskWrite)}`}
			/>
			{hasTemp && (
				<MetricChart
					title="Temperature"
					rows={rowsFor((p) => p.temp ?? null)}
					series={
						perNode
							? nodeSeries
							: [{ key: "v", label: "Hottest sensor", color: seriesColor(0) }]
					}
					format={(v) => `${Math.round(v)} °C`}
					range={range}
					window={window}
					empty={empty}
					showLatest={!perNode}
					detail="hottest sensor"
				/>
			)}
		</div>
	);
}
