import { type HomeDns, HomeDnsSettings, Ipv4 } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	Check,
	CircleAlert,
	Loader2,
	Server,
	ServerCog,
	ShieldBan,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CopyButton, CopyField } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { NameTest } from "@/components/network/home-dns";
import {
	BLOCKLISTS,
	listName,
	PROTOCOLS,
	UPSTREAMS,
} from "@/components/network/presets";
import {
	toUpstream,
	UpstreamFields,
	upstreamIssue,
} from "@/components/network/upstream-fields";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Instructions, Summary } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { homeDnsApi, useHomeDns, useHomeDnsMutation } from "@/lib/api/home-dns";
import { nodesQuery } from "@/lib/api/monitoring";
import type { ClusterNode } from "@/lib/api/types";
import { stepParam } from "@/lib/search";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/network_/dns_/new")({
	staticData: { crumb: "Set up home DNS" },
	validateSearch: z.object({ step: stepParam }),
	component: SetUpHomeDns,
});

type V = {
	nodeId: string;
	lanAddress: string;
	upPreset: string;
	upProtocol: "Https" | "Tls" | "Udp";
	upServers: string;
	dnssec: boolean;
	blocking: boolean;
	lists: string[];
	customLists: string;
	localZone: string;
	/** Set once this wizard turned the feature on, so its progress belongs to this run. */
	submitted: boolean;
};

const ENABLE_DNS =
	"curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash -s -- --enable-dns";

const ZONE =
	/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const draft = (v: V) => ({
	preset: v.upPreset,
	protocol: v.upProtocol,
	servers: v.upServers,
});

const customUrls = (v: V) =>
	v.customLists
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);

function settingsOf(v: V): HomeDnsSettings {
	return HomeDnsSettings.parse({
		upstream: toUpstream(draft(v)),
		dnssecValidation: v.dnssec,
		blocking: {
			enabled: v.blocking,
			listUrls: v.blocking ? [...new Set([...v.lists, ...customUrls(v)])] : [],
		},
		localZone: v.localZone.trim().toLowerCase() || null,
	});
}

const PHASES = [
	{ id: "starting", label: "Start Technitium on the node" },
	{ id: "configuring", label: "Apply upstream, block lists and zone" },
	{ id: "ready", label: "Answer queries" },
] as const;

/** The apply step: turns the feature on, then shows the worker's status machine as it is. */
function Apply({ w, dns }: { w: WizardApi<V>; dns: HomeDns | undefined }) {
	const enable = useHomeDnsMutation(homeDnsApi.enable);
	const [error, setError] = useState<string | null>(null);
	const { set, values: v } = w;
	const started = v.submitted && dns?.enabled;
	const run = async () => {
		setError(null);
		try {
			await enable.mutateAsync({
				nodeId: v.nodeId,
				lanAddress: v.lanAddress.trim(),
				settings: settingsOf(v),
			});
			set("submitted", true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	const status = started ? dns.status : null;
	const at = PHASES.findIndex((p) => p.id === status);
	const failed = status === "error";
	return (
		<div className="grid gap-4" aria-live="polite">
			{!started ? (
				<div className="rounded-lg bg-muted/60 p-4 dark:bg-muted/40">
					<div className="flex items-start gap-3">
						<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
							{error ? (
								<CircleAlert className="t-reveal size-5 text-bad-text" />
							) : (
								<span className="size-2 rounded-full bg-idle" />
							)}
						</span>
						<div className="min-w-0 flex-1 text-sm">
							{error ? (
								<>
									<p className="font-medium text-bad-text">It didn't start</p>
									<p className="mt-0.5 text-pretty text-muted-foreground">
										{error}
									</p>
								</>
							) : (
								<p className="text-muted-foreground">
									Nothing has changed yet. The worker pulls Technitium and
									starts it on the node you picked.
								</p>
							)}
						</div>
						<Button type="button" onClick={run} disabled={enable.isPending}>
							{enable.isPending && <Loader2 className="animate-spin" />}
							{error ? "Try again" : "Turn on"}
						</Button>
					</div>
				</div>
			) : (
				<ol className="divide-y rounded-lg bg-card ring-1 ring-border">
					{PHASES.map((p, i) => {
						const done =
							!failed && (i < at || (status === "ready" && i === at));
						const current =
							!done && (failed ? i === Math.max(at, 0) : i === at);
						return (
							<li key={p.id} className="flex items-center gap-3 px-4 py-3">
								<span className="grid size-5 shrink-0 place-items-center">
									{done ? (
										<span className="t-reveal grid size-5 place-items-center rounded-full bg-ok text-background">
											<Check className="size-3" strokeWidth={3} aria-hidden />
										</span>
									) : current && failed ? (
										<CircleAlert className="t-reveal size-5 text-bad-text" />
									) : current ? (
										<Loader2 className="size-4 animate-spin text-muted-foreground" />
									) : (
										<span className="size-2 rounded-full bg-idle" />
									)}
								</span>
								<span
									className={cn(
										"text-sm",
										done || current
											? "text-foreground"
											: "text-muted-foreground",
										current && failed && "text-bad-text",
									)}
								>
									{p.label}
									{done && <span className="sr-only">, done</span>}
								</span>
							</li>
						);
					})}
				</ol>
			)}
			{started && dns.statusMessage && (
				<p
					className={cn(
						"text-sm text-pretty",
						failed ? "text-bad-text" : "text-muted-foreground",
					)}
				>
					{dns.statusMessage}
				</p>
			)}
			{started && failed && (
				<p className="text-sm text-pretty text-muted-foreground">
					If port 53 is busy, run the command from the Address step on the node,
					then fix the settings on the{" "}
					<Link to="/network/dns/settings" className="underline">
						DNS settings
					</Link>{" "}
					page. The worker retries on its own.
				</p>
			)}
		</div>
	);
}

function buildSteps(
	nodes: ClusterNode[],
	dns: HomeDns | undefined,
): WizardStep<V>[] {
	const nodeName = (id: string) =>
		nodes.find((n) => n.id === id)?.hostname ?? id;
	return [
		{
			id: "node",
			title: "Node",
			description:
				"The server that answers DNS for the house. It needs to sit on your home network, with an address that doesn't change.",
			schema: z.object({ nodeId: z.string().min(1, "Pick a node.") }),
			render: (w) => (
				<ChoiceGroup
					label="Node"
					value={w.values.nodeId || undefined}
					invalid={Boolean(w.error("nodeId"))}
					onChange={(id) => {
						const prev = nodes.find((n) => n.id === w.values.nodeId);
						w.set("nodeId", id);
						// Follow the node's address unless it was typed by hand.
						if (!w.values.lanAddress || w.values.lanAddress === prev?.address)
							w.set(
								"lanAddress",
								nodes.find((n) => n.id === id)?.address ?? "",
							);
					}}
					choices={nodes.map((n) => ({
						value: n.id,
						title: n.hostname,
						description: [
							n.address,
							n.role === "manager" ? "manager" : "worker",
						]
							.filter(Boolean)
							.join(" · "),
						icon: n.role === "manager" ? ServerCog : Server,
						badge: n.leader ? "Recommended" : undefined,
					}))}
				/>
			),
		},
		{
			id: "address",
			title: "Address",
			description:
				"The IPv4 address devices will use as their DNS server: the node's address on your home network.",
			schema: z.object({
				lanAddress: z
					.string()
					.trim()
					.refine(
						(a) => Ipv4.safeParse(a).success,
						"Enter an IPv4 address like 192.168.1.2.",
					),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<Field
						id="wz-lanAddress"
						label="DNS server address"
						error={w.error("lanAddress")}
						hint="Usually 192.168.x.x or 10.x.x.x. Give the node a fixed address on your router first."
					>
						<Input
							{...w.bind("lanAddress")}
							inputMode="decimal"
							placeholder="192.168.1.2"
							spellCheck={false}
							className="max-w-56 font-mono tabular-nums"
							autoFocus
						/>
					</Field>
					<Instructions>
						<p>
							<strong>
								Port 53 must be free on {nodeName(w.values.nodeId)}.
							</strong>{" "}
							Ubuntu's systemd-resolved holds it by default. Run this once on
							that node to free it; the node keeps resolving names on its own.
						</p>
						<CopyField value={ENABLE_DNS} label="Copy command" wrap />
					</Instructions>
				</div>
			),
		},
		{
			id: "upstream",
			title: "Upstream",
			description:
				"Where the home DNS asks for names it doesn't know. Encrypted, so your internet provider sees neither the names nor the answers.",
			schema: (v) =>
				z.object({
					upServers: z
						.string()
						.refine(() => !upstreamIssue(draft(v)), upstreamIssue(draft(v))),
				}),
			render: (w) => (
				<div className="grid gap-6">
					<UpstreamFields
						idPrefix="wz-up"
						value={draft(w.values)}
						error={w.error("upServers")}
						onChange={(d) => {
							w.set("upPreset", d.preset);
							w.set("upProtocol", d.protocol);
							w.set("upServers", d.servers);
						}}
					/>
					<div className="flex items-start justify-between gap-6">
						<label htmlFor="wz-dnssec" className="grid gap-0.5 text-sm">
							<span className="font-medium">Validate DNSSEC</span>
							<span className="text-pretty text-muted-foreground">
								Refuses answers whose signatures don't check out.
							</span>
						</label>
						<Switch
							id="wz-dnssec"
							checked={w.values.dnssec}
							onCheckedChange={(c) => w.set("dnssec", c)}
						/>
					</div>
				</div>
			),
		},
		{
			id: "blocking",
			title: "Blocking",
			description:
				"Block ads, trackers and malware for every device in the house, phones and smart TVs included.",
			schema: (v) =>
				z.object({
					customLists: z
						.string()
						.refine(
							() =>
								customUrls(v).every(
									(u) =>
										!u.includes(",") &&
										z.url({ protocol: /^https?$/ }).safeParse(u).success,
								),
							"One http or https address per line.",
						),
				}),
			render: (w) => (
				<div className="grid gap-6">
					<div className="flex items-start justify-between gap-6">
						<label htmlFor="wz-blocking" className="grid gap-0.5 text-sm">
							<span className="font-medium">Block with lists</span>
							<span className="text-pretty text-muted-foreground">
								Names on the lists get 0.0.0.0. Lists refresh every 24 hours.
							</span>
						</label>
						<Switch
							id="wz-blocking"
							checked={w.values.blocking}
							onCheckedChange={(c) => w.set("blocking", c)}
						/>
					</div>
					{w.values.blocking && (
						<>
							<fieldset className="grid gap-2 sm:grid-cols-2">
								<legend className="mb-2 text-sm font-medium">Lists</legend>
								{BLOCKLISTS.map((l, i) => {
									const checked = w.values.lists.includes(l.url);
									const id = `wz-list-${i}`;
									return (
										<label
											key={l.url}
											htmlFor={id}
											className={cn(
												"flex cursor-pointer items-start gap-3 rounded-lg bg-card p-3.5 ring-1 ring-border transition-shadow duration-(--duration-quick) hover:ring-foreground/25",
												checked &&
													"ring-2 ring-foreground hover:ring-foreground",
											)}
										>
											<Checkbox
												id={id}
												checked={checked}
												className="mt-0.5"
												onCheckedChange={(c) =>
													w.set(
														"lists",
														c
															? [...w.values.lists, l.url]
															: w.values.lists.filter((u) => u !== l.url),
													)
												}
											/>
											<span className="min-w-0">
												<span className="flex items-center gap-2 text-sm font-medium">
													{l.name}
													{i === 0 && (
														<span className="rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
															Recommended
														</span>
													)}
												</span>
												<span className="mt-0.5 block text-xs text-muted-foreground">
													{l.description}
												</span>
											</span>
										</label>
									);
								})}
							</fieldset>
							<Field
								id="wz-customLists"
								label="Other lists"
								optional
								error={w.error("customLists")}
								hint="Hosts files or plain domain lists, one address per line."
							>
								<Textarea
									{...w.bind("customLists")}
									rows={2}
									spellCheck={false}
									placeholder="https://example.com/blocklist.txt"
									className="max-w-xl font-mono text-[13px]"
								/>
							</Field>
						</>
					)}
				</div>
			),
		},
		{
			id: "zone",
			title: "Local zone",
			description:
				"Optional. A zone that gives devices in the house names, like nas.home.lan. You can add records and more zones later.",
			schema: z.object({
				localZone: z
					.string()
					.trim()
					.toLowerCase()
					.refine(
						(z) => z === "" || ZONE.test(z),
						"Enter a zone name like home.lan, or leave it empty.",
					),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<Field
						id="wz-localZone"
						label="Zone name"
						optional
						error={w.error("localZone")}
					>
						<Input
							{...w.bind("localZone")}
							placeholder="home.lan"
							spellCheck={false}
							autoCapitalize="none"
							className="max-w-xs font-mono"
							autoFocus
						/>
					</Field>
					<Instructions>
						<p>
							A made-up name like <strong>home.lan</strong> works only inside
							the house and gets no public certificate, so HTTPS on it shows a
							warning. Use a subdomain of a domain you own, like
							home.example.com, for certificates without warnings.
						</p>
					</Instructions>
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"LogiStack runs Technitium on the node's host network and keeps these settings applied. You can change all of them later.",
			render: (w) => {
				const s = settingsOf(w.values);
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "node",
								title: "Where it runs",
								rows: [
									{ label: "Node", value: nodeName(w.values.nodeId) },
									{
										label: "DNS server address",
										value: (
											<span className="font-mono">{w.values.lanAddress}</span>
										),
									},
								],
							},
							{
								stepId: "upstream",
								title: "Upstream",
								rows: [
									{
										label: "Resolver",
										value:
											w.values.upPreset === "custom"
												? `Custom, ${PROTOCOLS[s.upstream.protocol]}`
												: `${UPSTREAMS.find((u) => u.id === w.values.upPreset)?.name}, DNS-over-HTTPS`,
									},
									{
										label: "DNSSEC",
										value: s.dnssecValidation ? "Validated" : "Off",
									},
								],
							},
							{
								stepId: "blocking",
								title: "Blocking",
								rows: s.blocking.enabled
									? [
											{
												label: "Lists",
												value: s.blocking.listUrls.length
													? s.blocking.listUrls
															.map((u) => listName(u) ?? u)
															.join(", ")
													: "None yet",
											},
										]
									: [{ label: "Blocking", value: "Off" }],
							},
							{
								stepId: "zone",
								title: "Local zone",
								rows: [
									{
										label: "Zone",
										value: s.localZone ? (
											<span className="font-mono">{s.localZone}</span>
										) : (
											"None"
										),
									},
								],
							},
						]}
					/>
				);
			},
		},
		{
			id: "apply",
			title: "Turn on",
			description:
				"The worker starts Technitium and reports back here. The first start pulls the image, which takes a minute on a slow connection.",
			ready: () =>
				dns?.enabled && dns.status === "ready"
					? true
					: "Wait for the home DNS to answer",
			render: (w) => <Apply w={w} dns={dns} />,
		},
		{
			id: "router",
			title: "Your router",
			description:
				"Last step, on your router: hand out the home DNS to every device.",
			render: (w) => (
				<div className="grid max-w-2xl gap-6">
					<div className="rounded-xl bg-card p-5 shadow-card ring-1 ring-border">
						<p className="text-sm text-muted-foreground">
							Set this as the DNS server on your router
						</p>
						<div className="mt-2 flex items-center gap-3">
							<span className="text-2xl font-semibold tabular [font-stretch:108%]">
								{dns?.lanAddress ?? w.values.lanAddress}
							</span>
							<CopyButton
								value={dns?.lanAddress ?? w.values.lanAddress}
								label="Copy address"
							/>
						</div>
						<p className="mt-3 text-sm text-pretty text-muted-foreground">
							Look for "DNS server" in the router's DHCP or LAN settings and
							leave the secondary empty, or devices will skip the blocking.
							Devices pick it up when they reconnect to Wi-Fi.
						</p>
					</div>
					<div className="grid gap-2">
						<h3 className="text-sm font-medium">Try a name</h3>
						<p className="text-sm text-muted-foreground">
							Resolve a name through the home DNS. An ad domain should come back
							blocked.
						</p>
						<NameTest />
					</div>
				</div>
			),
		},
	];
}

function SetUpHomeDns() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: dns, admin, me } = useHomeDns();
	const { data: nodes } = useQuery(nodesQuery);
	const steps = useMemo(() => buildSteps(nodes ?? [], dns), [nodes, dns]);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	// Opened while the feature was already on (not by this wizard): nothing to set up here.
	const alreadyOn = useRef<boolean>(undefined);
	if (dns && alreadyOn.current === undefined) {
		let mine = false;
		try {
			mine =
				JSON.parse(sessionStorage.getItem("wizard:home-dns") ?? "{}")
					.submitted === true;
		} catch {}
		alreadyOn.current = dns.enabled && !mine;
	}
	const manager =
		nodes?.find((n) => n.leader) ?? nodes?.find((n) => n.role === "manager");

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Set up home DNS"
				description="Turn this server into the house's DNS: ad and tracker blocking for every device, and names like nas.home.lan."
			/>
			{me && !admin ? (
				<EmptyState
					icon={ServerCog}
					title="Only instance admins manage the home network"
					description="The house's DNS belongs to the whole server, not to an organization. Ask an instance admin to add you."
				/>
			) : !dns || !nodes ? (
				<Panel title="Loading" id="wizard-loading">
					<SkeletonRows rows={3} />
				</Panel>
			) : alreadyOn.current ? (
				<EmptyState
					icon={ShieldBan}
					title="Home DNS is already on"
					description={`It answers at ${dns.lanAddress} on ${dns.nodeHostname}. Change it from its settings.`}
				>
					<Button asChild>
						<Link to="/network/dns">Open overview</Link>
					</Button>
					<Button asChild variant="outline">
						<Link to="/network/dns/settings">DNS settings</Link>
					</Button>
				</EmptyState>
			) : (
				<Wizard
					id="home-dns"
					steps={steps}
					defaultValues={{
						nodeId: manager?.id ?? "",
						lanAddress: manager?.address ?? "",
						upPreset: "cloudflare",
						upProtocol: "Https" as const,
						upServers: "",
						dnssec: true,
						blocking: true,
						lists: [BLOCKLISTS[0].url],
						customLists: "",
						localZone: "home.lan",
						submitted: false,
					}}
					step={step}
					onStepChange={onStepChange}
					finishLabel="Done"
					onComplete={async () => {
						toast.success("Home DNS is on", {
							icon: <ShieldBan className="size-4" />,
						});
						await navigate({ to: "/network/dns" });
					}}
				/>
			)}
		</Page>
	);
}
