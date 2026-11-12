import {
	type HomeDns,
	type HomeDnsStats,
	HomeDnsStatsRange,
	type MetricRange,
} from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { MetricChart, seriesColor } from "@/components/charts/metric-chart";
import { CopyButton } from "@/components/copy-button";
import {
	DomainActions,
	HomeDnsPage,
	homeDnsMeta,
} from "@/components/network/home-dns";
import { Panel, SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { StatusLabel } from "@/components/status";
import { homeDnsStatsQuery } from "@/lib/api/home-dns";
import { formatCount } from "@/lib/metrics";
import { cn } from "@/lib/utils";

const Range = HomeDnsStatsRange.exclude(["year"]);
type Range = z.infer<typeof Range>;

export const Route = createFileRoute("/_app/network_/dns")({
	staticData: { crumb: "Home network" },
	validateSearch: z.object({ range: Range.optional().catch(undefined) }),
	component: Overview,
});

const RANGES: { value: Range; label: string; chart: MetricRange }[] = [
	{ value: "hour", label: "Hour", chart: "1h" },
	{ value: "day", label: "Day", chart: "24h" },
	{ value: "week", label: "Week", chart: "7d" },
	{ value: "month", label: "Month", chart: "30d" },
];

const SERIES = [
	{ key: "total", label: "Queries", from: "Total", color: seriesColor(0) },
	{ key: "cached", label: "Cached", from: "Cached", color: seriesColor(3) },
	{ key: "blocked", label: "Blocked", from: "Blocked", color: "var(--bad)" },
];

const full = (n: number) => n.toLocaleString("en");
const pct = (part: number, of: number) =>
	of ? `${((part / of) * 100).toFixed(1)}%` : "0%";

function Overview() {
	const { range = "day" } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<HomeDnsPage
			to="/network/dns"
			title="Home network"
			needsReady={false}
			actions={(dns) =>
				dns.status === "ready" && (
					<Segmented
						label="Range"
						value={range}
						onChange={(r) => navigate({ search: { range: r }, replace: true })}
						options={RANGES}
					/>
				)
			}
		>
			{(dns) => (
				<div className="grid gap-8">
					<StatusPanel dns={dns} />
					{dns.status === "ready" ? (
						<Dashboard range={range} />
					) : (
						<p className="rounded-xl bg-muted/60 px-4 py-10 text-center text-sm text-muted-foreground dark:bg-muted/40">
							{dns.status === "stopped"
								? "Stopped. Start it in Settings to see traffic again."
								: "Numbers appear here once Technitium answers."}
						</p>
					)}
				</div>
			)}
		</HomeDnsPage>
	);
}

function StatusPanel({ dns }: { dns: HomeDns }) {
	return (
		<section
			aria-label="Home DNS status"
			className="rounded-xl bg-card p-4 shadow-card ring-1 ring-border"
		>
			<dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
				<div className="min-w-0">
					<dt className="text-xs text-muted-foreground">Status</dt>
					<dd className="mt-1">
						<StatusLabel meta={homeDnsMeta(dns)} />
					</dd>
				</div>
				<div className="min-w-0">
					<dt className="text-xs text-muted-foreground">DNS server address</dt>
					<dd className="mt-0.5 flex items-center gap-1">
						<span className="truncate font-mono text-sm">{dns.lanAddress}</span>
						{dns.lanAddress && (
							<CopyButton value={dns.lanAddress} label="Copy address" />
						)}
					</dd>
				</div>
				<div className="min-w-0">
					<dt className="text-xs text-muted-foreground">Node</dt>
					<dd className="mt-1 truncate text-sm">{dns.nodeHostname ?? "–"}</dd>
				</div>
				<div className="min-w-0">
					<dt className="text-xs text-muted-foreground">Technitium</dt>
					<dd className="mt-1 truncate font-mono text-sm tabular">
						{dns.version ?? "–"}
					</dd>
				</div>
			</dl>
			{dns.statusMessage && (
				<p
					className={cn(
						"mt-4 border-t pt-3 text-sm text-pretty",
						dns.status === "error" ? "text-bad-text" : "text-muted-foreground",
					)}
				>
					{dns.statusMessage}
				</p>
			)}
		</section>
	);
}

function Dashboard({ range }: { range: Range }) {
	const { data, isError, error } = useQuery(homeDnsStatsQuery(range));
	const chartRange = RANGES.find((r) => r.value === range)?.chart ?? "24h";
	const rows = data?.chart.labels.map((label, i) => {
		const row: { t: number; [k: string]: number | null } = {
			t: Date.parse(label),
		};
		for (const s of SERIES)
			row[s.key] =
				data.chart.series.find((x) => x.label === s.from)?.data[i] ?? null;
		return row;
	});
	const window =
		rows && rows.length > 1
			? { from: rows[0]?.t ?? 0, to: rows.at(-1)?.t ?? 0 }
			: undefined;
	if (isError)
		return (
			<p className="rounded-xl bg-muted/60 px-4 py-10 text-center text-sm text-bad-text dark:bg-muted/40">
				{error.message}
			</p>
		);
	const t = data?.totals;
	return (
		<div className="grid gap-8">
			<dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Kpi label="Queries" value={t && full(t.queries)} />
				<Kpi
					label="Blocked"
					value={t && full(t.blocked)}
					detail={t && pct(t.blocked, t.queries)}
				/>
				<Kpi
					label="From cache"
					value={t && full(t.cached)}
					detail={t && pct(t.cached, t.queries)}
				/>
				<Kpi label="Devices" value={t && full(t.clients)} />
			</dl>
			<MetricChart
				title="Queries over time"
				rows={rows}
				series={SERIES}
				format={full}
				axisFormat={formatCount}
				range={chartRange}
				window={window}
				showLatest={false}
				empty="No queries in this range yet."
				height={220}
			/>
			<div className="grid gap-8 lg:grid-cols-3">
				<TopList
					title="Top devices"
					id="top-clients"
					items={data?.topClients}
					render={(c) => (
						<Link
							to="/network/dns/logs"
							search={{ client: c.name }}
							className="block min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span className="block truncate text-sm">
								{c.domain?.replace(/\.home\.lan$|\.lan$|\.local$/, "") ??
									c.name}
							</span>
							{c.domain && (
								<span className="block truncate font-mono text-xs text-muted-foreground">
									{c.name}
								</span>
							)}
						</Link>
					)}
				/>
				<TopList
					title="Top domains"
					id="top-domains"
					items={data?.topDomains}
					render={(d) => (
						<span className="block truncate font-mono text-xs">{d.name}</span>
					)}
					action={(d) => <DomainActions domain={d.name} />}
				/>
				<TopList
					title="Top blocked"
					id="top-blocked"
					tone="bad"
					items={data?.topBlocked}
					render={(d) => (
						<span className="block truncate font-mono text-xs">{d.name}</span>
					)}
					action={(d) => <DomainActions domain={d.name} blocked />}
				/>
			</div>
		</div>
	);
}

function Kpi({
	label,
	value,
	detail,
}: {
	label: string;
	value: string | undefined;
	detail?: string;
}) {
	return (
		<div className="rounded-xl bg-card px-4 py-3.5 shadow-card ring-1 ring-border">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-1 flex h-7 items-baseline gap-2">
				{value === undefined ? (
					<span className="t-skel inline-block h-5 w-20 self-center rounded bg-muted-foreground/15" />
				) : (
					<>
						<span className="text-xl font-semibold tabular [font-stretch:108%]">
							{value}
						</span>
						{detail && (
							<span className="text-xs text-muted-foreground tabular">
								{detail}
							</span>
						)}
					</>
				)}
			</dd>
		</div>
	);
}

type Top = HomeDnsStats["topDomains"][number];

function TopList({
	title,
	id,
	items,
	render,
	action,
	tone,
}: {
	title: string;
	id: string;
	items: Top[] | undefined;
	render: (t: Top) => React.ReactNode;
	action?: (t: Top) => React.ReactNode;
	tone?: "bad";
}) {
	const max = Math.max(1, ...(items ?? []).map((i) => i.hits));
	return (
		<Panel title={title} id={id}>
			{!items ? (
				<SkeletonRows rows={5} />
			) : items.length === 0 ? (
				<p className="px-4 py-8 text-center text-sm text-muted-foreground">
					Nothing yet in this range.
				</p>
			) : (
				<ol className="divide-y">
					{items.map((item) => (
						<li
							key={item.name}
							className="relative flex min-h-12 items-center gap-3 px-4 py-2"
						>
							<span
								aria-hidden
								className={cn(
									"absolute inset-y-1 left-0 rounded-r-sm",
									tone === "bad" ? "bg-bad/6" : "bg-muted-foreground/7",
								)}
								style={{ width: `${(item.hits / max) * 100}%` }}
							/>
							<div className="relative min-w-0 flex-1">{render(item)}</div>
							<span className="relative text-xs text-muted-foreground tabular">
								{full(item.hits)}
							</span>
							{action && <span className="relative -mr-2">{action(item)}</span>}
						</li>
					))}
				</ol>
			)}
		</Panel>
	);
}
