import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Segmented } from "@/components/segmented";
import { ServiceStatus } from "@/components/status";
import type { ServiceOverview } from "@/lib/api/service-ops";
import { connectionQuery } from "@/lib/api/storage";
import { STORAGE_ENGINES } from "@/lib/storage-engines";
import { AccessKeys } from "./access-keys";
import { Connection } from "./connection";
import { ObjectBrowser } from "./object-browser";

export type StorageView = "browser" | "keys" | "connection";
export type StorageLocation = {
	view: StorageView;
	bucket: string | undefined;
	prefix: string;
};

const VIEWS: { value: StorageView; label: string }[] = [
	{ value: "browser", label: "Browser" },
	{ value: "keys", label: "Access keys" },
	{ value: "connection", label: "Connection" },
];

/** The Storage tab: objects, scoped keys and connection details of one storage service. */
export function ServiceStorage({
	service,
	at,
	onNavigate,
}: {
	service: ServiceOverview;
	at: StorageLocation;
	onNavigate: (next: Partial<StorageLocation>) => void;
}) {
	const running = service.status.observed === "running";
	const connection = useQuery({
		...connectionQuery(service.id),
		enabled: running,
	});
	const engine =
		service.spec.kind === "storage"
			? STORAGE_ENGINES[service.spec.engine]
			: null;

	if (!running)
		return (
			<EmptyState
				icon={HardDrive}
				title={
					service.status.observed === "starting"
						? `${engine?.label ?? "The engine"} is starting`
						: `${engine?.label ?? "The engine"} isn't running`
				}
				description={
					<>
						Buckets and keys appear here once the service reports healthy.
						<span className="mt-3 flex justify-center">
							<ServiceStatus status={service.status.observed} />
						</span>
					</>
				}
			/>
		);

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Segmented
					label="Storage sections"
					value={at.view}
					onChange={(view) => onNavigate({ view })}
					options={VIEWS}
				/>
				{engine && (
					<p className="text-xs text-muted-foreground">
						{engine.label}{" "}
						<span className="tabular">
							{connection.data?.version ?? engine.version}
						</span>
					</p>
				)}
			</div>
			{connection.isError ? (
				<p
					role="alert"
					className="rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad-text"
				>
					{connection.error.message}
				</p>
			) : at.view === "keys" ? (
				<AccessKeys serviceId={service.id} />
			) : at.view === "connection" ? (
				<Connection serviceId={service.id} connection={connection.data} />
			) : (
				<ObjectBrowser
					serviceId={service.id}
					capabilities={connection.data?.capabilities}
					engineLabel={engine?.label ?? "This engine"}
					hasPublicEndpoint={Boolean(connection.data?.publicEndpoint)}
					bucket={at.bucket}
					prefix={at.prefix}
					onNavigate={(bucket, prefix) => onNavigate({ bucket, prefix })}
				/>
			)}
		</div>
	);
}
