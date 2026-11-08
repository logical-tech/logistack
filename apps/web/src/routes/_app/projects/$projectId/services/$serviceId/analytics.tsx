import { createFileRoute } from "@tanstack/react-router";
import { ServiceTraffic } from "@/components/projects/service-traffic";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/analytics",
)({
	component: AnalyticsTab,
});

function AnalyticsTab() {
	const { serviceId } = Route.useParams();
	return <ServiceTraffic serviceId={serviceId} />;
}
