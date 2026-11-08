import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Orbit, Plus, Trash2 } from "lucide-react";
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
import {
	type TailscalePublication,
	tailscaleApi,
	tailscaleQuery,
} from "@/lib/api/tailscale";
import { relativeTime } from "@/lib/format";

export const Route = createFileRoute("/_app/integrations/tailscale")({
	staticData: { crumb: "Tailscale" },
	component: TailscalePage,
});

function PublicationRow({
	p,
	onDelete,
}: {
	p: TailscalePublication;
	onDelete: () => void;
}) {
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<KindTile icon={Orbit} />
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{p.hostname}</p>
					<p className="truncate text-xs text-muted-foreground">
						{p.serviceName} · port {p.port} · added {relativeTime(p.createdAt)}
					</p>
					{p.statusMessage && (
						<p
							className="truncate text-xs text-bad-text"
							title={p.statusMessage}
						>
							{p.statusMessage}
						</p>
					)}
				</div>
			</div>
			<DataChip>{p.https ? "https · tailnet cert" : "http"}</DataChip>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`Stop publishing ${p.hostname}`}
				onClick={onDelete}
			>
				<Trash2 />
			</Button>
		</li>
	);
}

function TailscalePage() {
	const { data, isPending } = useQuery(tailscaleQuery);
	const [deleting, setDeleting] = useState<TailscalePublication | null>(null);
	const [disabling, setDisabling] = useState(false);
	const unpublish = useInvalidating(tailscaleApi.unpublish, [["tailscale"]]);
	const disable = useInvalidating(tailscaleApi.disable, [["tailscale"]]);
	const publish = (
		<Button asChild>
			<Link to="/integrations/tailscale/new">
				<Plus data-icon="inline-start" />
				Publish a service
			</Link>
		</Button>
	);
	return (
		<Page>
			<PageHeader
				title="Tailscale"
				description="Join every server to your tailnet and publish chosen services on tailnet hostnames, reachable only by your devices."
				actions={data?.enabled ? publish : undefined}
			/>
			{isPending ? (
				<Panel title="Tailnet" id="tailnet">
					<SkeletonRows rows={2} />
				</Panel>
			) : !data?.enabled ? (
				<EmptyState
					icon={Orbit}
					title="Tailscale is off"
					description="Good for admin tools and servers without a public IP: nothing listens on the internet, and only devices in your tailnet reach what you publish."
				>
					<Button asChild>
						<Link to="/integrations/tailscale/new">Set up Tailscale</Link>
					</Button>
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<Panel title="Nodes" id="tailnet">
						<div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
							<div className="min-w-0 flex-1">
								<p className="text-sm font-medium">
									tailscaled on every server
								</p>
								<p className="text-xs text-pretty text-muted-foreground">
									Each server joins under its hostname, with userspace
									networking and in-memory state.
								</p>
								{data.statusMessage && (
									<p className="text-xs text-bad-text">{data.statusMessage}</p>
								)}
							</div>
							<StatusLabel
								meta={
									data.statusMessage
										? { label: "Failing", tone: "bad" }
										: data.nodesRunning
											? { label: "Running", tone: "ok" }
											: { label: "Starting", tone: "busy", live: true }
								}
							/>
							<Button variant="outline" onClick={() => setDisabling(true)}>
								Turn off
							</Button>
						</div>
					</Panel>
					<Panel title="Published services" id="publications">
						{data.publications.length ? (
							<ul className="divide-y">
								{data.publications.map((p) => (
									<PublicationRow
										key={p.id}
										p={p}
										onDelete={() => setDeleting(p)}
									/>
								))}
							</ul>
						) : (
							<p className="px-4 py-3.5 text-sm text-muted-foreground">
								Nothing is published yet. Servers are on the tailnet; publish a
								service to give it its own tailnet hostname.
							</p>
						)}
					</Panel>
				</div>
			)}
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Stop publishing ${deleting?.hostname ?? "service"}?`}
				description="LogiStack removes its tailnet machine. The service keeps running."
				action="Stop publishing"
				onConfirm={async () => {
					if (!deleting) return;
					await unpublish.mutateAsync(deleting.id);
					toast.success(`${deleting.hostname} is no longer published`);
				}}
			/>
			<ConfirmDelete
				open={disabling}
				onOpenChange={setDisabling}
				action="Turn off"
				title="Turn Tailscale off?"
				description="LogiStack forgets the auth key and removes tailscaled from every server and every published service's tailnet machine. With an ephemeral key, the machines leave your tailnet on their own."
				onConfirm={async () => {
					await disable.mutateAsync(undefined);
					toast.success("Tailscale is off");
				}}
			/>
		</Page>
	);
}
