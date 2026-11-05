import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { StackContainers } from "@/components/stack/stack-containers";
import {
	StackActivity,
	StackResources,
} from "@/components/stack/stack-observability";
import { stackQuery } from "@/lib/api/stacks";

export const Route = createFileRoute(
	"/_app/projects/$projectId/stacks/$stackId/",
)({
	component: StackOverview,
});

function StackOverview() {
	const { projectId, stackId } = Route.useParams();
	const { data: stack } = useQuery(stackQuery(stackId));
	if (!stack) return null;
	return (
		<div className="grid gap-8">
			<StackContainers services={stack.services} projectId={projectId} />
			<StackResources services={stack.services} />
			<StackActivity services={stack.services} projectId={projectId} />
		</div>
	);
}
