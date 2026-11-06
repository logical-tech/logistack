import { usageRanges } from "@logistack/contracts";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { MetricChart, seriesColor } from "@/components/charts/metric-chart";
import { Segmented } from "@/components/segmented";
import type {
	OrganizationUsage,
	UsageFigures,
	UsagePoint,
	UsageRange,
} from "@/lib/api/types";
import { formatBytes, formatRate, toRows } from "@/lib/metrics";
import { cn } from "@/lib/utils";

const RANGE_LABEL: Record<UsageRange, string> = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
};

export function UsageRangePicker({
	value,
	onChange,
}: {
	value: UsageRange;
	onChange: (r: UsageRange) => void;
}) {
	return (
		<Segmented
			label="Time range"
			value={value}
			onChange={onChange}
			options={usageRanges.map((r) => ({
				value: r,
				label: r,
				ariaLabel: RANGE_LABEL[r],
			}))}
		/>
	);
}

export const formatCores = (n: number) =>
	n === 0 ? "0" : n < 0.01 ? "<0.01" : n.toFixed(2);

type Capacity = NonNullable<OrganizationUsage["capacity"]>;

function Tile({
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

/** Window averages for CPU and memory, bytes moved, current volume size; capacity when known. */
export function UsageTiles({
	totals,
	capacity,
}: {
	totals: UsageFigures | undefined;
	capacity?: Capacity | null;
}) {
	const loading = !totals;
	const t = totals ?? { cpu: 0, memUsed: 0, rx: 0, tx: 0, disk: null };
	const of = (used: number, total: number | undefined) =>
		total
			? `${Math.round((used / total) * 100)}% of ${formatBytes(total)}`
			: undefined;
	return (
		<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<Tile
				label="CPU, average"
				loading={loading}
				value={
					<>
						{formatCores(t.cpu)}
						<span className="text-xs font-normal text-muted-foreground">
							cores
						</span>
					</>
				}
				detail={
					capacity?.cpus
						? `${Math.round((t.cpu / capacity.cpus) * 100)}% of ${capacity.cpus} cores`
						: undefined
				}
			/>
			<Tile
				label="Memory, average"
				loading={loading}
				value={formatBytes(t.memUsed)}
				detail={of(t.memUsed, capacity?.memory)}
			/>
			<Tile
				label="Network"
				loading={loading}
				value={formatBytes(t.rx + t.tx)}
				detail={`${formatBytes(t.rx)} in · ${formatBytes(t.tx)} out`}
			/>
			<Tile
				label="Volumes, now"
				loading={loading}
				value={formatBytes(t.disk)}
				detail={
					t.disk === null
						? "No node reported volume sizes"
						: of(t.disk, capacity?.disk)
				}
			/>
		</div>
	);
}

/** CPU, memory and network per step for the summed scope. */
export function UsageTrend({
	data,
	range,
}: {
	data:
		| { trend: UsagePoint[]; stepSec: number; from: number; to: number }
		| undefined;
	range: UsageRange;
}) {
	const rows = (keys: (keyof Omit<UsagePoint, "t">)[]) =>
		data &&
		toRows(
			keys.map((k) => ({ key: k, points: data.trend })),
			(p, k) => p[k as keyof Omit<UsagePoint, "t">],
			data.stepSec,
		);
	const common = {
		range,
		window: data,
		showLatest: false,
		empty: "No samples in this range yet.",
	};
	return (
		<div className="grid gap-4 lg:grid-cols-3">
			<MetricChart
				{...common}
				title="CPU (cores)"
				rows={rows(["cpu"])}
				series={[{ key: "cpu", label: "CPU", color: seriesColor(0) }]}
				format={formatCores}
			/>
			<MetricChart
				{...common}
				title="Memory"
				rows={rows(["memUsed"])}
				series={[{ key: "memUsed", label: "Memory", color: seriesColor(0) }]}
				format={(v) => formatBytes(v)}
				axisFormat={(v) => formatBytes(v, true)}
			/>
			<MetricChart
				{...common}
				title="Network"
				rows={rows(["rx", "tx"])}
				series={[
					{ key: "rx", label: "In", color: seriesColor(0) },
					{ key: "tx", label: "Out", color: seriesColor(1) },
				]}
				format={(v) => formatRate(v)}
				axisFormat={(v) => formatRate(v, true)}
			/>
		</div>
	);
}

export type UsageRow = UsageFigures & {
	id: string;
	/** The row's link or label. */
	name: ReactNode;
	sortName: string;
	/** Nested rows (an environment's services), sorted with the same key. */
	children?: UsageRow[];
};

type SortKey = "name" | "cpu" | "memUsed" | "net" | "disk";

const value = (r: UsageRow, k: SortKey): number | string =>
	k === "name"
		? r.sortName.toLowerCase()
		: k === "net"
			? r.rx + r.tx
			: k === "disk"
				? (r.disk ?? -1)
				: r[k];

function sortRows(rows: UsageRow[], key: SortKey, desc: boolean): UsageRow[] {
	const dir = desc ? -1 : 1;
	return [...rows]
		.sort((a, b) => {
			const x = value(a, key);
			const y = value(b, key);
			return (x < y ? -1 : x > y ? 1 : 0) * dir;
		})
		.map((r) =>
			r.children ? { ...r, children: sortRows(r.children, key, desc) } : r,
		);
}

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
	{ key: "name", label: "Name" },
	{ key: "cpu", label: "CPU, avg", className: "w-36" },
	{ key: "memUsed", label: "Memory, avg", className: "w-32" },
	{ key: "net", label: "Network in / out", className: "w-48 max-md:hidden" },
	{ key: "disk", label: "Volumes", className: "w-28 max-sm:hidden" },
];

/** Sortable consumers table; the CPU bar is each row's share of the largest row at its level. */
export function UsageTable({
	label,
	rows,
	empty,
}: {
	label: string;
	rows: UsageRow[] | undefined;
	empty: string;
}) {
	const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
		key: "cpu",
		desc: true,
	});
	const sorted = rows && sortRows(rows, sort.key, sort.desc);
	const maxCpu = (rs: UsageRow[]) => Math.max(...rs.map((r) => r.cpu), 0);

	const row = (r: UsageRow, peak: number, depth: number, group: boolean) => (
		<tr
			key={r.id}
			className={cn(
				"border-b last:border-0",
				group ? "bg-muted/40 dark:bg-muted/20" : "hover:bg-muted/50",
				"transition-colors duration-(--duration-quick)",
			)}
		>
			<th
				scope="row"
				className={cn(
					"h-11 truncate px-4 text-left align-middle",
					group ? "font-medium" : "font-normal",
					depth > 0 && "pl-8",
				)}
			>
				{r.name}
			</th>
			<td className="px-4 align-middle tabular">
				<span className="block">{formatCores(r.cpu)}</span>
				{!group && (
					<span
						aria-hidden
						className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
					>
						<span
							className="block h-full rounded-full"
							style={{
								width: `${peak > 0 ? (r.cpu / peak) * 100 : 0}%`,
								background: seriesColor(0),
							}}
						/>
					</span>
				)}
			</td>
			<td className="px-4 align-middle tabular">{formatBytes(r.memUsed)}</td>
			<td className="px-4 align-middle tabular max-md:hidden">
				{formatBytes(r.rx)}
				<span className="text-muted-foreground"> / </span>
				{formatBytes(r.tx)}
			</td>
			<td className="px-4 align-middle tabular max-sm:hidden">
				{formatBytes(r.disk)}
			</td>
		</tr>
	);

	return (
		<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
			<table className="w-full table-fixed text-sm" aria-label={label}>
				<thead>
					<tr className="border-b">
						{COLUMNS.map((c) => {
							const active = sort.key === c.key;
							const Icon = !active
								? ChevronsUpDown
								: sort.desc
									? ArrowDown
									: ArrowUp;
							return (
								<th
									key={c.key}
									scope="col"
									aria-sort={
										active ? (sort.desc ? "descending" : "ascending") : "none"
									}
									className={cn(
										"h-9 px-2 text-left text-xs font-medium text-muted-foreground",
										c.className,
									)}
								>
									<button
										type="button"
										onClick={() =>
											setSort({
												key: c.key,
												desc: active ? !sort.desc : c.key !== "name",
											})
										}
										className={cn(
											"inline-flex h-7 items-center gap-1 rounded-md px-2 outline-none transition-colors duration-(--duration-quick) hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
											active && "text-foreground",
										)}
									>
										{c.label}
										<Icon
											aria-hidden
											className={cn("size-3", !active && "opacity-50")}
										/>
									</button>
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>
					{!sorted ? (
						[0, 1, 2].map((i) => (
							<tr key={i} className="border-b last:border-0" aria-hidden>
								<td colSpan={COLUMNS.length} className="h-11 px-4">
									<span className="t-skel block h-4 w-2/3 rounded bg-muted-foreground/10" />
								</td>
							</tr>
						))
					) : sorted.length === 0 ? (
						<tr>
							<td
								colSpan={COLUMNS.length}
								className="h-20 px-4 text-center text-sm text-muted-foreground"
							>
								{empty}
							</td>
						</tr>
					) : (
						sorted.map((r) =>
							r.children ? (
								<Fragment key={r.id}>
									{row(r, 0, 0, true)}
									{r.children.map((c) =>
										row(c, maxCpu(r.children ?? []), 1, false),
									)}
								</Fragment>
							) : (
								row(r, maxCpu(sorted), 0, false)
							),
						)
					)}
				</tbody>
			</table>
		</div>
	);
}
