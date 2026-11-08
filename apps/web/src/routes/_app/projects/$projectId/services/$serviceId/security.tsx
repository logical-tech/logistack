import { createFileRoute } from "@tanstack/react-router";
import { SecurityPanel } from "@/components/service/security";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/security",
)({
	component: SecurityTab,
});

function SecurityTab() {
	const { serviceId } = Route.useParams();
	return <SecurityPanel serviceId={serviceId} />;
}
