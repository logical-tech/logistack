import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Network, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDelete, KindTile } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
	type DnsProvider,
	dnsProvidersQuery,
	useInvalidating,
} from "@/lib/api/networking";
import { relativeTime } from "@/lib/format";
import { DNS_KINDS } from "@/lib/integrations";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/integrations/dns")({
	staticData: { crumb: "DNS providers" },
	component: DnsProvidersPage,
});

function ProviderRow({
	p,
	onDelete,
}: {
	p: DnsProvider;
	onDelete: () => void;
}) {
	const kind = DNS_KINDS[p.kind];
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<KindTile icon={kind.icon} />
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{p.name}</p>
					<p className="text-xs text-muted-foreground">
						{kind.label} · added {relativeTime(p.createdAt)}
					</p>
				</div>
			</div>
			<div className="flex min-w-0 flex-wrap gap-1.5 sm:max-w-[45%] sm:justify-end">
				{p.zones.map((z) => (
					<Link
						key={z.id}
						to="/integrations/dns/$providerId/$zoneId"
						params={{ providerId: p.id, zoneId: z.id }}
						aria-label={`Records in ${z.name}`}
						className="group/zone inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground transition-colors duration-(--duration-quick) hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
					>
						<span className="truncate">{z.name}</span>
						<ChevronRight
							className="size-3 shrink-0 text-muted-foreground transition-transform duration-(--duration-quick) group-hover/zone:translate-x-0.5"
							aria-hidden
						/>
					</Link>
				))}
			</div>
			<div className="flex items-center justify-between gap-4 sm:w-40 sm:justify-end">
				<span className="tabular text-sm text-muted-foreground">
					{p.domains === 0
						? "No domains"
						: `${p.domains} domain${p.domains === 1 ? "" : "s"}`}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Remove ${p.name}`}
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function DnsProvidersPage() {
	const s = section("/integrations/dns");
	const { data, isPending } = useQuery(dnsProvidersQuery);
	const [deleting, setDeleting] = useState<DnsProvider | null>(null);
	const remove = useInvalidating(api.networking.dns.remove, [
		["dns-providers"],
	]);

	const add = (
		<Button asChild>
			<Link to="/integrations/dns/new">
				<Plus data-icon="inline-start" />
				Connect provider
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
				<Panel title="Providers" id="dns-providers">
					<SkeletonRows rows={2} />
				</Panel>
			) : !data?.length ? (
				<EmptyState
					icon={Network}
					title={s.empty?.title ?? "No DNS providers"}
					description={s.empty?.body}
				>
					{add}
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<Panel title="Providers" id="dns-providers">
						<ul className="divide-y">
							{data.map((p) => (
								<ProviderRow key={p.id} p={p} onDelete={() => setDeleting(p)} />
							))}
						</ul>
					</Panel>
					<p className="max-w-[70ch] text-sm text-muted-foreground">
						A domain whose hostname falls in one of these zones gets its record
						created for you and a certificate over DNS-01, so wildcards and
						hostnames behind Cloudflare's proxy work without opening port 80.
					</p>
				</div>
			)}
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Remove ${deleting?.name ?? "provider"}?`}
				description="LogiStack forgets the credentials. Records it already created stay at the provider. A provider that domains still use can't be removed."
				action="Remove"
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.id);
					toast.success(`${deleting.name} removed`);
				}}
			/>
		</Page>
	);
}
