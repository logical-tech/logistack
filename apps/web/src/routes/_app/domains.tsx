import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Globe, Plus } from "lucide-react";
import { DomainsTable } from "@/components/domains-table";
import { EmptyState } from "@/components/empty-state";
import { expiryTone } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { type DomainListItem, domainsQuery } from "@/lib/api/networking";
import { daysUntil } from "@/lib/format";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/domains")({
	staticData: { crumb: "Domains" },
	component: DomainsPage,
});

/** One sentence of what needs attention, instead of a row of stat tiles. */
function Attention({ domains }: { domains: DomainListItem[] }) {
	const errors = domains.filter((d) => d.status === "error").length;
	const expiring = domains.filter(
		(d) =>
			d.certificate && expiryTone(daysUntil(d.certificate.notAfter)) !== null,
	).length;
	const pending = domains.filter((d) => d.status === "pending").length;
	const parts = [
		errors && `${errors} with errors`,
		expiring &&
			`${expiring} certificate${expiring === 1 ? "" : "s"} expiring within 14 days`,
		pending && `${pending} waiting for the proxy`,
	].filter(Boolean);
	return (
		<p className="mb-4 text-sm text-muted-foreground">
			<span className="tabular text-foreground">{domains.length}</span> domains
			{parts.length ? `, ${parts.join(", ")}.` : ", all serving."}
		</p>
	);
}

function DomainsPage() {
	const s = section("/domains");
	const { data, isPending } = useQuery(domainsQuery);

	const add = (
		<Button asChild>
			<Link to="/domains/new">
				<Plus data-icon="inline-start" />
				Add domain
			</Link>
		</Button>
	);

	return (
		<Page>
			<PageHeader
				title={s.title}
				description={s.description}
				actions={data?.length ? add : undefined}
			/>
			{isPending ? (
				<Panel title="All domains" id="domains">
					<SkeletonRows rows={6} />
				</Panel>
			) : !data?.length ? (
				<EmptyState
					icon={Globe}
					title={s.empty?.title ?? "No domains"}
					description={s.empty?.body}
				>
					{add}
				</EmptyState>
			) : (
				<>
					<Attention domains={data} />
					<Panel title="All domains" id="domains">
						<DomainsTable data={data} />
					</Panel>
				</>
			)}
		</Page>
	);
}
