import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Globe, Plus } from "lucide-react";
import { DomainsTable } from "@/components/domains-table";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { domainsQuery } from "@/lib/api/networking";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/domains",
)({
	component: DomainsTab,
});

function DomainsTab() {
	const { serviceId } = Route.useParams();
	const { data } = useQuery(domainsQuery);
	const mine = data?.filter((d) => d.service.id === serviceId);
	const add = (
		<Button asChild>
			<Link to="/domains/new" search={{ serviceId }}>
				<Plus data-icon="inline-start" />
				Add domain
			</Link>
		</Button>
	);
	if (mine?.length === 0)
		return (
			<EmptyState
				icon={Globe}
				title="No public address"
				description="The service is reachable only from others in its environment. Add a domain to route traffic to it, with a certificate issued for you."
			>
				{add}
			</EmptyState>
		);
	return (
		<Panel title="Domains" id="service-domains" actions={mine && add}>
			{mine ? <DomainsTable data={mine} /> : <SkeletonRows rows={2} />}
		</Panel>
	);
}
