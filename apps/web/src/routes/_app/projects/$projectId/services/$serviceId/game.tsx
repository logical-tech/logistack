import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ServiceGame } from "@/components/game/service-game";
import { overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/game",
)({
	component: GameTab,
});

function GameTab() {
	const { serviceId } = Route.useParams();
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!service) return null;
	return <ServiceGame service={service} />;
}
