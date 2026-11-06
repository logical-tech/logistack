import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SkeletonRows } from "@/components/panel";
import { EnvEditor } from "@/components/service/env-editor";
import { envVarsQuery, overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/environment",
)({
	component: EnvironmentTab,
});

function EnvironmentTab() {
	const { serviceId, projectId } = Route.useParams();
	const { data } = useQuery(envVarsQuery(serviceId));
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!data)
		return (
			<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
				<SkeletonRows rows={5} />
			</div>
		);
	return (
		<EnvEditor
			serviceId={serviceId}
			projectId={projectId}
			environmentId={service?.environmentId}
			vars={data}
		/>
	);
}
