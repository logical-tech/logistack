import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
	ServiceStorage,
	type StorageLocation,
} from "@/components/storage/service-storage";
import { overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/storage",
)({
	validateSearch: z.object({
		view: z.enum(["keys", "connection"]).optional().catch(undefined),
		bucket: z.string().max(63).optional().catch(undefined),
		prefix: z.string().max(1024).optional().catch(undefined),
	}),
	component: StorageTab,
});

function StorageTab() {
	const { serviceId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!service) return null;
	const at: StorageLocation = {
		view: search.view ?? "browser",
		bucket: search.bucket,
		prefix: search.prefix ?? "",
	};
	return (
		<ServiceStorage
			service={service}
			at={at}
			onNavigate={(next) => {
				const to = { ...at, ...next };
				// The browser and the bucket root are the defaults, so they stay out of the URL.
				navigate({
					search: {
						view: to.view === "browser" ? undefined : to.view,
						bucket: to.bucket,
						prefix: to.prefix || undefined,
					},
				});
			}}
		/>
	);
}
