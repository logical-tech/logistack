import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ServiceBackupsSlot } from "@/components/service/backups-slot";
import { overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/backups",
)({
	component: BackupsTab,
});

function BackupsTab() {
	const { serviceId } = Route.useParams();
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!service) return null;
	return <ServiceBackupsSlot serviceId={serviceId} service={service} />;
}
