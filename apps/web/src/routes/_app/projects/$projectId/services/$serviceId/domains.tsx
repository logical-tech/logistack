import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Globe, Plus } from "lucide-react";
import { useState } from "react";
import { DomainsTable } from "@/components/domains-table";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { AddDomainDialog } from "@/components/service/add-domain-dialog";
import { BasicAuthPanel } from "@/components/service/basic-auth-panel";
import { Button } from "@/components/ui/button";
import { domainsQuery } from "@/lib/api/networking";
import { overviewQuery } from "@/lib/api/service-ops";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/domains",
)({
	component: DomainsTab,
});

function DomainsTab() {
	const { serviceId } = Route.useParams();
	const { data } = useQuery(domainsQuery);
	const { data: service } = useQuery(overviewQuery(serviceId));
	const [adding, setAdding] = useState(false);
	const mine = data?.filter((d) => d.service.id === serviceId);
	const add = (
		<Button onClick={() => setAdding(true)} disabled={!service}>
			<Plus data-icon="inline-start" />
			Add domain
		</Button>
	);
	const dialog = service && (
		<AddDomainDialog service={service} open={adding} onOpenChange={setAdding} />
	);
	if (mine?.length === 0)
		return (
			<div className="grid gap-8">
				<EmptyState
					icon={Globe}
					title="No public address"
					description="The service is reachable only from others in its environment. Add a domain to route traffic to it, with a certificate issued for you."
				>
					{add}
				</EmptyState>
				{dialog}
			</div>
		);
	return (
		<div className="grid gap-8">
			<Panel title="Domains" id="service-domains" actions={mine && add}>
				{mine ? <DomainsTable data={mine} /> : <SkeletonRows rows={2} />}
				{dialog}
			</Panel>
			<BasicAuthPanel serviceId={serviceId} />
		</div>
	);
}
