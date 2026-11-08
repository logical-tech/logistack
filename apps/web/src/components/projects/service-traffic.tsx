import type {
	MetricRange,
	TrafficPoint,
	TrafficReport,
} from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useState } from "react";
import { MetricChart } from "@/components/charts/metric-chart";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { RangePicker } from "@/components/monitoring/host-charts";
import { Panel, SkeletonRows } from "@/components/panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trafficQuery, useSetWebAnalytics } from "@/lib/api/traffic";
import type { ServiceId } from "@/lib/api/types";
import {
	formatBytes,
	formatCount,
	formatMs,
	formatRate,
	toRows,
} from "@/lib/metrics";
import { cn } from "@/lib/utils";

const ALL = "all";
const EMPTY = "No requests in this range.";

const formatRps = (n: number) =>
	n >= 100 ? `${Math.round(n)}/s` : `${n.toFixed(n >= 10 ? 1 : 2)}/s`;
const axisRps = (n: number) =>
	n === 0 ? "0" : `${n >= 10 ? Math.round(n) : n.toFixed(1)}/s`;

const regionName = new Intl.DisplayNames(["en"], { type: "region" });
const country = (code: string) => {
	try {
		return regionName.of(code) ?? code;
	} catch {
		return code;
	}
};

/** The headline numbers for a range, as one row of figures (not cards). */
export function StatRow({
	items,
}: {
	items: { label: string; value: string; hint?: string; tone?: "bad" }[];
}) {
	return (
		<dl className="grid grid-cols-2 overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border sm:grid-cols-3 lg:grid-cols-5">
			{items.map((s) => (
				<div
					key={s.label}
					className="border-border border-b px-4 py-3.5 sm:border-r lg:border-b-0 lg:last:border-r-0"
				>
					<dt className="text-xs text-muted-foreground">{s.label}</dt>
					<dd
						className={cn(
							"mt-1 text-xl font-semibold tabular [font-stretch:108%]",
							s.tone === "bad" && "text-bad-text",
						)}
					>
						{s.value}
					</dd>
					{s.hint && (
						<dd className="mt-0.5 truncate text-xs text-muted-foreground tabular">
							{s.hint}
						</dd>
					)}
				</div>
			))}
		</dl>
	);
}

/** A ranked list with a proportional bar behind each row, widest first. */
function Ranked({
	title,
	rows,
	label = (k) => k,
	mono = false,
	empty,
	footer,
}: {
	title: string;
	rows: { key: string; count: number }[] | undefined;
	label?: (key: string) => string;
	mono?: boolean;
	empty: string;
	footer?: React.ReactNode;
}) {
	const max = rows?.[0]?.count ?? 0;
	return (
		<Panel title={title}>
			{!rows ? (
				<SkeletonRows rows={5} />
			) : rows.length === 0 ? (
				<p className="px-4 py-8 text-center text-xs text-muted-foreground">
					{empty}
				</p>
			) : (
				<ol className="grid gap-px p-1.5">
					{rows.slice(0, 10).map((r) => (
						<li
							key={r.key}
							className="relative flex h-8 items-center gap-3 overflow-hidden rounded-md px-2.5 text-sm"
						>
							<span
								aria-hidden
								className="absolute inset-y-0 left-0 rounded-md bg-muted"
								style={{ width: `${max ? (r.count / max) * 100 : 0}%` }}
							/>
							<span
								className={cn(
									"relative min-w-0 truncate",
									mono && "font-mono text-xs",
								)}
								title={r.key}
							>
								{label(r.key)}
							</span>
							<span className="relative ml-auto text-xs text-muted-foreground tabular">
								{formatCount(r.count)}
							</span>
						</li>
					))}
				</ol>
			)}
			{footer}
		</Panel>
	);
}

/** Request rate split by status class, latency percentiles, bandwidth, pageviews. */
export function TrafficCharts({
	range,
	step,
	series,
}: {
	range: MetricRange;
	step: number | undefined;
	series: TrafficPoint[] | undefined;
}) {
	const window = series?.length
		? { from: series[0]?.t ?? 0, to: series.at(-1)?.t ?? 0 }
		: undefined;
	const rows = (
		keys: string[],
		value: (p: TrafficPoint, k: string) => number | null,
	) =>
		series && step
			? toRows(
					keys.map((key) => ({ key, points: series })),
					value,
					step,
				)
			: undefined;
	const perSec = (p: TrafficPoint, k: string) =>
		Number(p[k as keyof TrafficPoint] ?? 0) / (step ?? 60);
	const shared = { range, window, empty: EMPTY, height: 150 };
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<MetricChart
				{...shared}
				title="Requests"
				rows={rows(["s2", "s3", "s4", "s5"], perSec)}
				series={[
					{ key: "s2", label: "2xx", color: "var(--ok)" },
					{ key: "s3", label: "3xx", color: "var(--info)" },
					{ key: "s4", label: "4xx", color: "var(--warn)" },
					{ key: "s5", label: "5xx", color: "var(--bad)" },
				]}
				format={formatRps}
				axisFormat={axisRps}
				detail="2xx per second"
			/>
			<MetricChart
				{...shared}
				title="Latency"
				rows={rows(["p50", "p95", "p99"], (p, k) => p[k as "p50"])}
				series={[
					{ key: "p50", label: "p50", color: "var(--chart-1)" },
					{ key: "p95", label: "p95", color: "var(--chart-3)" },
					{
						key: "p99",
						label: "p99",
						color: "var(--muted-foreground)",
						dashed: true,
					},
				]}
				format={formatMs}
				axisFormat={(v) => (v === 0 ? "0" : formatMs(v))}
				detail="p50, time to the last byte"
			/>
			<MetricChart
				{...shared}
				title="Bandwidth out"
				rows={rows(["bytesOut"], perSec)}
				series={[{ key: "bytesOut", label: "Out", color: "var(--chart-1)" }]}
				format={formatRate}
				axisFormat={(v) => formatRate(v, true)}
			/>
			<MetricChart
				{...shared}
				title="Pageviews"
				rows={rows(["pageviews"], (p) => p.pageviews)}
				series={[
					{ key: "pageviews", label: "Pageviews", color: "var(--chart-1)" },
				]}
				format={(v) => formatCount(Math.round(v))}
				detail={`per ${step && step >= 3600 ? `${step / 3600} h` : `${(step ?? 60) / 60} min`}`}
			/>
		</div>
	);
}

function WebAnalytics({ report }: { report: TrafficReport }) {
	const set = useSetWebAnalytics();
	return (
		<Panel title="Web analytics script">
			<div className="divide-y">
				<p className="px-4 py-3 text-xs text-pretty text-muted-foreground">
					Optional. The proxy serves an 800-byte script on your own domain that
					counts pageviews, referrers, UTM sources and{" "}
					<code className="font-mono">lsa("event")</code> calls. It sets no
					cookies and stores nothing in the browser.
				</p>
				{report.domains.map((d) => {
					const tag = `<script defer src="https://${d.hostname.replace(/\/$/, "")}/_ls/a.js"></script>`;
					return (
						<div
							key={d.id}
							className="grid grid-cols-[minmax(0,1fr)] gap-2 px-4 py-3"
						>
							<div className="flex items-center gap-3">
								<label
									htmlFor={`wa-${d.id}`}
									className="min-w-0 flex-1 truncate font-mono text-xs"
								>
									{d.hostname}
								</label>
								<Switch
									id={`wa-${d.id}`}
									checked={d.webAnalytics}
									disabled={set.isPending}
									onCheckedChange={(enabled) =>
										set.mutate({ domainId: d.id, enabled })
									}
								/>
							</div>
							{d.webAnalytics && (
								<div className="flex items-center gap-2 rounded-md bg-muted/60 py-1 pr-1 pl-2.5">
									<code className="min-w-0 flex-1 truncate font-mono text-xs">
										{tag}
									</code>
									<CopyButton value={tag} label="Copy script tag" />
								</div>
							)}
						</div>
					);
				})}
			</div>
		</Panel>
	);
}

/** Traffic from the proxy's access log; the optional script adds pageviews, UTM and events. */
export function ServiceTraffic({ serviceId }: { serviceId: ServiceId }) {
	const [range, setRange] = useState<MetricRange>("24h");
	const [domainId, setDomainId] = useState(ALL);
	const { data } = useQuery(
		trafficQuery(serviceId, range, domainId === ALL ? undefined : domainId),
	);
	const t = data?.totals;
	const rate = t?.requests ? (t.status[4] / t.requests) * 100 : null;

	if (data && data.domains.length === 0)
		return (
			<EmptyState
				icon={Activity}
				title="No domain, no traffic to show"
				description="Analytics come from the proxy's access log. Add a domain to this service and its requests show up here within two minutes."
			/>
		);

	return (
		<div className="grid gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					From the proxy's access log. No cookies, no raw IPs kept.
				</p>
				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
					{data && data.domains.length > 1 && (
						<Select value={domainId} onValueChange={setDomainId}>
							<SelectTrigger
								size="sm"
								className="min-w-0 flex-1 sm:w-52 sm:flex-none"
								aria-label="Domain"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL}>All domains</SelectItem>
								{data.domains.map((d) => (
									<SelectItem key={d.id} value={d.id}>
										{d.hostname}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<RangePicker value={range} onChange={setRange} />
				</div>
			</div>

			<StatRow
				items={[
					{
						label: "Requests",
						value: formatCount(t?.requests),
						hint: t ? `${formatCount(t.bots)} from bots` : undefined,
					},
					{
						label: "Unique visitors",
						value: formatCount(t?.visitors),
						hint: "per range, ±3%",
					},
					{
						label: "Pageviews",
						value: formatCount(t?.pageviews),
						hint: t ? `${formatBytes(t.bytesOut)} served` : undefined,
					},
					{
						label: "5xx errors",
						value:
							rate === null
								? "–"
								: `${rate < 1 && rate > 0 ? rate.toFixed(2) : rate.toFixed(1)}%`,
						hint: t ? `${formatCount(t.status[4])} responses` : undefined,
						tone: rate !== null && rate >= 1 ? "bad" : undefined,
					},
					{
						label: "Latency p95",
						value: formatMs(t?.p95),
						hint: t
							? `p50 ${formatMs(t.p50)} · p99 ${formatMs(t.p99)}`
							: undefined,
					},
				]}
			/>

			<TrafficCharts range={range} step={data?.step} series={data?.series} />

			<div className="grid gap-4 md:grid-cols-2">
				<Ranked
					title="Top paths"
					rows={data?.paths}
					mono
					empty="No requests yet."
				/>
				<Ranked
					title="Referrers"
					rows={data?.referrers}
					empty="No visits from other sites yet."
				/>
				<Ranked
					title="Countries"
					rows={data?.countries}
					label={country}
					empty="No locations yet."
					footer={
						<p className="border-t px-4 py-2 text-2xs text-muted-foreground">
							<a
								href="https://db-ip.com"
								target="_blank"
								rel="noreferrer"
								className="underline underline-offset-2 hover:text-foreground"
							>
								IP Geolocation by DB-IP
							</a>
						</p>
					}
				/>
				{(data?.utmSources.length ?? 0) > 0 ||
				(data?.events.length ?? 0) > 0 ? (
					<div className="grid gap-4">
						{(data?.utmSources.length ?? 0) > 0 && (
							<Ranked title="Campaigns" rows={data?.utmSources} empty="" />
						)}
						{(data?.events.length ?? 0) > 0 && (
							<Ranked title="Events" rows={data?.events} mono empty="" />
						)}
					</div>
				) : (
					data && <WebAnalytics report={data} />
				)}
			</div>
			{data &&
				((data.utmSources.length ?? 0) > 0 ||
					(data.events.length ?? 0) > 0) && <WebAnalytics report={data} />}
		</div>
	);
}
