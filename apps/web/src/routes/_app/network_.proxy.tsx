import type { HomeProxy, HomeProxyRoute } from "@logistack/contracts";
import { HomeProxyEnableInput } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	CircleAlert,
	Download,
	Loader2,
	Pencil,
	Plus,
	Route as RouteIcon,
	ServerCog,
	Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton, CopyField } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import {
	downloadCaRoot,
	RouteDialog,
	TLS_LABEL,
} from "@/components/network/home-proxy";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	homeProxyApi,
	homeProxyRoutesQuery,
	useHomeProxy,
	useHomeProxyMutation,
} from "@/lib/api/home-proxy";
import { nodesQuery } from "@/lib/api/monitoring";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/network_/proxy")({
	staticData: { crumb: "Local proxy" },
	component: LocalProxyPage,
});

/** Where to edit: null closed, "new" adding, a route editing. */
type Editing = null | "new" | HomeProxyRoute;

function LocalProxyPage() {
	const s = section("/network/proxy");
	const { data: proxy, admin, me, isError, error, refetch } = useHomeProxy();
	const [editing, setEditing] = useState<Editing>(null);
	const on = proxy?.enabled && proxy.zone;
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title={s.title}
				description={s.description}
				actions={
					on && (
						<Button onClick={() => setEditing("new")}>
							<Plus data-icon="inline-start" />
							Add route
						</Button>
					)
				}
			/>
			{me && !admin ? (
				<EmptyState
					icon={ServerCog}
					title="Only instance admins manage the local proxy"
					description="It belongs to the whole server, not to an organization. Ask an instance admin to add you."
				/>
			) : isError ? (
				<EmptyState
					icon={CircleAlert}
					title="Couldn't load the local proxy"
					description={error.message}
				>
					<Button variant="outline" onClick={() => refetch()}>
						Try again
					</Button>
				</EmptyState>
			) : !proxy ? (
				<Panel title="Local proxy" id="proxy-loading">
					<SkeletonRows rows={3} />
				</Panel>
			) : !proxy.enabled || !proxy.zone ? (
				<EmptyState
					icon={RouteIcon}
					title="The local proxy is off"
					description="Give devices in the house HTTPS names with a valid certificate, like nas.home.example.com, without exposing them to the internet."
				>
					<Button asChild>
						<Link to="/network/proxy/new">Set up local proxy</Link>
					</Button>
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<OverviewPanel proxy={proxy} />
					{proxy.tls === "internal" && <CaRootPanel proxy={proxy} />}
					<RoutesPanel
						zone={proxy.zone}
						editing={editing}
						setEditing={setEditing}
					/>
					<SettingsPanel proxy={proxy} />
					<DisablePanel />
				</div>
			)}
		</Page>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-sm">{children}</dd>
		</div>
	);
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function OverviewPanel({ proxy }: { proxy: HomeProxy }) {
	const wildcard = `*.${proxy.zone}`;
	const { data: nodes } = useQuery(nodesQuery);
	// The proxy listens on the manager; its address is the best guess, when it is a LAN one.
	const leader = (nodes?.find((n) => n.leader) ?? nodes?.[0])?.address;
	const lan = leader && PRIVATE_V4.test(leader) ? leader : null;
	return (
		<Panel title="Overview" id="proxy-overview">
			<dl className="divide-y">
				<Row label="Zone">
					<span className="font-mono">{proxy.zone}</span>
				</Row>
				<Row label="Certificate">
					{proxy.tls === "acme" ? (
						<>
							{TLS_LABEL.acme} for <span className="font-mono">{wildcard}</span>
							<span className="block text-muted-foreground">
								{proxy.dnsProvider
									? `Renewed over DNS-01 through ${proxy.dnsProvider}. No public record points at this server.`
									: "No connected DNS provider holds this zone, so the certificate can't renew. Connect one or switch to the internal certificate authority."}
							</span>
						</>
					) : (
						<>
							{TLS_LABEL.internal}
							<span className="block text-muted-foreground">
								Signed by the proxy itself. Devices show a warning until they
								trust its root certificate.
							</span>
						</>
					)}
				</Row>
				{proxy.statusMessage && (
					<Row label="Status">
						<span className="text-muted-foreground">{proxy.statusMessage}</span>
					</Row>
				)}
				<Row label="DNS records">
					{proxy.automaticRecords ? (
						<>
							Automatic
							<span className="block text-muted-foreground">
								The home DNS answers every name in {proxy.zone} with{" "}
								<span className="font-mono text-foreground">
									{proxy.lanAddress}
								</span>
								.
							</span>
						</>
					) : (
						<div className="grid gap-2">
							<p className="text-pretty">
								Point the names at this server's address on your network, in
								your router's DNS or a local DNS server. One wildcard A record
								covers every route:
							</p>
							<div className="grid max-w-md gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
								<CopyField value={wildcard} label="Copy name" />
								<span className="text-center text-muted-foreground" aria-hidden>
									→
								</span>
								<span className="sr-only">points to</span>
								{lan ? (
									<CopyField value={lan} label="Copy address" />
								) : (
									<span className="text-muted-foreground">
										the server's LAN address
									</span>
								)}
							</div>
							<p className="text-pretty text-muted-foreground">
								Or turn on the{" "}
								<Link to="/network/dns/new" className="underline">
									home DNS
								</Link>{" "}
								and LogiStack writes the records itself.
							</p>
						</div>
					)}
				</Row>
			</dl>
		</Panel>
	);
}

function CaRootPanel({ proxy }: { proxy: HomeProxy }) {
	const pem = proxy.caRootPem;
	return (
		<Panel title="Root certificate" id="proxy-ca">
			<div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
				<p className="min-w-0 flex-1 text-sm text-pretty text-muted-foreground">
					{pem
						? "Install it on each device as a trusted root: on macOS in Keychain Access, on iOS through Settings after opening the file, on Windows in the Trusted Root store. Browsers then accept every name in the zone."
						: "The proxy is creating its certificate authority. The root certificate appears here in a few seconds."}
				</p>
				<Button
					variant="outline"
					disabled={!pem}
					onClick={() => pem && downloadCaRoot(pem)}
				>
					{pem ? (
						<Download data-icon="inline-start" />
					) : (
						<Loader2 className="animate-spin" />
					)}
					Download logistack-local-ca.crt
				</Button>
			</div>
		</Panel>
	);
}

function RoutesPanel({
	zone,
	editing,
	setEditing,
}: {
	zone: string;
	editing: Editing;
	setEditing: (e: Editing) => void;
}) {
	const { data, error } = useQuery(homeProxyRoutesQuery);
	const add = useHomeProxyMutation(homeProxyApi.addRoute);
	const update = useHomeProxyMutation(
		(v: { id: string; r: Parameters<typeof homeProxyApi.addRoute>[0] }) =>
			homeProxyApi.updateRoute(v.id, v.r),
	);
	const remove = useHomeProxyMutation(homeProxyApi.deleteRoute);
	const [deleting, setDeleting] = useState<HomeProxyRoute | null>(null);
	const route = editing && editing !== "new" ? editing : null;

	return (
		<Panel title="Routes" id="proxy-routes">
			{error ? (
				<p className="px-4 py-10 text-center text-sm text-bad-text">
					{error.message}
				</p>
			) : !data ? (
				<SkeletonRows rows={3} />
			) : data.length === 0 ? (
				<div className="flex flex-col items-center gap-4 px-4 py-12 text-center">
					<p className="max-w-[46ch] text-sm text-muted-foreground">
						No routes yet. Add one to reach a device at an HTTPS name, like nas.
						{zone}.
					</p>
					<Button variant="outline" onClick={() => setEditing("new")}>
						<Plus data-icon="inline-start" />
						Add route
					</Button>
				</div>
			) : (
				<div className="relative overflow-x-auto">
					<table className="w-full min-w-[36rem] text-sm" aria-label="Routes">
						<thead>
							<tr className="border-b text-left text-xs text-muted-foreground">
								<th scope="col" className="h-9 px-4 font-medium">
									Name
								</th>
								<th scope="col" className="h-9 px-4 font-medium">
									Device
								</th>
								<th scope="col" className="h-9 w-24 px-2">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{data.map((r) => (
								<tr
									key={r.id}
									className="border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50"
								>
									<td className="h-12 max-w-0 px-4">
										<span className="flex min-w-0 items-center gap-1">
											<a
												href={`https://${r.hostname}`}
												target="_blank"
												rel="noreferrer"
												className="truncate font-mono text-xs underline-offset-4 hover:underline"
											>
												{r.hostname}
											</a>
											<CopyButton
												value={`https://${r.hostname}`}
												label={`Copy https://${r.hostname}`}
												className="size-7 shrink-0"
											/>
										</span>
									</td>
									<td className="h-12 max-w-0 px-4">
										<span className="flex min-w-0 items-center gap-2">
											<span
												className="truncate font-mono text-xs"
												title={r.upstream}
											>
												{r.upstream}
											</span>
											{r.insecure && (
												<span
													className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground"
													title="The device's certificate isn't verified"
												>
													Unverified TLS
												</span>
											)}
										</span>
									</td>
									<td className="h-12 px-2 text-right whitespace-nowrap">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Edit ${r.hostname}`}
											onClick={() => setEditing(r)}
										>
											<Pencil />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Delete ${r.hostname}`}
											onClick={() => setDeleting(r)}
										>
											<Trash2 />
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<RouteDialog
				open={editing !== null}
				onOpenChange={(o) => !o && setEditing(null)}
				zone={zone}
				route={route}
				onSave={(r) =>
					(route
						? update.mutateAsync({ id: route.id, r })
						: add.mutateAsync(r)
					).then((saved) =>
						toast.success(
							route ? `Saved ${saved.hostname}` : `Added ${saved.hostname}`,
						),
					)
				}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.hostname ?? "route"}?`}
				description="The name stops answering. The device itself is untouched."
				confirmLabel="Delete route"
				pending={remove.isPending}
				onConfirm={() =>
					deleting &&
					remove.mutate(deleting.id, {
						onSuccess: () => setDeleting(null),
						onError: (e) =>
							toast.error("Couldn't delete the route", {
								description: e.message,
							}),
					})
				}
			/>
		</Panel>
	);
}

function SettingsPanel({ proxy }: { proxy: HomeProxy }) {
	const [zone, setZone] = useState(proxy.zone ?? "");
	const [tls, setTls] = useState(proxy.tls ?? "acme");
	const [error, setError] = useState<string>();
	const [confirming, setConfirming] = useState(false);
	const update = useHomeProxyMutation(homeProxyApi.update);
	const next = zone.trim().toLowerCase().replace(/\.$/, "");
	const zoneChanged = next !== proxy.zone;
	const dirty = zoneChanged || tls !== proxy.tls;
	const apply = () =>
		update.mutate(
			{ ...(zoneChanged && { zone: next }), ...(tls !== proxy.tls && { tls }) },
			{
				onSuccess: () => {
					setConfirming(false);
					toast.success("Local proxy saved");
				},
				onError: (e) => {
					setConfirming(false);
					toast.error("Couldn't save", { description: e.message });
				},
			},
		);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const r = HomeProxyEnableInput.shape.zone.safeParse(zone);
		if (!r.success) {
			setError("Enter a domain name such as home.example.com.");
			return;
		}
		if (zoneChanged) setConfirming(true);
		else apply();
	};
	return (
		<Panel title="Settings" id="proxy-settings">
			<form onSubmit={submit} noValidate>
				<div className="grid gap-4 p-4 sm:grid-cols-2">
					<Field
						id="proxy-zone"
						label="Zone"
						error={error}
						hint="Routes answer at a name under it."
					>
						<Input
							id="proxy-zone"
							value={zone}
							onChange={(e) => {
								setZone(e.target.value);
								setError(undefined);
							}}
							spellCheck={false}
							autoCapitalize="none"
							className="font-mono"
							aria-invalid={error ? true : undefined}
							aria-describedby="proxy-zone-msg"
						/>
					</Field>
					<Field
						id="proxy-tls"
						label="Certificate"
						hint={
							tls === "acme"
								? "Needs a connected DNS provider that holds the zone."
								: "Devices must trust the proxy's root certificate."
						}
					>
						<Select value={tls} onValueChange={(v) => setTls(v as typeof tls)}>
							<SelectTrigger id="proxy-tls" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="acme">{TLS_LABEL.acme}</SelectItem>
								<SelectItem value="internal">{TLS_LABEL.internal}</SelectItem>
							</SelectContent>
						</Select>
					</Field>
				</div>
				<div className="flex items-center justify-end gap-3 border-t bg-muted/30 px-4 py-3">
					<Button type="submit" size="sm" disabled={!dirty || update.isPending}>
						{update.isPending && <Loader2 className="animate-spin" />}
						Save
					</Button>
				</div>
			</form>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`Move every route to ${next}?`}
				description={`Each route answers at <name>.${next} instead, and the old names stop working. The proxy gets a new certificate for the new zone.`}
				confirmLabel="Change zone"
				destructive={false}
				pending={update.isPending}
				onConfirm={apply}
			/>
		</Panel>
	);
}

function DisablePanel() {
	const navigate = useNavigate();
	const { data: routes } = useQuery(homeProxyRoutesQuery);
	const disable = useHomeProxyMutation(homeProxyApi.disable);
	const [open, setOpen] = useState(false);
	const n = routes?.length ?? 0;
	return (
		<Panel title="Turn off" id="proxy-disable">
			<div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
				<p className="min-w-0 flex-1 text-sm text-pretty text-muted-foreground">
					Stops answering every name in the zone and deletes the routes. The
					devices themselves are untouched.
				</p>
				<Button variant="destructive" onClick={() => setOpen(true)}>
					Turn off
				</Button>
			</div>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Turn off the local proxy?"
				description={
					n
						? `This deletes ${n === 1 ? "its route" : `all ${n} routes`} for good, and their names stop answering. Setting it up again starts with no routes.`
						: "Nothing answers in the zone until you set it up again."
				}
				confirmLabel={n ? "Turn off and delete routes" : "Turn off"}
				pending={disable.isPending}
				onConfirm={() =>
					// Async: the page swaps to its off state, unmounting this panel, before mutate's callbacks would run.
					disable.mutateAsync(undefined).then(
						() => {
							toast.success("Local proxy turned off");
							navigate({ to: "/settings/general" });
						},
						(e: Error) =>
							toast.error("Couldn't turn it off", { description: e.message }),
					)
				}
			/>
		</Panel>
	);
}
