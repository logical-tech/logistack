import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsForm } from "@/components/service/settings-form";
import { overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/settings",
)({
	component: SettingsTab,
});

function SettingsTab() {
	const { serviceId, projectId } = Route.useParams();
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!service) return null;
	return <SettingsForm service={service} projectId={projectId} />;
}
