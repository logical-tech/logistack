import type { LsdcInstance } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import {
	Building2,
	ExternalLink,
	MoreHorizontal,
	Pencil,
	Plus,
	ScrollText,
} from "lucide-react";
import { useState } from "react";
import { TextMorph } from "torph/react";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import {
	cores,
	EditInstanceDialog,
	megabytes,
	money,
	UsageCell,
} from "@/components/lsdc/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { lsdcInstancesQuery } from "@/lib/api/lsdc";
import type { ServiceId } from "@/lib/api/types";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/lsdc")({
	staticData: { crumb: "LSDC" },
	component: LsdcPage,
});

const col = createColumnHelper<BaseFeatures, LsdcInstance>();

const serviceLink = (i: LsdcInstance) => ({
	params: { projectId: i.projectId, serviceId: i.serviceId as ServiceId },
});

function columns(onEdit: (i: LsdcInstance) => void) {
	return col.columns([
		col.display({
			id: "customer",
			header: "Customer",
			meta: { className: "w-[24%] max-md:w-[55%]" },
			cell: ({ row: { original: i } }) => (
				<div className="min-w-0">
					<Link
						to="/projects/$projectId/services/$serviceId"
						{...serviceLink(i)}
						className="block truncate font-medium hover:underline"
					>
						{i.customer ?? i.name}
					</Link>
					{i.hostname ? (
						<a
							href={`https://${i.hostname}`}
							target="_blank"
							rel="noreferrer"
							className="group/host inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
						>
							<span className="truncate">{i.hostname}</span>
							<ExternalLink
								className="size-3 shrink-0 opacity-0 transition-opacity duration-(--duration-quick) group-hover/host:opacity-100 group-focus-visible/host:opacity-100"
								aria-hidden
							/>
							<span className="sr-only">(opens in a new tab)</span>
						</a>
					) : (
						<span className="block text-xs text-muted-foreground">
							No domain
						</span>
					)}
				</div>
			),
		}),
		col.display({
			id: "where",
			header: "Project",
			meta: { className: "w-[17%] max-lg:hidden" },
			cell: ({ row: { original: i } }) => (
				<Link
					to="/projects/$projectId"
					params={{ projectId: i.projectId }}
					search={{ env: i.environmentId }}
					className="block min-w-0 truncate hover:text-foreground"
				>
					{i.projectName}
					<span className="text-muted-foreground"> · {i.environmentName}</span>
				</Link>
			),
		}),
		col.display({
			id: "usage",
			header: "Usage of plan",
			meta: { className: "max-md:hidden" },
			cell: ({ row: { original: i } }) =>
				i.desiredState === "stopped" ? (
					<span className="text-xs text-muted-foreground">Stopped</span>
				) : (
					<UsageCell instance={i} />
				),
		}),
		col.display({
			id: "price",
			header: () => <span className="block text-right">Monthly</span>,
			meta: { className: "w-[13%] max-md:w-[30%] text-right" },
			cell: ({ row: { original: i } }) =>
				i.priceCents === null ? (
					<span className="text-muted-foreground">No price</span>
				) : (
					<span className="tabular font-medium">
						{money(i.priceCents, i.currency)}
					</span>
				),
		}),
		col.display({
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			meta: { className: "w-14 pr-2 text-right" },
			cell: ({ row: { original: i } }) => (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Actions for ${i.customer ?? i.name}`}
							className="text-muted-foreground"
						>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => onEdit(i)}>
							<Pencil />
							Edit plan
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							<Link
								to="/projects/$projectId/services/$serviceId"
								{...serviceLink(i)}
							>
								<Building2 />
								Open service
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link
								to="/projects/$projectId/services/$serviceId/logs"
								{...serviceLink(i)}
							>
								<ScrollText />
								Logs
							</Link>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			),
		}),
	]);
}

/** Totals over every instance: revenue per currency, limits as sold. */
function totals(list: LsdcInstance[]) {
	const revenue = new Map<string, number>();
	let cpu = 0;
	let ramMb = 0;
	let storageMb = 0;
	for (const i of list) {
		if (i.priceCents !== null)
			revenue.set(i.currency, (revenue.get(i.currency) ?? 0) + i.priceCents);
		cpu += i.limits.cpu ?? 0;
		ramMb += i.limits.ramMb ?? 0;
		storageMb += i.limits.storageMb ?? 0;
	}
	return {
		revenue: revenue.size
			? [...revenue]
					.sort((a, b) => b[1] - a[1])
					.map(([c, cents]) => money(cents, c))
					.join(" + ")
			: "No prices set",
		limits: `${cores(cpu)} · ${megabytes(ramMb)} RAM · ${megabytes(storageMb)} disk`,
	};
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0 px-5 py-4">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-1 text-lg font-semibold text-balance tabular">
				<TextMorph>{value}</TextMorph>
			</dd>
		</div>
	);
}

function LsdcPage() {
	const s = section("/lsdc");
	const { data, isPending } = useQuery(lsdcInstancesQuery);
	const [editing, setEditing] = useState<LsdcInstance | null>(null);
	const newButton = (
		<Button asChild>
			<Link to="/lsdc/new">
				<Plus data-icon="inline-start" />
				New instance
			</Link>
		</Button>
	);
	const t = data?.length ? totals(data) : null;

	return (
		<Page>
			<PageHeader
				title={s.title}
				description={s.description}
				actions={data?.length ? newButton : undefined}
			/>
			{isPending ? (
				<Panel title="Instances" id="lsdc-instances">
					<SkeletonRows rows={3} />
				</Panel>
			) : !data?.length || !t ? (
				<EmptyState
					icon={Building2}
					title={s.empty?.title ?? "No LSDC instances yet"}
					description={s.empty?.body}
				>
					{newButton}
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<dl className="grid divide-y rounded-xl bg-card shadow-card ring-1 ring-border sm:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1.6fr)] sm:divide-x sm:divide-y-0">
						<Stat label="Instances" value={String(data.length)} />
						<Stat label="Monthly revenue" value={t.revenue} />
						<Stat label="Limits sold" value={t.limits} />
					</dl>
					<Panel title="Instances" id="lsdc-instances">
						<DataTable
							label="LSDC instances"
							columns={columns(setEditing)}
							data={data}
							getRowId={(i) => i.id}
						/>
					</Panel>
				</div>
			)}
			<EditInstanceDialog
				instance={editing}
				onOpenChange={(o) => !o && setEditing(null)}
			/>
		</Page>
	);
}
