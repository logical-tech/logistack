import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useState } from "react";
import { z } from "zod";
import { useAiSettings } from "@/components/ai/ai-page";
import { BudgetMeter, TierBadge, Tile } from "@/components/ai/parts";
import {
	TierLegend,
	UsageChart,
	type UsageMetric,
} from "@/components/ai/usage-chart";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { Panel } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import {
	type AiFigures,
	type AiSettings,
	type AiUsage,
	type AiUsageRange,
	aiUsageQuery,
	aiUsageRanges,
	formatCount,
	formatUsd,
} from "@/lib/api/ai";

export const Route = createFileRoute("/_app/ai/")({
	validateSearch: z.object({
		range: z.enum(aiUsageRanges).optional().catch(undefined),
	}),
	component: Overview,
});

const DEFAULT_RANGE: AiUsageRange = "30d";

const RANGE_LABEL: Record<AiUsageRange, string> = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
	"12m": "Last 12 months",
};

const tokens = (f: AiFigures) => f.inputTokens + f.outputTokens;

/** The first of next month, UTC: when caps reset. */
function resetDate() {
	const now = new Date();
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
	).toLocaleDateString("en", {
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
}

function Overview() {
	const { range = DEFAULT_RANGE } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data } = useQuery(aiUsageQuery(range));
	const settings = useAiSettings();
	return (
		<div className="grid gap-8">
			<section aria-labelledby="usage-heading" className="grid gap-4">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div className="grid gap-1">
						<h2 id="usage-heading" className="text-md font-semibold">
							{settings.canAdmin ? "Organization usage" : "Your usage"}
						</h2>
						<p className="text-sm text-pretty text-muted-foreground">
							Every request through the gateway. Free models show what the same
							tokens would have cost at market price.
						</p>
					</div>
					<Segmented
						label="Time range"
						value={range}
						onChange={(r) =>
							navigate({
								search: { range: r === DEFAULT_RANGE ? undefined : r },
								replace: true,
							})
						}
						options={aiUsageRanges.map((r) => ({
							value: r,
							label: r,
							ariaLabel: RANGE_LABEL[r],
						}))}
					/>
				</div>
				<Tiles data={data} />
				<Trend data={data} />
			</section>
			<div className="grid gap-8 lg:grid-cols-3">
				<Panel title="Top models" id="top-models" className="lg:col-span-2">
					<ModelTable data={data} />
				</Panel>
				<MyBudget settings={settings} />
			</div>
			{settings.canAdmin && (
				<Panel title="By member" id="by-member">
					<MemberTable data={data} />
				</Panel>
			)}
		</div>
	);
}

function Tiles({ data }: { data: AiUsage | undefined }) {
	const loading = !data;
	const t = data?.totals;
	const requests = t ? t.free.requests + t.paid.requests : 0;
	const freeShare = requests && t ? t.free.requests / requests : 0;
	return (
		<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<Tile
				label="Requests"
				loading={loading}
				value={formatCount(requests)}
				detail={
					t &&
					`${Math.round(freeShare * 100)}% on free models · ${formatCount(t.errors)} errors`
				}
			/>
			<Tile
				label="Tokens"
				loading={loading}
				value={t ? formatCount(tokens(t.free) + tokens(t.paid)) : ""}
				detail={
					t &&
					`${formatCount(t.free.inputTokens + t.paid.inputTokens)} in · ${formatCount(t.free.outputTokens + t.paid.outputTokens)} out`
				}
			/>
			<Tile
				label="Paid spend"
				loading={loading}
				value={t ? formatUsd(t.paid.cost) : ""}
				detail={t && `${formatCount(t.paid.requests)} paid requests`}
			/>
			<Tile
				label="Saved with free models"
				loading={loading}
				value={t ? formatUsd(t.free.cost) : ""}
				detail="Free tokens at market price"
			/>
		</div>
	);
}

const METRIC: Record<
	UsageMetric,
	{ label: string; format: (v: number) => string; axis?: (v: number) => string }
> = {
	requests: { label: "Requests", format: formatCount },
	tokens: { label: "Tokens", format: formatCount },
	cost: {
		label: "Cost",
		format: formatUsd,
		axis: (v) => (v >= 1 || v === 0 ? `$${Math.round(v)}` : formatUsd(v)),
	},
};

function Trend({ data }: { data: AiUsage | undefined }) {
	const [metric, setMetric] = useState<UsageMetric>("requests");
	const m = METRIC[metric];
	return (
		<figure className="min-w-0 rounded-xl bg-card p-4 shadow-card ring-1 ring-border">
			<figcaption className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
					<span className="text-sm font-medium">{m.label} over time</span>
					<TierLegend />
				</div>
				<Segmented
					label="Chart metric"
					value={metric}
					onChange={setMetric}
					options={(Object.keys(METRIC) as UsageMetric[]).map((k) => ({
						value: k,
						label: METRIC[k].label,
					}))}
				/>
			</figcaption>
			<UsageChart
				data={data}
				metric={metric}
				format={m.format}
				axisFormat={m.axis ?? m.format}
			/>
		</figure>
	);
}

type ModelRow = AiUsage["byModel"][number];
const modelCol = createColumnHelper<BaseFeatures, ModelRow>();

function ModelTable({ data }: { data: AiUsage | undefined }) {
	const rows = data?.byModel.slice(0, 8);
	const peak = Math.max(0, ...(rows ?? []).map((r) => r.requests));
	const columns = modelCol.columns([
		modelCol.display({
			id: "model",
			header: "Model",
			cell: ({ row: { original: r } }) => (
				<div className="min-w-0">
					<span className="flex min-w-0 items-center gap-2">
						<span className="truncate font-medium">{r.model}</span>
						<TierBadge tier={r.tier} />
					</span>
					<span className="block truncate text-xs text-muted-foreground">
						{r.provider}
					</span>
				</div>
			),
		}),
		modelCol.display({
			id: "requests",
			header: "Requests",
			meta: { className: "w-32" },
			cell: ({ row: { original: r } }) => (
				<div className="tabular">
					{formatCount(r.requests)}
					<span
						aria-hidden
						className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
					>
						<span
							className="block h-full rounded-full"
							style={{
								width: `${peak ? (r.requests / peak) * 100 : 0}%`,
								background:
									r.tier === "free" ? "var(--chart-1)" : "var(--chart-2)",
							}}
						/>
					</span>
				</div>
			),
		}),
		modelCol.display({
			id: "tokens",
			header: "Tokens",
			meta: { className: "w-24 max-sm:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular">{formatCount(tokens(r))}</span>
			),
		}),
		modelCol.display({
			id: "cost",
			header: "Cost",
			meta: { className: "w-24 text-right" },
			cell: ({ row: { original: r } }) =>
				r.tier === "free" ? (
					<span
						className="tabular text-muted-foreground"
						title="Free here; what the same tokens cost at market price"
					>
						<span className="sr-only">Free, worth </span>
						{formatUsd(r.cost)}
					</span>
				) : (
					<span className="tabular">{formatUsd(r.cost)}</span>
				),
		}),
	]);
	if (!rows)
		return (
			<div className="grid gap-px" aria-hidden>
				{[0, 1, 2, 3].map((i) => (
					<div key={i} className="h-12 px-4 py-4">
						<span className="t-skel block h-4 w-2/3 rounded bg-muted-foreground/10" />
					</div>
				))}
			</div>
		);
	return (
		<DataTable
			label="Top models"
			columns={columns}
			data={rows}
			getRowId={(r) => `${r.provider}/${r.model}`}
			empty={
				<span className="text-sm text-muted-foreground">
					No requests in this range.
				</span>
			}
		/>
	);
}

type MemberRow = AiUsage["byMember"][number];
const memberCol = createColumnHelper<BaseFeatures, MemberRow>();

function MemberTable({ data }: { data: AiUsage | undefined }) {
	const columns = memberCol.columns([
		memberCol.display({
			id: "name",
			header: "Member",
			cell: ({ row: { original: r } }) => (
				<span className="truncate font-medium">{r.name}</span>
			),
		}),
		memberCol.display({
			id: "requests",
			header: "Requests",
			meta: { className: "w-28" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular">
					{formatCount(r.free.requests + r.paid.requests)}
				</span>
			),
		}),
		memberCol.display({
			id: "tokens",
			header: "Tokens",
			meta: { className: "w-28 max-sm:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular">
					{formatCount(tokens(r.free) + tokens(r.paid))}
				</span>
			),
		}),
		memberCol.display({
			id: "saved",
			header: "Free value",
			meta: { className: "w-28 max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular text-muted-foreground">
					{formatUsd(r.free.cost)}
				</span>
			),
		}),
		memberCol.display({
			id: "paid",
			header: "Paid spend",
			meta: { className: "w-28 text-right" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular">{formatUsd(r.paid.cost)}</span>
			),
		}),
	]);
	if (!data)
		return <div className="t-skel h-36 bg-muted-foreground/5" aria-hidden />;
	return (
		<DataTable
			label="Usage by member"
			columns={columns}
			data={[...data.byMember].sort((a, b) => b.paid.cost - a.paid.cost)}
			getRowId={(r) => r.userId}
			empty={
				<span className="text-sm text-muted-foreground">
					Nobody called the gateway in this range.
				</span>
			}
		/>
	);
}

function MyBudget({ settings }: { settings: AiSettings }) {
	const { caps, spent } = settings.me;
	return (
		<Panel title="Your budget this month" id="my-budget">
			<div className="grid gap-5 p-4">
				<div className="grid gap-1.5">
					<span className="text-sm font-medium">Free models</span>
					<BudgetMeter tier="free" spent={spent.free} cap={caps.free} />
				</div>
				<div className="grid gap-1.5">
					<span className="text-sm font-medium">Paid models</span>
					<BudgetMeter tier="paid" spent={spent.paid} cap={caps.paid} />
				</div>
				<p className="text-xs text-pretty text-muted-foreground">
					Caps reset on {resetDate()} (UTC). Free spend is valued at market
					price, so a cap there limits volume, not a bill.
				</p>
			</div>
		</Panel>
	);
}
