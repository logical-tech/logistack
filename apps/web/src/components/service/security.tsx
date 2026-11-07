import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import {
	ArrowUpRight,
	RotateCw,
	ShieldAlert,
	ShieldCheck,
	ShieldQuestion,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { StatusDot, StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import type { ProjectId, ServiceId } from "@/lib/api/types";
import {
	type Finding,
	useRescan,
	type VulnerabilitiesView,
	vulnerabilitiesQuery,
} from "@/lib/api/vulnerabilities";
import { relativeTime } from "@/lib/format";
import { type Severity, TONE_TEXT, VULN_SEVERITY } from "@/lib/status";
import { cn } from "@/lib/utils";

const ORDER: Severity[] = ["critical", "high", "medium", "low", "unknown"];

const col = createColumnHelper<BaseFeatures, Finding>();

const columns = col.columns([
	col.display({
		id: "severity",
		header: "Severity",
		meta: { className: "w-[16%] max-md:w-[30%]" },
		cell: ({ row: { original: f } }) => (
			<StatusLabel meta={VULN_SEVERITY[f.severity]} />
		),
	}),
	col.display({
		id: "vulnerability",
		header: "Vulnerability",
		meta: { className: "w-[40%] max-md:w-[70%]" },
		cell: ({ row: { original: f } }) => (
			<div className="min-w-0 py-1.5">
				{f.url ? (
					<a
						href={f.url}
						target="_blank"
						rel="noreferrer"
						className="group inline-flex items-center gap-1 font-mono text-xs text-foreground underline-offset-4 hover:underline"
					>
						{f.id}
						<ArrowUpRight
							className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-(--duration-quick) group-hover:opacity-100"
							aria-hidden
						/>
					</a>
				) : (
					<span className="font-mono text-xs">{f.id}</span>
				)}
				{f.title && (
					<span className="block truncate text-xs text-muted-foreground">
						{f.title}
					</span>
				)}
			</div>
		),
	}),
	col.display({
		id: "package",
		header: "Package",
		meta: { className: "w-[24%] max-md:hidden" },
		cell: ({ row: { original: f } }) => (
			<div className="min-w-0">
				<span className="block truncate">{f.pkgName}</span>
				<span className="block truncate font-mono text-xs text-muted-foreground">
					{f.installedVersion}
				</span>
			</div>
		),
	}),
	col.display({
		id: "fixed",
		header: "Fixed in",
		meta: { className: "w-[20%] max-md:hidden" },
		cell: ({ row: { original: f } }) =>
			f.fixedVersion ? (
				<span className="block truncate font-mono text-xs">
					{f.fixedVersion}
				</span>
			) : (
				<span className="text-muted-foreground">No fix yet</span>
			),
	}),
]);

/** Counts per severity in one row; the worst non-zero ones carry their colour. */
function Counts({
	counts,
}: {
	counts: NonNullable<VulnerabilitiesView["counts"]>;
}) {
	// Unknown is rare; it takes a column only when there is something in it.
	const shown = ORDER.filter((s) => s !== "unknown" || counts.unknown > 0);
	return (
		<dl
			className="grid divide-x border-t"
			style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
		>
			{shown.map((s) => {
				const n = counts[s];
				const meta = VULN_SEVERITY[s];
				return (
					<div key={s} className="min-w-0 px-3 py-3 sm:px-4">
						<dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<StatusDot meta={meta} className={n ? undefined : "opacity-40"} />
							{meta.label}
						</dt>
						<dd
							className={cn(
								"mt-1 text-lg font-semibold tabular",
								n === 0 && "text-muted-foreground",
								n > 0 && meta.tone !== "idle" && TONE_TEXT[meta.tone],
							)}
						>
							{n}
						</dd>
					</div>
				);
			})}
		</dl>
	);
}

function ScanState({ v }: { v: VulnerabilitiesView }) {
	if (v.status === "running")
		return (
			<StatusLabel meta={{ label: "Scanning", tone: "busy", live: true }} />
		);
	if (v.status === "failed")
		return (
			<StatusLabel
				meta={{ label: "Last scan failed", tone: "bad" }}
				suffix={
					v.scannedAt ? `results from ${relativeTime(v.scannedAt)}` : undefined
				}
			/>
		);
	return (
		<span className="text-sm text-muted-foreground">
			Scanned {v.scannedAt ? relativeTime(v.scannedAt) : "never"}
		</span>
	);
}

export function SecurityPanel({ serviceId }: { serviceId: ServiceId }) {
	const { data: v, isPending } = useQuery(vulnerabilitiesQuery(serviceId));
	const rescan = useRescan(serviceId);
	const [filter, setFilter] = useState<"all" | "fixable">("all");
	const running = v?.status === "running";
	const scanButton = (
		<Button
			variant="outline"
			size="sm"
			disabled={running || rescan.isPending}
			onClick={() =>
				rescan.mutate(undefined, {
					onError: (e) =>
						toast.error("Couldn't start a scan", {
							description: e instanceof Error ? e.message : undefined,
						}),
				})
			}
		>
			<RotateCw
				data-icon="inline-start"
				className={cn(running && "animate-spin")}
			/>
			{running ? "Scanning" : "Scan now"}
		</Button>
	);

	if (isPending)
		return (
			<Panel title="Image scan">
				<SkeletonRows rows={3} />
			</Panel>
		);
	if (!v?.digest)
		return (
			<EmptyState
				icon={ShieldQuestion}
				title="Not scanned yet"
				description="The image this service runs is checked for known vulnerabilities after each deployment and once a day. Deploy it to run the first scan."
			/>
		);

	const findings =
		filter === "fixable"
			? v.findings.filter((f) => f.fixedVersion)
			: v.findings;
	const fixable = v.findings.filter((f) => f.fixedVersion).length;

	return (
		<div className="flex flex-col gap-8">
			<Panel title="Image scan" actions={scanButton}>
				<div className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
					<div className="min-w-0">
						<p className="truncate font-mono text-sm">{v.image}</p>
						<p
							className="truncate font-mono text-xs text-muted-foreground"
							title={v.digest}
						>
							{v.digest.slice(0, 19)}
						</p>
					</div>
					<ScanState v={v} />
				</div>
				{v.status === "failed" && v.error && (
					<p className="border-t px-4 py-3 font-mono text-xs break-words text-bad-text">
						{v.error}
					</p>
				)}
				{v.counts && <Counts counts={v.counts} />}
			</Panel>

			{v.counts &&
				(v.findings.length === 0 ? (
					<EmptyState
						icon={ShieldCheck}
						title="No known vulnerabilities"
						description="Trivy found nothing in this image's packages at the last scan. It checks again daily as new advisories come out."
					/>
				) : (
					<Panel
						title="Findings"
						actions={
							<Segmented
								label="Show findings"
								value={filter}
								onChange={setFilter}
								options={[
									{ value: "all", label: `All ${v.findings.length}` },
									{ value: "fixable", label: `Fixable ${fixable}` },
								]}
							/>
						}
					>
						<DataTable
							label="Vulnerabilities"
							columns={columns}
							data={findings}
							getRowId={(f) => `${f.id}:${f.pkgName}:${f.installedVersion}`}
							empty={
								<span className="text-sm text-muted-foreground">
									None of these has a fixed version yet.
								</span>
							}
						/>
					</Panel>
				))}
		</div>
	);
}

const BADGE = {
	critical: { icon: ShieldAlert, tone: "bad" },
	high: { icon: ShieldAlert, tone: "warn" },
	low: { icon: ShieldCheck, tone: null },
	clean: { icon: ShieldCheck, tone: null },
} as const;

/** The header's one-line security status, linking to the Security tab. */
export function VulnerabilityBadge({
	serviceId,
	projectId,
}: {
	serviceId: ServiceId;
	projectId: ProjectId;
}) {
	const { data: v } = useQuery(vulnerabilitiesQuery(serviceId));
	if (!v?.badge || !v.counts) return null;
	const b = BADGE[v.badge];
	const label =
		v.badge === "critical"
			? `${v.counts.critical} critical`
			: v.badge === "high"
				? `${v.counts.high} high`
				: v.badge === "low"
					? "Low risk"
					: "No known vulnerabilities";
	return (
		<Link
			to="/projects/$projectId/services/$serviceId/security"
			params={{ projectId, serviceId }}
			className={cn(
				"inline-flex items-center gap-1 underline-offset-4 hover:underline",
				b.tone ? TONE_TEXT[b.tone] : "text-foreground",
			)}
		>
			<b.icon className="size-3.5" aria-hidden />
			{label}
		</Link>
	);
}
