import { type DnsRecordType, dnsRecordTypes } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import {
	Cloud,
	Globe,
	Lock,
	Pencil,
	Plus,
	RotateCw,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import {
	CLOUD_ORANGE,
	formatTtl,
	RecordEditor,
	relativeName,
} from "@/components/dns/record-editor";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDelete } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
	type DnsKind,
	type DnsRecordSet,
	dnsProvidersQuery,
	useInvalidating,
	zoneRecordsQuery,
} from "@/lib/api/networking";
import { DNS_KINDS } from "@/lib/integrations";
import { cn } from "@/lib/utils";

export const Route = createFileRoute(
	"/_app/integrations/dns_/$providerId/$zoneId",
)({
	// The crumb comes from the stored provider list, not a live provider call.
	loader: async ({ context, params }) => {
		const providers =
			await context.queryClient.ensureQueryData(dnsProvidersQuery);
		const zone = providers
			.find((p) => p.id === params.providerId)
			?.zones.find((z) => z.id === params.zoneId);
		return { crumb: zone?.name ?? "Zone" };
	},
	component: ZonePage,
});

const ALL = "all";
const TYPE_ORDER = new Map(dnsRecordTypes.map((t, i) => [t, i]));

const col = createColumnHelper<BaseFeatures, DnsRecordSet>();

function NameCell({ r, zone }: { r: DnsRecordSet; zone: string }) {
	const rel = relativeName(r.name, zone);
	return (
		<div className="min-w-0">
			<div className="flex min-w-0 items-center gap-2">
				<span
					className="truncate font-mono text-[13px] font-medium"
					title={r.name}
				>
					{rel}
				</span>
				{r.domain && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Link
								to="/domains"
								className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-brand/10 px-2 text-[11px] font-medium text-brand transition-colors duration-(--duration-quick) hover:bg-brand/15"
							>
								<Globe className="size-3" aria-hidden />
								LogiStack
							</Link>
						</TooltipTrigger>
						<TooltipContent>
							Created for {r.domain.hostname}; removing the domain removes it
						</TooltipContent>
					</Tooltip>
				)}
			</div>
			{/* Phones fold the value column into the name. */}
			<span
				className="block truncate font-mono text-xs text-muted-foreground md:hidden"
				title={r.values.join("\n")}
			>
				{r.values.join(", ")}
			</span>
			{r.comment && (
				<span
					className="block truncate text-xs text-muted-foreground"
					title={r.comment}
				>
					{r.comment}
				</span>
			)}
		</div>
	);
}

function ProxyCell({ proxied }: { proxied?: boolean }) {
	if (proxied === undefined) return null;
	return (
		<span className="inline-flex items-center gap-1.5 text-muted-foreground">
			<Cloud
				className={cn("size-4", proxied && CLOUD_ORANGE)}
				fill={proxied ? "currentColor" : "none"}
				aria-hidden
			/>
			<span className="max-lg:sr-only">{proxied ? "Proxied" : "DNS only"}</span>
		</span>
	);
}

function columns(
	kind: DnsKind,
	zone: string,
	actions: {
		onEdit: (r: DnsRecordSet) => void;
		onDelete: (r: DnsRecordSet) => void;
	},
) {
	return col.columns([
		col.display({
			id: "name",
			header: "Name",
			meta: { className: "w-[26%] max-md:w-auto" },
			cell: ({ row: { original: r } }) => <NameCell r={r} zone={zone} />,
		}),
		col.display({
			id: "type",
			header: "Type",
			meta: { className: "w-20 max-md:w-16" },
			cell: ({ row: { original: r } }) => (
				<span className="inline-flex rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
					{r.type}
				</span>
			),
		}),
		col.display({
			id: "value",
			header: "Value",
			meta: { className: "max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<ul className="grid min-w-0 gap-0.5 py-2">
					{r.values.map((v, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: a set may repeat nothing, but values carry no id
							key={i}
							className="truncate font-mono text-[13px] text-foreground/90"
							title={v}
						>
							{v}
						</li>
					))}
				</ul>
			),
		}),
		...(kind === "cloudflare"
			? [
					col.display({
						id: "proxy",
						header: "Proxy",
						meta: { className: "w-28 max-lg:w-14" },
						cell: ({ row: { original: r } }) => (
							<ProxyCell proxied={r.proxied} />
						),
					}),
				]
			: []),
		col.display({
			id: "ttl",
			header: "TTL",
			meta: { className: "w-20 max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular-nums text-muted-foreground">
					{r.readOnly && r.ttl === 0 ? "—" : formatTtl(r.ttl, kind)}
				</span>
			),
		}),
		col.display({
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			meta: { className: "w-24 text-right max-md:w-20 max-md:pl-0" },
			cell: ({ row: { original: r } }) =>
				r.readOnly ? (
					<div className="flex justify-end">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Read only: ${r.readOnly}`}
									className="text-muted-foreground"
								>
									<Lock />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{r.readOnly}</TooltipContent>
						</Tooltip>
					</div>
				) : (
					<div className="flex justify-end gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Edit ${r.type} ${r.name}`}
							onClick={() => actions.onEdit(r)}
						>
							<Pencil />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Delete ${r.type} ${r.name}`}
							onClick={() => actions.onDelete(r)}
						>
							<Trash2 />
						</Button>
					</div>
				),
		}),
	]);
}

function ZonePage() {
	const { providerId, zoneId } = Route.useParams();
	const query = useQuery(zoneRecordsQuery(providerId, zoneId));
	const { data, isPending, error, refetch, isFetching } = query;
	const [search, setSearch] = useState("");
	const [type, setType] = useState<DnsRecordType | typeof ALL>(ALL);
	const [editing, setEditing] = useState<DnsRecordSet | null | "new">(null);
	const [deleting, setDeleting] = useState<DnsRecordSet | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);

	const keys = [[...zoneRecordsQuery(providerId, zoneId).queryKey]];
	const create = useInvalidating(
		(body: Parameters<typeof api.networking.dns.createRecord>[2]) =>
			api.networking.dns.createRecord(providerId, zoneId, body),
		keys,
	);
	const update = useInvalidating(
		({
			id,
			body,
		}: {
			id: string;
			body: Parameters<typeof api.networking.dns.updateRecord>[3];
		}) => api.networking.dns.updateRecord(providerId, zoneId, id, body),
		keys,
	);
	const remove = useInvalidating(
		(id: string) => api.networking.dns.removeRecord(providerId, zoneId, id),
		[...keys, ["domains"]],
	);

	const zone = data?.zone.name ?? "";
	const records = useMemo(
		() =>
			[...(data?.records ?? [])].sort(
				(a, b) =>
					Number(b.name === zone) - Number(a.name === zone) ||
					a.name.localeCompare(b.name) ||
					(TYPE_ORDER.get(a.type) ?? 0) - (TYPE_ORDER.get(b.type) ?? 0),
			),
		[data, zone],
	);
	const counts = useMemo(() => {
		const m = new Map<DnsRecordType, number>();
		for (const r of records) m.set(r.type, (m.get(r.type) ?? 0) + 1);
		return m;
	}, [records]);
	const q = search.trim().toLowerCase();
	const shown = records.filter(
		(r) =>
			(type === ALL || r.type === type) &&
			(!q ||
				r.name.includes(q) ||
				r.values.some((v) => v.toLowerCase().includes(q)) ||
				r.comment?.toLowerCase().includes(q)),
	);
	const filtered = q !== "" || type !== ALL;
	const kind = data?.provider.kind;

	const add = (
		<Button onClick={() => setEditing("new")} disabled={!data}>
			<Plus data-icon="inline-start" />
			Add record
		</Button>
	);

	return (
		<Page>
			<PageHeader
				title={<span className="font-mono">{zone || "Zone"}</span>}
				description={
					data ? (
						<>
							Records live at{" "}
							<Link
								to="/integrations/dns"
								className="text-foreground underline-offset-4 hover:underline"
							>
								{data.provider.name}
							</Link>{" "}
							({DNS_KINDS[data.provider.kind].label}). Edits here apply there
							immediately.
						</>
					) : undefined
				}
				actions={add}
			/>

			{error ? (
				<EmptyState
					icon={Globe}
					title="Couldn't load the zone"
					description={error.message}
				>
					<Button variant="outline" onClick={() => refetch()}>
						<RotateCw data-icon="inline-start" />
						Try again
					</Button>
				</EmptyState>
			) : (
				<Panel
					id="zone-records"
					title={
						<span className="flex items-center gap-2">
							Records
							{data && (
								<span className="font-normal tabular-nums text-muted-foreground">
									{filtered
										? `${shown.length} of ${records.length}`
										: records.length}
								</span>
							)}
						</span>
					}
					actions={
						<div className="flex items-center gap-2">
							<InputGroup className="h-8 w-56 max-sm:w-40">
								<InputGroupAddon>
									<Search aria-hidden />
								</InputGroupAddon>
								<InputGroupInput
									ref={searchRef}
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									onKeyDown={(e) => e.key === "Escape" && setSearch("")}
									placeholder="Filter name or value"
									aria-label="Filter records by name or value"
									spellCheck={false}
									autoCapitalize="none"
								/>
								{search && (
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											size="icon-xs"
											aria-label="Clear filter"
											onClick={() => {
												setSearch("");
												searchRef.current?.focus();
											}}
										>
											<X />
										</InputGroupButton>
									</InputGroupAddon>
								)}
							</InputGroup>
							<Select
								value={type}
								onValueChange={(v) => setType(v as DnsRecordType | typeof ALL)}
							>
								<SelectTrigger className="w-32" aria-label="Filter by type">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									<SelectItem value={ALL}>All types</SelectItem>
									{dnsRecordTypes
										.filter((t) => counts.has(t))
										.map((t) => (
											<SelectItem key={t} value={t} className="font-mono">
												{t}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</div>
					}
					bodyClassName={cn(
						"transition-opacity duration-(--duration-quick)",
						isFetching && !isPending && "opacity-70",
					)}
				>
					{isPending || !kind ? (
						<SkeletonRows rows={6} />
					) : (
						<DataTable
							label={`Records in ${zone}`}
							columns={columns(kind, zone, {
								onEdit: setEditing,
								onDelete: setDeleting,
							})}
							data={shown}
							getRowId={(r) => r.id}
							empty={
								filtered ? (
									<div className="grid justify-items-center gap-3 text-sm text-muted-foreground">
										No records match.
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												setSearch("");
												setType(ALL);
											}}
										>
											Clear filters
										</Button>
									</div>
								) : (
									<div className="grid justify-items-center gap-3 text-sm text-muted-foreground">
										This zone has no records yet.
										{add}
									</div>
								)
							}
						/>
					)}
				</Panel>
			)}

			{data && kind && (
				<RecordEditor
					open={editing !== null}
					onOpenChange={(o) => !o && setEditing(null)}
					kind={kind}
					zone={data.zone}
					record={editing === "new" ? null : editing}
					onSave={async (body) => {
						if (editing && editing !== "new") {
							await update.mutateAsync({ id: editing.id, body });
							toast.success(`${body.type} ${body.name} saved`);
						} else {
							await create.mutateAsync(body);
							toast.success(`${body.type} ${body.name} added`);
						}
					}}
				/>
			)}

			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.type ?? ""} ${deleting ? relativeName(deleting.name, zone) : "record"}?`}
				description={
					deleting?.domain ? (
						<>
							LogiStack created this record for{" "}
							<span className="font-medium text-foreground">
								{deleting.domain.hostname}
							</span>
							. Once it is gone the domain stops resolving, and LogiStack no
							longer tracks it.
						</>
					) : deleting && deleting.values.length > 1 ? (
						`All ${deleting.values.length} values are removed at the provider. This can't be undone.`
					) : (
						"The record is removed at the provider. This can't be undone."
					)
				}
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.id);
					toast.success(`${deleting.type} ${deleting.name} deleted`);
				}}
			/>
		</Page>
	);
}
