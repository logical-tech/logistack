import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ServiceTerminal } from "@/components/service/terminal";
import { overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/terminal",
)({
	component: TerminalTab,
});

function TerminalTab() {
	const { serviceId } = Route.useParams();
	const { data: service } = useQuery(overviewQuery(serviceId));
	return (
		<ServiceTerminal
			serviceId={serviceId}
			tasks={service?.status.tasks ?? []}
		/>
	);
}
