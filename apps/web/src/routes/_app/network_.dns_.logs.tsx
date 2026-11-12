import { HomeDnsResponseType } from "@logistack/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	ChevronLeft,
	ChevronRight,
	CircleAlert,
	ScrollText,
	Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { DomainActions, HomeDnsPage } from "@/components/network/home-dns";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api";
import { type HomeDnsLogEntry, homeDnsLogsQuery } from "@/lib/api/home-dns";
import { cn } from "@/lib/utils";

const WINDOWS = {
	"15m": { label: "Last 15 minutes", ms: 15 * 60_000 },
	"1h": { label: "Last hour", ms: 3_600_000 },
	"24h": { label: "Last 24 hours", ms: 86_400_000 },
	"7d": { label: "Last 7 days", ms: 7 * 86_400_000 },
	all: { label: "Everything kept", ms: 0 },
} as const;
type Window = keyof typeof WINDOWS;

const opt = z.string().trim().min(1).optional().catch(undefined);

export const Route = createFileRoute("/_app/network_/dns_/logs")({
	staticData: { crumb: "Query log" },
	validateSearch: z.object({
		client: opt,
		domain: opt,
		type: HomeDnsResponseType.optional().catch(undefined),
		window: z
			.enum(Object.keys(WINDOWS) as [Window, ...Window[]])
			.optional()
			.catch(undefined),
		page: z.coerce.number().int().min(1).optional().catch(undefined),
	}),
	component: QueryLog,
});

const RESPONSE: Record<string, { label: string; className?: string }> = {
	Authoritative: { label: "Local" },
	Recursive: { label: "Resolved" },
	Cached: { label: "Cached", className: "text-muted-foreground" },
	Blocked: { label: "Blocked", className: "text-bad-text" },
	UpstreamBlocked: { label: "Blocked upstream", className: "text-bad-text" },
	CacheBlocked: { label: "Blocked (cache)", className: "text-bad-text" },
};
const isBlocked = (t: string) => t.endsWith("Blocked");
const ALL = "\u0000all";

const time = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

function QueryLog() {
	return <HomeDnsPage to="/network/dns/logs">{() => <LogTable />}</HomeDnsPage>;
}

function LogTable() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [live, setLive] = useState(true);
	const [domain, setDomain] = useState(search.domain ?? "");
	const [client, setClient] = useState(search.client ?? "");
	const page = search.page ?? 1;
	const win = search.window ?? "24h";

	const set = useMemo(
		() => (patch: Partial<typeof search>) =>
			navigate({
				search: (s) => ({ ...s, page: undefined, ...patch }),
				replace: true,
			}),
		[navigate],
	);
	const clientValid =
		!client || z.ipv4().or(z.ipv6()).safeParse(client).success;
	// Text filters reach the URL a moment after typing stops.
	useEffect(() => {
		const next = domain.trim() || undefined;
		if (next === search.domain) return;
		const t = setTimeout(() => set({ domain: next }), 350);
		return () => clearTimeout(t);
	}, [domain, search.domain, set]);
	useEffect(() => {
		const next = client.trim() || undefined;
		if (next === search.client || !clientValid) return;
		const t = setTimeout(() => set({ client: next }), 350);
		return () => clearTimeout(t);
	}, [client, search.client, clientValid, set]);

	// The window's start is fixed when chosen, so live refresh keeps one cache entry.
	const start = useMemo(
		() =>
			WINDOWS[win].ms
				? new Date(Date.now() - WINDOWS[win].ms).toISOString()
				: undefined,
		[win],
	);
	const { data, error, isPending, isFetching } = useQuery({
		...homeDnsLogsQuery(
			{
				page,
				perPage: 50,
				client: search.client,
				domain: search.domain,
				responseType: search.type,
				start,
			},
			live && page === 1,
		),
		placeholderData: keepPreviousData,
	});
	const installing =
		error instanceof ApiError &&
		error.status === 409 &&
		/query log extension/i.test(error.message);
	const filtered = Boolean(search.client || search.domain || search.type);

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-48 flex-1">
					<Search
						aria-hidden
						className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						value={domain}
						onChange={(e) => setDomain(e.target.value)}
						placeholder="Filter by domain"
						aria-label="Filter by domain"
						spellCheck={false}
						autoCapitalize="none"
						className="pl-8 font-mono"
					/>
				</div>
				<Input
					value={client}
					onChange={(e) => setClient(e.target.value)}
					placeholder="Device IP"
					aria-label="Filter by device IP"
					aria-invalid={clientValid ? undefined : true}
					spellCheck={false}
					className="w-36 font-mono tabular-nums"
				/>
				<Select
					value={search.type ?? ALL}
					onValueChange={(v) =>
						set({
							type: v === ALL ? undefined : (v as typeof search.type),
						})
					}
				>
					<SelectTrigger className="w-40" aria-label="Response">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL}>Any response</SelectItem>
						{HomeDnsResponseType.options.map((t) => (
							<SelectItem key={t} value={t}>
								{RESPONSE[t]?.label ?? t}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={win}
					onValueChange={(v) =>
						set({ window: v === "24h" ? undefined : (v as Window) })
					}
				>
					<SelectTrigger className="w-40" aria-label="Time range">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{Object.entries(WINDOWS).map(([k, w]) => (
							<SelectItem key={k} value={k}>
								{w.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<label
					htmlFor="log-live"
					className="ml-auto flex h-9 items-center gap-2 text-sm text-muted-foreground"
				>
					<Switch
						id="log-live"
						checked={live}
						onCheckedChange={setLive}
						aria-describedby="live-hint"
					/>
					<span>Live</span>
					<span id="live-hint" className="sr-only">
						Refreshes the first page every 3 seconds
					</span>
				</label>
			</div>

			{installing ? (
				<EmptyState
					icon={ScrollText}
					title="The query log is being set up"
					description="The worker is installing Technitium's query log extension. It can take a few minutes on a slow connection; this page fills in by itself."
				/>
			) : error ? (
				<EmptyState
					icon={CircleAlert}
					title="Couldn't read the query log"
					description={error.message}
				/>
			) : (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					{isPending || !data ? (
						<SkeletonRows rows={8} />
					) : data.entries.length === 0 ? (
						<p className="px-4 py-14 text-center text-sm text-muted-foreground">
							{filtered
								? "No queries match these filters."
								: "No queries in this time range yet. Point a device at the home DNS and they show up here."}
						</p>
					) : (
						<div className="overflow-x-auto">
							<table
								className={cn(
									"w-full min-w-[34rem] table-fixed text-sm sm:min-w-[46rem]",
									isFetching && !live && "opacity-70",
								)}
								aria-label="DNS queries"
							>
								<thead>
									<tr className="border-b text-left text-xs text-muted-foreground">
										<th
											scope="col"
											className="hidden h-9 w-40 px-4 font-medium sm:table-cell"
										>
											Time
										</th>
										<th scope="col" className="h-9 w-36 px-4 font-medium">
											Device
										</th>
										<th scope="col" className="h-9 px-4 font-medium">
											Domain
										</th>
										<th scope="col" className="h-9 w-40 px-4 font-medium">
											Response
										</th>
										<th
											scope="col"
											className="hidden h-9 w-48 px-4 font-medium xl:table-cell"
										>
											Answer
										</th>
										<th scope="col" className="h-9 w-12 px-2">
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{data.entries.map((e) => (
										<Row
											key={`${e.timestamp}-${e.client}-${e.domain}-${e.type}`}
											e={e}
											onClient={(c) => {
												setClient(c);
												set({ client: c });
											}}
										/>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}

			{data && data.totalPages > 1 && !installing && (
				<nav
					aria-label="Pages"
					className="flex items-center justify-between gap-3 text-sm"
				>
					<p className="text-muted-foreground tabular">
						Page {data.page} of {data.totalPages.toLocaleString("en")} ·{" "}
						{data.totalEntries.toLocaleString("en")} queries
					</p>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={page <= 1}
							onClick={() =>
								navigate({
									search: (s) => ({
										...s,
										page: page - 1 > 1 ? page - 1 : undefined,
									}),
								})
							}
						>
							<ChevronLeft data-icon="inline-start" />
							Newer
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={page >= data.totalPages}
							onClick={() =>
								navigate({ search: (s) => ({ ...s, page: page + 1 }) })
							}
						>
							Older
							<ChevronRight data-icon="inline-end" />
						</Button>
					</div>
				</nav>
			)}
		</div>
	);
}

function Row({
	e,
	onClient,
}: {
	e: HomeDnsLogEntry;
	onClient: (ip: string) => void;
}) {
	const r = RESPONSE[e.responseType] ?? { label: e.responseType };
	const blocked = isBlocked(e.responseType);
	return (
		<tr className="border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50">
			<td className="hidden h-11 px-4 whitespace-nowrap text-xs text-muted-foreground tabular sm:table-cell">
				{time.format(new Date(e.timestamp))}
			</td>
			<td className="h-11 px-4">
				<button
					type="button"
					onClick={() => onClient(e.client)}
					className="rounded-sm font-mono text-xs tabular outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
					title="Show only this device"
				>
					{e.client}
				</button>
			</td>
			<td className="h-11 max-w-0 px-4">
				<span className="block truncate font-mono text-xs" title={e.domain}>
					{e.domain}
				</span>
				<span className="text-2xs text-muted-foreground">{e.type}</span>
			</td>
			<td className={cn("h-11 px-4 whitespace-nowrap text-xs", r.className)}>
				{r.label}
				{e.rttMs !== null && (
					<span className="text-muted-foreground tabular"> · {e.rttMs} ms</span>
				)}
			</td>
			<td className="hidden h-11 max-w-0 px-4 xl:table-cell">
				<span
					className="block truncate font-mono text-xs text-muted-foreground"
					title={e.answer}
				>
					{e.answer || "–"}
				</span>
			</td>
			<td className="h-11 px-2 text-right">
				<DomainActions domain={e.domain} blocked={blocked} />
			</td>
		</tr>
	);
}
