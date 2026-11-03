import { createFileRoute } from "@tanstack/react-router";
import { ServiceMetrics } from "@/components/projects/service-metrics";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/metrics",
)({
	component: MetricsTab,
});

function MetricsTab() {
	const { serviceId } = Route.useParams();
	return <ServiceMetrics serviceId={serviceId} />;
}
