import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Download, FileClock, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { AuditDrawer } from "@/components/access/audit-drawer";
import {
	ACTOR_KIND,
	absoluteTime,
	actorName,
	OUTCOME,
	OutcomeLabel,
} from "@/components/access/audit-parts";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { auditExportUrl, auditFacetsQuery, auditPage } from "@/lib/api/access";
import type { AuditEntry, AuditFilters } from "@/lib/api/access-types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const RANGES = {
	"24h": { label: "Last 24 hours", hours: 24 },
	"7d": { label: "Last 7 days", hours: 24 * 7 },
	"30d": { label: "Last 30 days", hours: 24 * 30 },
	all: { label: "All time", hours: null },
} as const;
type Range = keyof typeof RANGES;

const search = z.object({
	actor: z.string().optional().catch(undefined),
	action: z.string().optional().catch(undefined),
	resource: z.string().optional().catch(undefined),
	outcome: z.enum(["success", "denied", "error"]).optional().catch(undefined),
	range: z.enum(["24h", "7d", "30d", "all"]).optional().catch(undefined),
});
type Search = z.infer<typeof search>;

export const Route = createFileRoute("/_app/settings/audit-log")({
	validateSearch: search,
	staticData: { crumb: "Audit log" },
	component: AuditLog,
});

const ANY = "__any";

function toFilters(s: Search): AuditFilters {
	const hours = RANGES[s.range ?? "7d"].hours;
	return {
		actorId: s.actor,
		action: s.action,
		resourceType: s.resource,
		outcome: s.outcome,
		// Rounded to the minute so the query key stays stable while the page is open.
		from: hours
			? new Date(
					Math.floor(Date.now() / 60_000) * 60_000 - hours * 3_600_000,
				).toISOString()
			: undefined,
	};
}

function FilterSelect({
	label,
	value,
	onChange,
	options,
	anyLabel,
	className,
}: {
	label: string;
	value: string | undefined;
	onChange: (v: string | undefined) => void;
	options: { value: string; label: string }[];
	anyLabel: string;
	className?: string;
}) {
	return (
		<Select
			value={value ?? ANY}
			onValueChange={(v) => onChange(v === ANY ? undefined : v)}
		>
			<SelectTrigger
				aria-label={label}
				size="sm"
				className={cn(
					"w-full min-w-0 sm:w-auto",
					value && "bg-muted text-foreground dark:bg-input/50",
					className,
				)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ANY}>{anyLabel}</SelectItem>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function AuditLog() {
	const s = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const set = (patch: Partial<Search>) =>
		navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
	const filters = useMemo(() => toFilters(s), [s]);
	const { data: facets } = useQuery(auditFacetsQuery);
	const log = useInfiniteQuery({
		queryKey: ["audit", "log", filters],
		queryFn: ({ pageParam }) => auditPage(filters, pageParam, 50),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});
	const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
	const [open, setOpen] = useState<AuditEntry | null>(null);
	const filtered = Boolean(s.actor || s.action || s.resource || s.outcome);

	async function download(format: "csv" | "json") {
		try {
			const href = await auditExportUrl(filters, format);
			const a = Object.assign(document.createElement("a"), {
				href,
				download: `audit-log.${format}`,
			});
			a.click();
		} catch (err) {
			toast.error("Couldn't export the audit log", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return (
		<Page>
			<PageHeader
				title="Audit log"
				description="Every change made through the UI, the API or MCP: who made it, from where, and whether it went through. Secrets are redacted."
				actions={
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline">
								<Download data-icon="inline-start" />
								Export
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={() => download("csv")}>
								Export as CSV
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => download("json")}>
								Export as JSON
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				}
			/>

			<div
				role="toolbar"
				aria-label="Filter the audit log"
				className="mb-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
			>
				<FilterSelect
					label="Time range"
					value={s.range ?? "7d"}
					onChange={(v) => set({ range: (v as Range | undefined) ?? "all" })}
					anyLabel="All time"
					options={(["24h", "7d", "30d"] as const).map((r) => ({
						value: r,
						label: RANGES[r].label,
					}))}
				/>
				<FilterSelect
					label="Actor"
					value={s.actor}
					onChange={(actor) => set({ actor })}
					anyLabel="Anyone"
					options={(facets?.actors ?? []).map((a) => ({
						value: a.id,
						label: `${a.name ?? a.id} · ${ACTOR_KIND[a.kind]}`,
					}))}
				/>
				<FilterSelect
					label="Action"
					value={s.action}
					onChange={(action) => set({ action })}
					anyLabel="Any action"
					options={(facets?.actions ?? []).map((a) => ({ value: a, label: a }))}
				/>
				<FilterSelect
					label="Resource"
					value={s.resource}
					onChange={(resource) => set({ resource })}
					anyLabel="Any resource"
					options={(facets?.resourceTypes ?? []).map((r) => ({
						value: r,
						label: r,
					}))}
				/>
				<FilterSelect
					label="Outcome"
					value={s.outcome}
					onChange={(o) => set({ outcome: o as Search["outcome"] })}
					anyLabel="Any outcome"
					options={(["success", "denied", "error"] as const).map((o) => ({
						value: o,
						label: OUTCOME[o].label,
					}))}
				/>
				{filtered && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() =>
							set({
								actor: undefined,
								action: undefined,
								resource: undefined,
								outcome: undefined,
							})
						}
					>
						<X data-icon="inline-start" />
						Clear filters
					</Button>
				)}
			</div>

			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				{log.isPending ? (
					<SkeletonRows rows={8} />
				) : log.isError ? (
					<p className="px-4 py-10 text-center text-sm text-bad-text">
						{log.error.message}
					</p>
				) : rows.length === 0 ? (
					<EmptyState
						icon={FileClock}
						title={
							filtered
								? "Nothing matches these filters"
								: "Nothing recorded yet"
						}
						description={
							filtered
								? "Widen the time range or clear a filter."
								: "Each change made through the UI, the API or MCP is written here with secrets redacted."
						}
						className="rounded-none bg-transparent dark:bg-transparent"
					/>
				) : (
					<table className="w-full table-fixed text-sm" aria-label="Audit log">
						<thead>
							<tr className="border-b">
								<th
									scope="col"
									className="h-9 w-28 px-4 text-left text-xs font-medium text-muted-foreground"
								>
									When
								</th>
								<th
									scope="col"
									className="h-9 px-4 text-left text-xs font-medium text-muted-foreground"
								>
									Actor
								</th>
								<th
									scope="col"
									className="h-9 px-4 text-left text-xs font-medium text-muted-foreground"
								>
									Action
								</th>
								<th
									scope="col"
									className="hidden h-9 px-4 text-left text-xs font-medium text-muted-foreground md:table-cell"
								>
									Resource
								</th>
								<th
									scope="col"
									className="h-9 w-28 px-4 text-left text-xs font-medium text-muted-foreground max-sm:hidden"
								>
									Outcome
								</th>
								<th
									scope="col"
									className="hidden h-9 w-36 px-4 text-left text-xs font-medium text-muted-foreground lg:table-cell"
								>
									IP
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((e) => (
								<tr
									key={e.id}
									onClick={() => setOpen(e)}
									className="cursor-pointer border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50"
								>
									<td className="h-12 px-4 align-middle">
										<time
											dateTime={e.at}
											title={absoluteTime(e.at)}
											className="tabular text-muted-foreground"
										>
											{relativeTime(e.at)}
										</time>
									</td>
									<td className="px-4 align-middle">
										<span className="block truncate font-medium">
											{actorName(e)}
										</span>
										<span className="block truncate text-xs text-muted-foreground">
											{ACTOR_KIND[e.actorKind]}
										</span>
									</td>
									<td className="px-4 align-middle">
										{/* The row's keyboard target; the whole row is clickable with the pointer. */}
										<button
											type="button"
											onClick={(ev) => {
												ev.stopPropagation();
												setOpen(e);
											}}
											className="block max-w-full truncate rounded-sm text-left font-mono text-xs outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
										>
											{e.action}
										</button>
										<span className="mt-0.5 block sm:hidden">
											<OutcomeLabel outcome={e.outcome} />
										</span>
									</td>
									<td className="hidden px-4 align-middle md:table-cell">
										<span className="block truncate">{e.resourceType}</span>
										{e.resourceId && (
											<span className="block truncate font-mono text-xs text-muted-foreground">
												{e.resourceId}
											</span>
										)}
									</td>
									<td className="px-4 align-middle max-sm:hidden">
										<OutcomeLabel outcome={e.outcome} />
									</td>
									<td className="hidden px-4 align-middle lg:table-cell">
										<span className="truncate font-mono text-xs text-muted-foreground">
											{e.ip ?? "None"}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{log.hasNextPage && (
				<div className="mt-4 flex justify-center">
					<Button
						variant="outline"
						onClick={() => log.fetchNextPage()}
						disabled={log.isFetchingNextPage}
					>
						{log.isFetchingNextPage && <Loader2 className="animate-spin" />}
						Load more
					</Button>
				</div>
			)}
			{rows.length > 0 && !log.hasNextPage && (
				<p className="mt-4 text-center text-xs text-muted-foreground">
					That's every entry for these filters.
				</p>
			)}

			<AuditDrawer entry={open} onOpenChange={(o) => !o && setOpen(null)} />
		</Page>
	);
}
