import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ServiceFiles } from "@/components/service/service-files";
import { overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/files",
)({
	component: FilesTab,
});

function FilesTab() {
	const { projectId, serviceId } = Route.useParams();
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!service) return null;
	return <ServiceFiles service={service} projectId={projectId} />;
}
