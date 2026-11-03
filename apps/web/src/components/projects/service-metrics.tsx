import type { MetricRange } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MetricChart, seriesColor } from "@/components/charts/metric-chart";
import { RangePicker } from "@/components/monitoring/host-charts";
import { serviceMetricsQuery } from "@/lib/api/monitoring";
import type { ContainerPoint, ServiceId } from "@/lib/api/types";
import { formatBytes, formatPct, formatRate, toRows } from "@/lib/metrics";

const EMPTY = "No samples yet: no container of this service has reported.";

/** Replicas summed across nodes: CPU (100% is one core), memory against its limit, network, block I/O. */
export function ServiceMetrics({ serviceId }: { serviceId: ServiceId }) {
	const [range, setRange] = useState<MetricRange>("24h");
	const { data } = useQuery(serviceMetricsQuery(serviceId, range));
	const window = data && { from: data.from, to: data.to };
	const rows = (keys: (keyof ContainerPoint)[]) =>
		data &&
		toRows(
			keys.map((key) => ({ key, points: data.points })),
			(p, key) => p[key as keyof ContainerPoint],
			data.stepSec,
		);
	const last = data?.points.at(-1);
	const shared = { range, window, empty: EMPTY, height: 150 };

	return (
		<div className="grid gap-4 md:grid-cols-2">
			<div className="flex items-center justify-between gap-3 md:col-span-2">
				<p className="text-sm text-muted-foreground">
					Summed across every replica
				</p>
				<RangePicker value={range} onChange={setRange} />
			</div>
			<MetricChart
				{...shared}
				title="CPU"
				rows={rows(["cpu"])}
				series={[{ key: "cpu", label: "CPU", color: seriesColor(0) }]}
				format={formatPct}
				detail="100% is one core"
			/>
			<MetricChart
				{...shared}
				title="Memory"
				rows={rows(["memUsed", "memLimit"])}
				series={[
					{ key: "memUsed", label: "Used", color: seriesColor(0) },
					{
						key: "memLimit",
						label: "Limit",
						color: "var(--muted-foreground)",
						dashed: true,
					},
				]}
				format={formatBytes}
				axisFormat={(v) => formatBytes(v, true)}
				detail={
					last?.memLimit
						? `of ${formatBytes(last.memLimit)} limit`
						: "no limit set"
				}
			/>
			<MetricChart
				{...shared}
				title="Network"
				rows={rows(["rx", "tx"])}
				series={[
					{ key: "rx", label: "In", color: seriesColor(0) },
					{ key: "tx", label: "Out", color: seriesColor(1) },
				]}
				format={formatRate}
				axisFormat={(v) => formatRate(v, true)}
				detail={last && `out ${formatRate(last.tx)}`}
			/>
			<MetricChart
				{...shared}
				title="Block I/O"
				rows={rows(["read", "write"])}
				series={[
					{ key: "read", label: "Read", color: seriesColor(0) },
					{ key: "write", label: "Write", color: seriesColor(1) },
				]}
				format={formatRate}
				axisFormat={(v) => formatRate(v, true)}
				detail={last && `write ${formatRate(last.write)}`}
			/>
			<MetricChart
				{...shared}
				title="Replicas reporting"
				rows={rows(["containers"])}
				series={[
					{ key: "containers", label: "Replicas", color: seriesColor(0) },
				]}
				format={(v) => String(Math.round(v))}
				curve="step"
			/>
		</div>
	);
}
