import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { HardDrive, Plus } from "lucide-react";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { ServiceStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { type StorageListItem, storageListQuery } from "@/lib/api/storage";
import type { ServiceId } from "@/lib/api/types";
import { section } from "@/lib/nav";
import { STORAGE_ENGINES } from "@/lib/storage-engines";

export const Route = createFileRoute("/_app/storage")({
	staticData: { crumb: "Storage" },
	component: StoragePage,
});

const col = createColumnHelper<BaseFeatures, StorageListItem>();

const columns = col.columns([
	col.display({
		id: "name",
		header: "Service",
		meta: { className: "w-[30%] max-md:w-[60%]" },
		cell: ({ row: { original: s } }) => (
			<div className="min-w-0">
				<Link
					to="/projects/$projectId/services/$serviceId/storage"
					params={{ projectId: s.projectId, serviceId: s.id as ServiceId }}
					className="block truncate font-medium hover:underline"
				>
					{s.name}
				</Link>
				<span className="block truncate text-xs text-muted-foreground md:hidden">
					{STORAGE_ENGINES[s.engine].label} · {s.projectName}
				</span>
			</div>
		),
	}),
	col.display({
		id: "engine",
		header: "Engine",
		meta: { className: "w-[18%] max-md:hidden" },
		cell: ({ row: { original: s } }) => STORAGE_ENGINES[s.engine].label,
	}),
	col.display({
		id: "project",
		header: "Project",
		meta: { className: "max-md:hidden" },
		cell: ({ row: { original: s } }) => (
			<Link
				to="/projects/$projectId"
				params={{ projectId: s.projectId }}
				search={{ env: s.environmentId }}
				className="block min-w-0 truncate hover:text-foreground"
			>
				{s.projectName}
				<span className="text-muted-foreground"> · {s.environmentName}</span>
			</Link>
		),
	}),
	col.display({
		id: "status",
		header: "Status",
		meta: { className: "w-[18%] max-md:w-auto" },
		cell: ({ row: { original: s } }) => <ServiceStatus status={s.observed} />,
	}),
]);

function StoragePage() {
	const s = section("/storage");
	const { data, isPending } = useQuery(storageListQuery);
	return (
		<Page>
			<PageHeader title={s.title} description={s.description} />
			{isPending ? (
				<Panel title="All storage" id="storage">
					<SkeletonRows rows={4} />
				</Panel>
			) : !data?.length ? (
				<EmptyState
					icon={HardDrive}
					title={s.empty?.title ?? "No object storage"}
					description={s.empty?.body}
				>
					<Button asChild>
						<Link to="/projects">
							<Plus data-icon="inline-start" />
							{s.empty?.action}
						</Link>
					</Button>
				</EmptyState>
			) : (
				<Panel title="All storage" id="storage">
					<DataTable
						label="Storage services"
						columns={columns}
						data={data}
						getRowId={(r) => r.id}
					/>
				</Panel>
			)}
		</Page>
	);
}
