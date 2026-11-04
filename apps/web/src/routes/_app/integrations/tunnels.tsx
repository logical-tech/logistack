import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Cable, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import {
	ConfirmDelete,
	DataChip,
	KindTile,
} from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { useInvalidating } from "@/lib/api/networking";
import { type Tunnel, tunnelsApi, tunnelsQuery } from "@/lib/api/tunnels";
import { relativeTime } from "@/lib/format";
import type { StatusMeta } from "@/lib/status";

export const Route = createFileRoute("/_app/integrations/tunnels")({
	staticData: { crumb: "Cloudflare Tunnels" },
	component: TunnelsPage,
});

const STATUS: Record<NonNullable<Tunnel["status"]>, StatusMeta> = {
	healthy: { label: "Connected", tone: "ok" },
	degraded: { label: "Degraded", tone: "warn" },
	inactive: { label: "Starting", tone: "busy", live: true },
	down: { label: "Down", tone: "bad" },
};

function TunnelRow({ t, onDelete }: { t: Tunnel; onDelete: () => void }) {
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<KindTile icon={Cable} />
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{t.name}</p>
					<p className="truncate text-xs text-muted-foreground">
						{t.dnsProviderName} · added {relativeTime(t.createdAt)}
					</p>
					{t.statusMessage && (
						<p
							className="truncate text-xs text-bad-text"
							title={t.statusMessage}
						>
							{t.statusMessage}
						</p>
					)}
				</div>
			</div>
			<DataChip>{t.tunnelId.slice(0, 8)}</DataChip>
			<div className="flex items-center justify-between gap-4 sm:w-64 sm:justify-end">
				{t.status ? (
					<StatusLabel meta={STATUS[t.status]} />
				) : (
					<span className="text-sm text-muted-foreground">Unreachable</span>
				)}
				<span className="tabular text-sm text-muted-foreground">
					{t.usedBy === 0
						? "No domains"
						: `${t.usedBy} domain${t.usedBy === 1 ? "" : "s"}`}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Delete ${t.name}`}
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function TunnelsPage() {
	const { data, isPending } = useQuery(tunnelsQuery);
	const [deleting, setDeleting] = useState<Tunnel | null>(null);
	const remove = useInvalidating(tunnelsApi.remove, [["tunnels"]]);
	const add = (
		<Button asChild>
			<Link to="/integrations/tunnels/new">
				<Plus data-icon="inline-start" />
				Create tunnel
			</Link>
		</Button>
	);
	return (
		<Page>
			<PageHeader
				title="Cloudflare Tunnels"
				description="Publish services without opening ports: cloudflared dials out to Cloudflare, which serves the hostname and its certificate."
				actions={data?.length ? add : undefined}
			/>
			{isPending ? (
				<Panel title="Tunnels" id="tunnels">
					<SkeletonRows rows={2} />
				</Panel>
			) : !data?.length ? (
				<EmptyState
					icon={Cable}
					title="No tunnels yet"
					description="Good for a homelab or a server behind NAT: nothing listens on the public internet, and you choose per domain what goes through the tunnel."
				>
					{add}
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<Panel title="Tunnels" id="tunnels">
						<ul className="divide-y">
							{data.map((t) => (
								<TunnelRow key={t.id} t={t} onDelete={() => setDeleting(t)} />
							))}
						</ul>
					</Panel>
					<p className="max-w-[70ch] text-sm text-muted-foreground">
						When you add a domain in a zone of the tunnel's provider, pick{" "}
						<span className="text-foreground">Cloudflare Tunnel</span>.
						LogiStack creates the proxied CNAME and adds the hostname to the
						tunnel for you.
					</p>
				</div>
			)}
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "tunnel"}?`}
				description="LogiStack stops cloudflared and deletes the tunnel at Cloudflare. A tunnel that domains still use can't be deleted."
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.id);
					toast.success(`${deleting.name} deleted`);
				}}
			/>
		</Page>
	);
}
