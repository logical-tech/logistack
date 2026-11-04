import { Hostname } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	Cable,
	ChevronsUpDown,
	CircleAlert,
	FileKey,
	Globe,
	Hand,
	Lock,
	LockOpen,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { DataChip } from "@/components/integrations/parts";
import { LivePropagation } from "@/components/integrations/propagation";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	type Choice,
	ChoiceGroup,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import {
	certificatesQuery,
	type DnsKind,
	type DnsMatch,
	type DomainBody,
	domainsQuery,
	type TlsMode,
	useInvalidating,
} from "@/lib/api/networking";
import { projectsQuery } from "@/lib/api/projects";
import { tunnelsQuery } from "@/lib/api/tunnels";
import { DNS_KINDS, TLS_MODES } from "@/lib/integrations";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/domains_/new")({
	staticData: { crumb: "Add domain" },
	validateSearch: z.object({
		step: stepParam,
		serviceId: z.string().optional(),
		edit: z.string().optional(),
	}),
	component: DomainWizardPage,
});

type RecordMode = "create" | "manual" | "keep" | "tunnel";

type V = {
	serviceId: string;
	hostname: string;
	port: string;
	pathPrefix: string;
	recordMode: RecordMode;
	recordType: "A" | "AAAA" | "CNAME";
	recordContent: string;
	proxied: boolean;
	/** Copied from the DNS match so later steps and the summary don't refetch. */
	dnsProviderId: string;
	dnsProviderName: string;
	dnsKind: DnsKind | "";
	dnsRecordId: string;
	tls: TlsMode;
	customCertificateId: string;
};

const DEFAULTS: V = {
	serviceId: "",
	hostname: "",
	port: "80",
	pathPrefix: "",
	recordMode: "manual",
	recordType: "A",
	recordContent: "",
	proxied: false,
	dnsProviderId: "",
	dnsProviderName: "",
	dnsKind: "",
	dnsRecordId: "",
	tls: "http-01",
	customCertificateId: "",
};

const host = (v: V) => v.hostname.trim().toLowerCase();
const isWildcard = (v: V) => host(v).startsWith("*.");

/** The TLS modes this domain can use: a linked provider means DNS-01, a wildcard needs it. */
function tlsChoices(v: V): TlsMode[] {
	if (v.recordMode === "tunnel") return ["none"];
	const linked = v.recordMode !== "manual" && Boolean(v.dnsProviderId);
	if (isWildcard(v)) return v.dnsProviderId ? ["dns-01"] : [];
	if (linked) return ["dns-01", "custom", "none"];
	return v.dnsProviderId
		? ["dns-01", "http-01", "custom", "none"]
		: ["http-01", "custom", "none"];
}

const matchQuery = (serviceId: string, hostname: string) => ({
	queryKey: ["dns-match", serviceId, hostname],
	queryFn: () => api.networking.dns.match(serviceId, hostname),
	enabled: Boolean(serviceId && hostname),
	staleTime: 30_000,
});

function ManualRecord({ v, ip }: { v: V; ip: string }) {
	return (
		<div className="overflow-hidden rounded-lg ring-1 ring-border" data-ui>
			<table className="w-full text-left text-xs">
				<thead className="bg-muted/60 text-muted-foreground">
					<tr>
						<th className="px-3 py-2 font-medium">Type</th>
						<th className="px-3 py-2 font-medium">Name</th>
						<th className="px-3 py-2 font-medium">Value</th>
					</tr>
				</thead>
				<tbody className="font-mono">
					<tr className="border-t">
						<td className="px-3 py-2">{ip.includes(":") ? "AAAA" : "A"}</td>
						<td className="px-3 py-2 break-all">{host(v)}</td>
						<td className="px-3 py-2">{ip}</td>
					</tr>
				</tbody>
			</table>
		</div>
	);
}

function DnsStep({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const { data, isPending, error } = useQuery(matchQuery(v.serviceId, host(v)));
	const { data: tunnels } = useQuery(tunnelsQuery);
	const match: DnsMatch["match"] | undefined = data?.match;
	const ip = data?.publicIp ?? "";
	const { set } = w;

	// Mirror the match into the answers; editing keeps a record LogiStack already owns.
	useEffect(() => {
		if (!data) return;
		set("dnsProviderId", data.match?.providerId ?? "");
		set("dnsProviderName", data.match?.providerName ?? "");
		set("dnsKind", data.match?.kind ?? "");
		if (!data.match && (v.recordMode === "create" || v.recordMode === "tunnel"))
			set("recordMode", "manual");
		if (data.publicIp && !v.recordContent) {
			set("recordContent", data.publicIp);
			set("recordType", data.publicIp.includes(":") ? "AAAA" : "A");
		}
	}, [data, set, v.recordMode, v.recordContent]);

	if (isPending)
		return (
			<div className="flex items-center gap-3 rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground dark:bg-muted/40">
				<span className="t-skel size-2 rounded-full bg-muted-foreground/40" />
				Looking for a connected provider that manages this zone…
			</div>
		);
	if (error)
		return (
			<p className="text-sm text-bad-text">
				Couldn't look up DNS providers: {error.message}
			</p>
		);

	if (!match)
		return (
			<div className="grid gap-5">
				<div className="flex gap-3 rounded-lg bg-muted/60 p-4 text-sm dark:bg-muted/40">
					<Hand
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<p className="text-muted-foreground">
						<span className="font-medium text-foreground">
							No connected provider manages this zone.
						</span>{" "}
						Create this record at your DNS host, or{" "}
						<Link
							to="/integrations/dns/new"
							className="text-foreground underline underline-offset-4"
						>
							connect the provider
						</Link>{" "}
						and come back.
					</p>
				</div>
				{ip && <ManualRecord v={v} ip={ip} />}
			</div>
		);

	const kind = DNS_KINDS[match.kind];
	const existing = match.existing.filter((r) => r.type !== "TXT");
	const tunnel = tunnels?.find((t) => t.dnsProviderId === match.providerId);
	const choices: Choice<RecordMode>[] = [
		...(tunnel
			? [
					{
						value: "tunnel" as const,
						title: "Through the Cloudflare Tunnel",
						description: `Served via ${tunnel.name}: no open ports, Cloudflare issues the certificate. LogiStack adds the proxied CNAME.`,
						icon: Cable,
					},
				]
			: []),
		...(v.dnsRecordId
			? [
					{
						value: "keep" as const,
						title: "Keep the record LogiStack created",
						description: "Nothing changes at the provider.",
						icon: ShieldCheck,
					},
				]
			: []),
		{
			value: "create",
			title: v.dnsRecordId ? "Recreate the record" : "Create the record for me",
			badge: v.dnsRecordId ? undefined : "Recommended",
			description: `Set at ${match.providerName}, removed with the domain, and certificates over DNS-01.`,
			icon: Sparkles,
		},
		{
			value: "manual",
			title: "I'll manage the record myself",
			description:
				"You point it at this server. LogiStack leaves the zone alone.",
			icon: Hand,
		},
	];

	return (
		<div className="grid gap-6">
			<div className="flex items-center gap-3 rounded-lg bg-card p-3.5 ring-1 ring-border">
				<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
					<kind.icon className="size-4" strokeWidth={1.75} aria-hidden />
				</span>
				<p className="min-w-0 text-sm">
					<span className="font-mono">{match.zone.name}</span>
					<span className="text-muted-foreground"> is managed by </span>
					<span className="font-medium">{match.providerName}</span>
				</p>
			</div>
			<ChoiceGroup
				label="DNS record"
				columns={1}
				value={v.recordMode}
				onChange={(m) => w.set("recordMode", m)}
				choices={choices}
			/>
			{v.recordMode === "create" && (
				<div className="grid gap-4">
					<div className="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
						<Field id="wz-recordType" label="Type">
							<Select
								value={v.recordType}
								onValueChange={(t) => {
									w.set("recordType", t as V["recordType"]);
									w.set("recordContent", t === "CNAME" ? "" : ip);
								}}
							>
								<SelectTrigger id="wz-recordType" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ip.includes(":") ? "AAAA" : "A"}>
										{ip.includes(":") ? "AAAA" : "A"}
									</SelectItem>
									<SelectItem value="CNAME">CNAME</SelectItem>
								</SelectContent>
							</Select>
						</Field>
						<Field
							id="wz-recordContent"
							label={v.recordType === "CNAME" ? "Target hostname" : "Points to"}
							error={w.error("recordContent")}
							hint={
								v.recordType === "CNAME"
									? "A hostname that already resolves to this server."
									: "This server's public address."
							}
						>
							<Input
								{...w.bind("recordContent")}
								className="font-mono"
								autoCapitalize="none"
								spellCheck={false}
							/>
						</Field>
					</div>
					{existing.length > 0 && (
						<p className="flex gap-2 text-sm text-warn-text">
							<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>
								{match.zone.name} already has{" "}
								{existing.map((r) => `${r.type} ${r.content}`).join(", ")} at
								this name. Creating replaces the {v.recordType} record.
							</span>
						</p>
					)}
					{match.kind === "cloudflare" && (
						<div className="grid gap-3">
							<label
								htmlFor="wz-proxied"
								className="flex cursor-pointer items-start justify-between gap-4 rounded-lg bg-card p-3.5 ring-1 ring-border"
							>
								<span className="text-sm">
									<span className="block font-medium">
										Proxy through Cloudflare
									</span>
									<span className="mt-0.5 block text-muted-foreground">
										Visitors reach Cloudflare's edge, which forwards to this
										server.
									</span>
								</span>
								<Switch
									id="wz-proxied"
									checked={v.proxied}
									onCheckedChange={(c) => w.set("proxied", c)}
								/>
							</label>
							{v.proxied && (
								<div
									className="t-reveal flex gap-3 rounded-lg bg-warn/10 p-3.5 text-sm"
									role="note"
								>
									<CircleAlert
										className="mt-0.5 size-4 shrink-0 text-warn-text"
										aria-hidden
									/>
									<p className="text-foreground">
										<span className="font-medium">
											Set the zone's SSL/TLS mode to Full (strict).
										</span>{" "}
										<span className="text-muted-foreground">
											With Flexible, Cloudflare talks plain HTTP to this server,
											LogiStack redirects it to HTTPS, and the page loops
											forever. The certificate comes over DNS-01, so the proxy
											doesn't block it.
										</span>
									</p>
								</div>
							)}
						</div>
					)}
				</div>
			)}
			{v.recordMode === "manual" && ip && <ManualRecord v={v} ip={ip} />}
			{v.recordMode === "tunnel" && (
				<p className="text-sm text-muted-foreground">
					Visitors reach Cloudflare's edge, which sends the request down the
					tunnel to this server's proxy. Nothing listens publicly for{" "}
					<span className="font-mono text-foreground">{host(v)}</span>.
				</p>
			)}
		</div>
	);
}

function CertificatePicker({ w }: { w: WizardApi<V> }) {
	const { data } = useQuery(certificatesQuery);
	const hostname = host(w.values);
	const fits = (data?.custom ?? []).filter((c) =>
		c.sans.some(
			(n) =>
				n === hostname ||
				(n.startsWith("*.") &&
					hostname.slice(hostname.indexOf(".") + 1) === n.slice(2)),
		),
	);
	if (!data) return null;
	if (!fits.length)
		return (
			<p className="text-sm text-muted-foreground">
				No uploaded certificate names {hostname}.{" "}
				<Link
					to="/settings/certificates/new"
					className="text-foreground underline underline-offset-4"
				>
					Upload one
				</Link>
				, then come back to this step.
			</p>
		);
	return (
		<Field
			id="wz-customCertificateId"
			label="Certificate"
			error={w.error("customCertificateId")}
		>
			<Select
				value={w.values.customCertificateId}
				onValueChange={(id) => w.set("customCertificateId", id)}
			>
				<SelectTrigger id="wz-customCertificateId" className="w-full">
					<SelectValue placeholder="Pick a certificate" />
				</SelectTrigger>
				<SelectContent>
					{fits.map((c) => (
						<SelectItem key={c.id} value={c.id}>
							{c.name} · {c.sans.join(", ")}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Field>
	);
}

const TLS_CHOICES: Record<TlsMode, Omit<Choice<TlsMode>, "value">> = {
	"dns-01": {
		title: TLS_MODES["dns-01"].label,
		description:
			"Let's Encrypt over the DNS provider. Works for wildcards, behind Cloudflare's proxy, and before the record propagates.",
		icon: ShieldCheck,
	},
	"http-01": {
		title: TLS_MODES["http-01"].label,
		description:
			"Let's Encrypt checks this server over port 80, so the record must already point here.",
		icon: Lock,
	},
	custom: {
		title: TLS_MODES.custom.label,
		description:
			"A certificate you uploaded, for when a client supplies their own.",
		icon: FileKey,
	},
	none: {
		title: TLS_MODES.none.label,
		description:
			"Plain HTTP on port 80. For internal tools behind another proxy.",
		icon: LockOpen,
	},
};

type ServiceOption = {
	id: string;
	name: string;
	project: string;
	/** Only when the project has several, to tell same-named services apart. */
	environment?: string;
};

/** Services grouped by project, searchable by service or project name. */
function ServiceCombobox({
	id,
	services,
	value,
	onChange,
	disabled,
	invalid,
}: {
	id: string;
	services: ServiceOption[];
	value: string;
	onChange: (id: string) => void;
	disabled?: boolean;
	invalid?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const selected = services.find((s) => s.id === value);
	const byProject = new Map<string, ServiceOption[]>();
	for (const s of services)
		byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id={id}
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					aria-invalid={invalid || undefined}
					disabled={disabled}
					className="w-full justify-between font-normal aria-invalid:ring-1 aria-invalid:ring-destructive"
				>
					{selected ? (
						<span className="truncate">
							{selected.name}
							<span className="text-muted-foreground">
								{" "}
								· {selected.project}
								{selected.environment && ` · ${selected.environment}`}
							</span>
						</span>
					) : (
						<span className="text-muted-foreground">Pick a service</span>
					)}
					<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-(--radix-popover-trigger-width) p-0"
				align="start"
			>
				{/* Substring, not fuzzy: "book" should not find "Back office". */}
				<Command
					filter={(_item, search, keywords) =>
						(keywords ?? [])
							.join(" ")
							.toLowerCase()
							.includes(search.trim().toLowerCase())
							? 1
							: 0
					}
				>
					<CommandInput placeholder="Search services or projects" />
					<CommandList className="max-h-72">
						<CommandEmpty>No service matches.</CommandEmpty>
						{[...byProject].map(([project, list]) => (
							<CommandGroup key={project} heading={project}>
								{list.map((s) => (
									<CommandItem
										key={s.id}
										value={s.id}
										keywords={[s.name, project, s.environment ?? ""]}
										data-checked={s.id === value}
										onSelect={() => {
											onChange(s.id);
											setOpen(false);
										}}
									>
										<span className="min-w-0 flex-1 truncate">{s.name}</span>
										{s.environment && (
											<span className="shrink-0 text-xs text-muted-foreground">
												{s.environment}
											</span>
										)}
									</CommandItem>
								))}
							</CommandGroup>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function buildSteps(
	services: { id: string; name: string; project: string }[],
	editing: boolean,
	setRecord: (id: string) => void,
	startedAt: number,
): WizardStep<V>[] {
	return [
		{
			id: "service",
			title: "Which service?",
			description: "The proxy sends this hostname to one service's port.",
			schema: z.object({ serviceId: z.string().min(1, "Pick a service.") }),
			render: (w) => (
				<div className="grid max-w-md gap-4">
					<Field id="wz-serviceId" label="Service" error={w.error("serviceId")}>
						<ServiceCombobox
							id="wz-serviceId"
							services={services}
							value={w.values.serviceId}
							onChange={(id) => w.set("serviceId", id)}
							disabled={editing}
							invalid={Boolean(w.error("serviceId"))}
						/>
					</Field>
				</div>
			),
		},
		{
			id: "hostname",
			title: "Hostname",
			description:
				"A name you control, like app.example.com, or a wildcard like *.preview.example.com for one route per subdomain.",
			schema: z.object({
				hostname: z
					.string()
					.refine(
						(h) => Hostname.safeParse(h.trim().toLowerCase()).success,
						"Use a hostname like app.example.com, without https://.",
					),
				port: z.coerce
					.number({ message: "Enter a port." })
					.int()
					.min(1, "Ports run from 1 to 65535.")
					.max(65535, "Ports run from 1 to 65535."),
				pathPrefix: z.union([
					z.literal(""),
					z
						.string()
						.regex(/^\/[\w\-./]*$/, "Start with / and use a plain path."),
				]),
			}),
			render: (w) => (
				<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
					<Field id="wz-hostname" label="Hostname" error={w.error("hostname")}>
						<Input
							{...w.bind("hostname")}
							placeholder="app.example.com"
							autoCapitalize="none"
							spellCheck={false}
							autoFocus
							className="font-mono"
						/>
					</Field>
					<Field id="wz-port" label="Container port" error={w.error("port")}>
						<Input
							{...w.bind("port")}
							inputMode="numeric"
							className="tabular"
						/>
					</Field>
					<Field
						id="wz-pathPrefix"
						label="Path prefix"
						optional
						error={w.error("pathPrefix")}
						hint="Route only /api/… to this service, for example. The prefix is passed through."
						className="sm:col-span-2"
					>
						<Input
							{...w.bind("pathPrefix")}
							placeholder="/api"
							className="font-mono"
							spellCheck={false}
						/>
					</Field>
				</div>
			),
		},
		{
			id: "dns",
			title: "DNS record",
			description:
				"The hostname has to resolve to this server before visitors can reach it.",
			schema: (v) =>
				z.object({
					recordContent:
						v.recordMode === "create"
							? z.string().trim().min(1, "Enter where the record points.")
							: z.string(),
				}),
			render: (w) => <DnsStep w={w} />,
		},
		{
			id: "record",
			title: "Create the record",
			description:
				"Sets exactly this record at the provider, replacing any value of the same type.",
			when: (v) => v.recordMode === "create",
			testKeys: [
				"serviceId",
				"hostname",
				"recordType",
				"recordContent",
				"proxied",
				"dnsProviderId",
			],
			test: async (v) => {
				try {
					const r = await api.networking.dns.upsertRecord(v.serviceId, {
						dnsProviderId: v.dnsProviderId,
						hostname: host(v),
						type: v.recordType,
						content: v.recordContent.trim(),
						proxied: v.proxied,
					});
					// The wizard reruns this test whenever an answer changes, so the id stays current.
					setRecord(r.id);
					return {
						ok: true,
						message: `${r.type} ${r.name} → ${r.content}`,
						detail: `Saved at ${v.dnsProviderName}${r.proxied ? ", proxied by Cloudflare" : ""}.`,
					};
				} catch (err) {
					return {
						ok: false,
						message: `${v.dnsProviderName} refused the record`,
						detail: err instanceof Error ? err.message : String(err),
					};
				}
			},
			render: (w) => (
				<div className="grid gap-5">
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<DataChip>{w.values.recordType}</DataChip>
						<DataChip>{host(w.values)}</DataChip>
						<span className="text-muted-foreground">→</span>
						<DataChip>{w.values.recordContent}</DataChip>
						{w.values.proxied && (
							<span className="text-muted-foreground">proxied</span>
						)}
					</div>
					<TestPanel
						w={w}
						action="Create record"
						idle={`LogiStack will write this record at ${w.values.dnsProviderName}.`}
					/>
				</div>
			),
		},
		{
			id: "propagation",
			title: "Propagation",
			description:
				"Public resolvers pick the record up at their own pace. You can continue; the proxy keeps retrying until it resolves.",
			when: (v) => v.recordMode !== "keep" && v.recordMode !== "tunnel",
			render: (w) => {
				const v = w.values;
				if (v.proxied)
					return (
						<p className="max-w-[62ch] text-sm text-muted-foreground">
							Proxied records resolve to Cloudflare's own addresses, not to this
							server, so there is nothing to compare. Cloudflare serves the new
							record within seconds.
						</p>
					);
				const probe = isWildcard(v) ? `ls-check.${host(v).slice(2)}` : host(v);
				return (
					<div className="grid gap-3">
						<LivePropagation
							serviceId={v.serviceId}
							hostname={probe}
							type={v.recordType}
							content={v.recordContent.trim()}
							startedAt={startedAt}
						/>
						{isWildcard(v) && (
							<p className="text-xs text-muted-foreground">
								A wildcard is checked through a name under it,{" "}
								<span className="font-mono">{probe}</span>.
							</p>
						)}
					</div>
				);
			},
		},
		{
			id: "tls",
			title: "HTTPS",
			description: "How the proxy gets a certificate for this hostname.",
			when: (v) => v.recordMode !== "tunnel",
			schema: (v) =>
				z.object({
					tls: z
						.string()
						.refine(
							(t) => tlsChoices(v).includes(t as TlsMode),
							"Pick one of these.",
						),
					customCertificateId:
						v.tls === "custom"
							? z.string().min(1, "Pick a certificate.")
							: z.string(),
				}),
			render: (w) => {
				const choices = tlsChoices(w.values);
				if (choices.length === 0)
					return (
						<p className="text-sm text-bad-text">
							A wildcard needs DNS-01, so its zone has to be managed by a
							connected DNS provider. Go back and use a hostname in a managed
							zone, or connect the provider first.
						</p>
					);
				return (
					<div className="grid gap-5">
						<ChoiceGroup
							label="Certificate"
							columns={choices.length > 2 ? 2 : 1}
							value={choices.includes(w.values.tls) ? w.values.tls : undefined}
							onChange={(t) => w.set("tls", t)}
							invalid={Boolean(w.error("tls"))}
							choices={choices.map((t) => ({ value: t, ...TLS_CHOICES[t] }))}
						/>
						{w.values.recordMode !== "manual" && w.values.dnsProviderId && (
							<p className="text-xs text-muted-foreground">
								HTTP-01 isn't offered: a record LogiStack manages always gets
								its certificate over DNS-01.
							</p>
						)}
						{w.values.tls === "custom" && <CertificatePicker w={w} />}
					</div>
				);
			},
		},
		{
			id: "review",
			title: editing ? "Review changes" : "Review and add",
			description:
				"The proxy picks the domain up within a few seconds of saving.",
			render: (w) => {
				const v = w.values;
				const svc = services.find((s) => s.id === v.serviceId);
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "hostname",
								title: "Route",
								rows: [
									{
										label: "Hostname",
										value: (
											<span className="font-mono text-xs">
												{host(v)}
												{v.pathPrefix}
											</span>
										),
									},
									{
										label: "Service",
										value: svc
											? `${svc.name} · ${svc.project}, port ${v.port}`
											: v.serviceId,
									},
								],
							},
							{
								stepId: "dns",
								title: "DNS",
								rows: [
									{
										label: "Record",
										value:
											v.recordMode === "tunnel"
												? `Proxied CNAME to the tunnel at ${v.dnsProviderName}`
												: v.recordMode === "manual"
													? "Managed by you"
													: v.recordMode === "keep"
														? `Kept at ${v.dnsProviderName}`
														: `${v.recordType} ${v.recordContent} at ${v.dnsProviderName}${v.proxied ? ", proxied" : ""}`,
									},
								],
							},
							{
								stepId: "tls",
								title: "HTTPS",
								rows: [
									{
										label: "Certificate",
										value:
											v.recordMode === "tunnel"
												? "Cloudflare's edge certificate"
												: TLS_MODES[v.tls].label,
									},
								],
							},
						]}
					/>
				);
			},
		},
	];
}

function toBody(v: V, recordId: string | null): DomainBody {
	if (v.recordMode === "tunnel")
		return {
			hostname: host(v),
			port: Number(v.port),
			pathPrefix: v.pathPrefix.trim() || null,
			https: false,
			cert: "none",
			customCertificateId: null,
			dnsProviderId: v.dnsProviderId,
			// The worker creates the CNAME; an edit keeps the one it made.
			dnsRecordId: v.dnsRecordId || null,
			tunnel: true,
		};
	const linked = v.recordMode !== "manual" || v.tls === "dns-01";
	const dnsRecordId =
		v.recordMode === "create"
			? recordId
			: v.recordMode === "keep"
				? v.dnsRecordId || null
				: null;
	return {
		hostname: host(v),
		port: Number(v.port),
		pathPrefix: v.pathPrefix.trim() || null,
		https: v.tls !== "none",
		cert: v.tls === "custom" ? "custom" : v.tls === "none" ? "none" : "auto",
		customCertificateId: v.tls === "custom" ? v.customCertificateId : null,
		dnsProviderId: linked && v.dnsProviderId ? v.dnsProviderId : null,
		dnsRecordId: linked ? dnsRecordId : null,
	};
}

function DomainWizardPage() {
	const { step, serviceId, edit } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: projects } = useQuery(projectsQuery);
	const { data: domains } = useQuery({
		...domainsQuery,
		enabled: Boolean(edit),
	});
	const [recordId, setRecordId] = useState<string | null>(null);
	const [startedAt] = useState(() => Date.now());
	const create = useInvalidating(
		({ serviceId, body }: { serviceId: string; body: DomainBody }) =>
			api.networking.domains.create(serviceId, body),
		[["domains"], ["dns-providers"]],
	);
	const update = useInvalidating(
		({ id, body }: { id: string; body: DomainBody }) =>
			api.networking.domains.update(id, body),
		[["domains"], ["dns-providers"]],
	);

	const services = useMemo(
		() =>
			(projects ?? []).flatMap((p) =>
				p.services.map((s) => ({
					id: s.id,
					name: s.name,
					project: p.name,
					environment:
						p.environments.length > 1
							? p.environments.find((e) => e.id === s.environmentId)?.name
							: undefined,
				})),
			),
		[projects],
	);
	const current = edit ? domains?.find((d) => d.id === edit) : undefined;
	const steps = useMemo(
		() => buildSteps(services, Boolean(edit), setRecordId, startedAt),
		[services, edit, startedAt],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);

	if (!projects || (edit && !current)) return null;

	const defaults: V = current
		? {
				...DEFAULTS,
				serviceId: current.service.id,
				hostname: current.hostname,
				port: String(current.port),
				pathPrefix: current.pathPrefix ?? "",
				recordMode: current.tunnel
					? "tunnel"
					: current.dnsRecordId
						? "keep"
						: "manual",
				dnsRecordId: current.dnsRecordId ?? "",
				tls: current.tls,
				customCertificateId: current.customCertificateId ?? "",
			}
		: { ...DEFAULTS, serviceId: serviceId ?? "" };

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title={current ? `Edit ${current.hostname}` : "Add a domain"}
				description={
					current
						? `${current.service.name} · ${current.project.name}`
						: "Route a hostname to a service, with its DNS record and certificate."
				}
			/>
			<Wizard
				id={edit ? `domain-edit:${edit}` : "domain-new"}
				steps={steps}
				defaultValues={defaults}
				step={step}
				onStepChange={onStepChange}
				finishLabel={current ? "Save domain" : "Add domain"}
				onComplete={async (v) => {
					const body = toBody(v, recordId);
					if (current) await update.mutateAsync({ id: current.id, body });
					else await create.mutateAsync({ serviceId: v.serviceId, body });
					toast.success(
						current ? `${body.hostname} updated` : `${body.hostname} added`,
						{
							description: "It turns active once the proxy has loaded it.",
							icon: <Globe className="size-4" />,
						},
					);
					await navigate({ to: "/domains" });
				}}
			/>
		</Page>
	);
}
