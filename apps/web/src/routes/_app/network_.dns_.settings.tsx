import { type HomeDns, Ipv4 } from "@logistack/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExternalLink, Eye, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { HomeDnsPage, homeDnsMeta } from "@/components/network/home-dns";
import {
	fromUpstream,
	toUpstream,
	UpstreamFields,
	upstreamIssue,
} from "@/components/network/upstream-fields";
import { Panel } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	type HomeDnsApi,
	homeDnsApi,
	useHomeDnsMutation,
} from "@/lib/api/home-dns";
import { nodesQuery } from "@/lib/api/monitoring";

export const Route = createFileRoute("/_app/network_/dns_/settings")({
	staticData: { crumb: "DNS settings" },
	component: SettingsPage,
});

function SettingsPage() {
	return (
		<HomeDnsPage
			to="/network/dns/settings"
			title="DNS settings"
			needsReady={false}
			className="max-w-3xl"
		>
			{(dns) => (
				<div className="grid gap-8">
					<ServicePanel dns={dns} />
					<UpstreamPanel dns={dns} />
					<LocalZonePanel dns={dns} />
					<PlacementPanel dns={dns} />
					<ConsolePanel />
					<DisablePanel />
				</div>
			)}
		</HomeDnsPage>
	);
}

type Update = Parameters<HomeDnsApi["update"]>[0];

function useUpdate(success: string) {
	const m = useHomeDnsMutation((u: Update) => homeDnsApi.update(u));
	return {
		...m,
		save: (u: Update, done?: () => void) =>
			m.mutate(u, {
				onSuccess: () => {
					toast.success(success);
					done?.();
				},
				onError: (e) =>
					toast.error("Couldn't save", { description: e.message }),
			}),
	};
}

function SaveRow({
	dirty,
	pending,
	children,
}: {
	dirty: boolean;
	pending: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-end gap-3 border-t bg-muted/30 px-4 py-3">
			{children}
			<Button type="submit" size="sm" disabled={!dirty || pending}>
				{pending && <Loader2 className="animate-spin" />}
				Save
			</Button>
		</div>
	);
}

function ServicePanel({ dns }: { dns: HomeDns }) {
	const update = useUpdate(
		dns.desiredState === "stopped"
			? "Starting the home DNS"
			: "Stopping the home DNS",
	);
	const [confirmStop, setConfirmStop] = useState(false);
	const stopped = dns.desiredState === "stopped";
	return (
		<Panel title="Service" id="dns-service">
			<div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
				<div className="min-w-0 flex-1">
					<StatusLabel meta={homeDnsMeta(dns)} />
					<p className="mt-1 text-sm text-pretty text-muted-foreground">
						{dns.statusMessage ??
							(stopped
								? "Devices that use it can't resolve names until it starts again."
								: `Technitium ${dns.version ?? ""} on ${dns.nodeHostname ?? "its node"}, answering at ${dns.lanAddress}.`)}
					</p>
				</div>
				<Button
					variant="outline"
					disabled={update.isPending}
					onClick={() =>
						stopped
							? update.save({ desiredState: "running" })
							: setConfirmStop(true)
					}
				>
					{update.isPending && <Loader2 className="animate-spin" />}
					{stopped ? "Start" : "Stop"}
				</Button>
			</div>
			<ConfirmDialog
				open={confirmStop}
				onOpenChange={setConfirmStop}
				title="Stop the home DNS?"
				description="Devices that use it as their DNS server lose name resolution, so most of the internet stops working for them, until you start it again or change the router's DNS."
				confirmLabel="Stop"
				pending={update.isPending}
				onConfirm={() =>
					update.save({ desiredState: "stopped" }, () => setConfirmStop(false))
				}
			/>
		</Panel>
	);
}

function UpstreamPanel({ dns }: { dns: HomeDns }) {
	const settings = dns.settings;
	const initial = settings ? fromUpstream(settings.upstream) : undefined;
	const [draft, setDraft] = useState(initial);
	const [dnssec, setDnssec] = useState(settings?.dnssecValidation ?? true);
	const update = useUpdate("Upstream saved");
	if (!draft || !initial || !settings) return null;
	const issue = upstreamIssue(draft);
	const key = (u: typeof settings.upstream) =>
		`${u.protocol} ${u.servers.join(",")}`;
	const dirty =
		key(toUpstream(draft)) !== key(settings.upstream) ||
		dnssec !== settings.dnssecValidation;
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (issue) return;
		update.save({
			settings: { upstream: toUpstream(draft), dnssecValidation: dnssec },
		});
	};
	return (
		<Panel title="Upstream resolver" id="dns-upstream">
			<form onSubmit={submit} noValidate>
				<div className="grid gap-5 p-4">
					<p className="text-sm text-pretty text-muted-foreground">
						Where the home DNS asks for names it doesn't know. Encrypted, so
						your internet provider sees neither the names nor the answers.
					</p>
					<UpstreamFields
						idPrefix="settings-upstream"
						value={draft}
						onChange={setDraft}
						error={issue}
					/>
					<div className="flex items-start justify-between gap-6">
						<label htmlFor="dnssec" className="grid gap-0.5 text-sm">
							<span className="font-medium">Validate DNSSEC</span>
							<span className="text-pretty text-muted-foreground">
								Refuses answers whose signatures don't check out.
							</span>
						</label>
						<Switch id="dnssec" checked={dnssec} onCheckedChange={setDnssec} />
					</div>
				</div>
				<SaveRow dirty={dirty} pending={update.isPending} />
			</form>
		</Panel>
	);
}

const ZONE =
	/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function LocalZonePanel({ dns }: { dns: HomeDns }) {
	const current = dns.settings?.localZone ?? "";
	const [zone, setZone] = useState(current);
	const [error, setError] = useState<string>();
	const update = useUpdate("Local zone saved");
	const next = zone.trim().toLowerCase().replace(/\.$/, "");
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (next && !ZONE.test(next)) {
			setError("Enter a zone name like home.lan, or leave it empty.");
			return;
		}
		update.save({ settings: { localZone: next || null } });
	};
	return (
		<Panel title="Local zone" id="dns-local-zone">
			<form onSubmit={submit} noValidate>
				<div className="p-4">
					<Field
						id="local-zone"
						label="Zone name"
						optional
						error={error}
						hint="Created when missing. A made-up name like home.lan gets no public certificate; use a domain you own for HTTPS without warnings. Clearing it keeps the zone and its records."
					>
						<Input
							id="local-zone"
							value={zone}
							onChange={(e) => {
								setZone(e.target.value);
								setError(undefined);
							}}
							placeholder="home.lan"
							spellCheck={false}
							autoCapitalize="none"
							className="max-w-xs font-mono"
							aria-invalid={error ? true : undefined}
							aria-describedby="local-zone-msg"
						/>
					</Field>
				</div>
				<SaveRow dirty={next !== current} pending={update.isPending} />
			</form>
		</Panel>
	);
}

function PlacementPanel({ dns }: { dns: HomeDns }) {
	const { data: nodes } = useQuery(nodesQuery);
	const [nodeId, setNodeId] = useState(dns.nodeId ?? "");
	const [address, setAddress] = useState(dns.lanAddress ?? "");
	const [error, setError] = useState<string>();
	const [confirming, setConfirming] = useState(false);
	const update = useUpdate("Moving the home DNS");
	const moving = nodeId !== dns.nodeId;
	const dirty = moving || address.trim() !== dns.lanAddress;
	const apply = () =>
		update.save({ nodeId, lanAddress: address.trim() }, () =>
			setConfirming(false),
		);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!Ipv4.safeParse(address.trim()).success) {
			setError("Enter an IPv4 address like 192.168.1.2.");
			return;
		}
		if (moving) setConfirming(true);
		else apply();
	};
	return (
		<Panel title="Where it runs" id="dns-placement">
			<form onSubmit={submit} noValidate>
				<div className="grid gap-4 p-4 sm:grid-cols-2">
					<Field id="dns-node" label="Node">
						<Select value={nodeId} onValueChange={setNodeId}>
							<SelectTrigger id="dns-node" className="w-full">
								<SelectValue placeholder="Pick a node" />
							</SelectTrigger>
							<SelectContent>
								{(nodes ?? []).map((n) => (
									<SelectItem key={n.id} value={n.id}>
										{n.hostname}
										<span className="text-muted-foreground">
											{n.role === "manager" ? " · manager" : ""}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field
						id="dns-address"
						label="Address devices use"
						error={error}
						hint="The node's address on your home network. Your router hands it out as the DNS server."
					>
						<Input
							id="dns-address"
							value={address}
							onChange={(e) => {
								setAddress(e.target.value);
								setError(undefined);
							}}
							inputMode="decimal"
							spellCheck={false}
							className="font-mono tabular-nums"
							aria-invalid={error ? true : undefined}
							aria-describedby="dns-address-msg"
						/>
					</Field>
				</div>
				<SaveRow dirty={dirty} pending={update.isPending} />
			</form>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Move the home DNS to another node?"
				description="Technitium starts there with a fresh data volume. Zones, records and allow or block entries made by hand stay on the old node's volume. Port 53 must be free on the new node."
				confirmLabel="Move"
				destructive={false}
				pending={update.isPending}
				onConfirm={apply}
			/>
		</Panel>
	);
}

function ConsolePanel() {
	const reveal = useMutation({ mutationFn: () => homeDnsApi.console() });
	const c = reveal.data;
	return (
		<Panel title="Technitium console" id="dns-console">
			<div className="grid gap-4 p-4">
				<p className="text-sm text-pretty text-muted-foreground">
					The advanced console, for everything LogiStack doesn't cover: cache,
					DHCP, apps, other record types and zone options. Reachable only from
					your home network. Revealing the password is written to the audit log.
				</p>
				{c ? (
					<dl className="t-reveal grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
						<dt className="text-sm text-muted-foreground">Address</dt>
						<dd className="flex min-w-0 items-center gap-2">
							<CopyField
								value={c.url}
								label="Copy console address"
								className="min-w-0 flex-1"
							/>
							<Button asChild variant="outline" size="sm">
								<a href={c.url} target="_blank" rel="noreferrer">
									Open
									<ExternalLink data-icon="inline-end" />
								</a>
							</Button>
						</dd>
						<dt className="text-sm text-muted-foreground">Username</dt>
						<dd>
							<CopyField value={c.username} label="Copy username" />
						</dd>
						<dt className="text-sm text-muted-foreground">Password</dt>
						<dd>
							<CopyField value={c.password} label="Copy password" />
						</dd>
					</dl>
				) : (
					<div>
						<Button
							variant="outline"
							disabled={reveal.isPending}
							onClick={() => reveal.mutate()}
						>
							{reveal.isPending ? (
								<Loader2 className="animate-spin" />
							) : (
								<Eye data-icon="inline-start" />
							)}
							Show console address and password
						</Button>
						{reveal.isError && (
							<p className="mt-2 text-sm text-bad-text">
								{reveal.error.message}
							</p>
						)}
					</div>
				)}
			</div>
		</Panel>
	);
}

const CONFIRM_WORD = "delete";

function DisablePanel() {
	const navigate = useNavigate();
	const disable = useHomeDnsMutation(() => homeDnsApi.disable());
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	return (
		<Panel title="Turn off" id="dns-disable">
			<div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
				<p className="min-w-0 flex-1 text-sm text-pretty text-muted-foreground">
					Removes Technitium and deletes its data for good: zones, records,
					allow and block lists, and the query log. Set your router back to
					another DNS server first.
				</p>
				<Button variant="destructive" onClick={() => setOpen(true)}>
					Turn off and delete data
				</Button>
			</div>
			<ConfirmDialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) setTyped("");
				}}
				title="Turn off the home DNS and delete its data?"
				description="This permanently deletes every zone, record, allowed and blocked domain and the query log. It can't be undone. Devices still pointed at it stop resolving names."
				confirmLabel="Delete permanently"
				confirmDisabled={typed.trim().toLowerCase() !== CONFIRM_WORD}
				pending={disable.isPending}
				onConfirm={() =>
					disable.mutate(undefined, {
						onSuccess: () => {
							toast.success("Home DNS turned off");
							navigate({ to: "/settings/general" });
						},
						onError: (e) =>
							toast.error("Couldn't turn it off", { description: e.message }),
					})
				}
			>
				<Field id="disable-confirm" label={`Type ${CONFIRM_WORD} to confirm`}>
					<Input
						id="disable-confirm"
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						autoComplete="off"
						spellCheck={false}
						autoFocus
					/>
				</Field>
			</ConfirmDialog>
		</Panel>
	);
}
