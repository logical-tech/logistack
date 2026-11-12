import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import {
	Cloud,
	Globe,
	HardDrive,
	House,
	Info,
	KeyRound,
	ShieldCheck,
	TriangleAlert,
	Zap,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { Wordmark } from "@/components/brand";
import { Field } from "@/components/field";
import {
	ConfigFields,
	type ConfigSchema,
	type ConfigValues,
	initialValues,
	missingFields,
	toConfig,
} from "@/components/integrations/config-form";
import { MoveScreen } from "@/components/setup/move-screen";
import { ThemeToggle } from "@/components/theme-toggle";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChoiceGroup, Summary, TestPanel } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { api, isMock } from "@/lib/api";
import {
	checkDns,
	instanceStatusQuery,
	useCompleteSetup,
} from "@/lib/api/instance";
import { type DnsKind, schemasQuery } from "@/lib/api/networking";
import type { SetupResult } from "@/lib/api/types";
import { DNS_KINDS } from "@/lib/integrations";
import { stepParam } from "@/lib/search";
import type { Move } from "@/lib/setup-move";

export const Route = createFileRoute("/setup")({
	validateSearch: z.object({
		step: stepParam,
		/** Mock only: preview the screen that follows setup in one of its states. */
		move: z.enum(["checking", "reachable", "nat", "unresolved"]).optional(),
	}),
	beforeLoad: async ({ context }) => {
		const status =
			await context.queryClient.ensureQueryData(instanceStatusQuery);
		// The mock instance is already set up; keep the flow reachable for design work.
		if (status.setupCompleted && !isMock) throw redirect({ to: "/" });
	},
	component: SetupPage,
});

/** The first-run wizard offers built-in providers only: no plugin is installed yet. */
type SetupDnsKind = Exclude<DnsKind, "plugin">;
type DnsChoice = SetupDnsKind | "manual";

type SetupValues = {
	/** install.sh --public-setup prints it; never persisted. */
	setupToken: string;
	ownerName: string;
	ownerEmail: string;
	ownerPassword: string;
	orgName: string;
	domainBase: "custom" | "sslip" | "nip";
	wildcard: string;
	dnsProvider: DnsChoice;
	/** The provider's credential fields, from its config schema; never persisted. */
	dnsCredentials: ConfigValues;
	/** Behind NAT, where the records point: the LAN address, or the router's public IP. */
	reachFrom: "lan" | "internet";
	publicUrl: string;
	leEmail: string;
	registry: boolean;
};

const DEFAULTS: SetupValues = {
	setupToken: "",
	ownerName: "",
	ownerEmail: "",
	ownerPassword: "",
	orgName: "",
	domainBase: "custom",
	wildcard: "",
	dnsProvider: "cloudflare",
	dnsCredentials: {},
	reachFrom: "internet",
	publicUrl: "",
	leEmail: "",
	registry: true,
};

const DNS_PROVIDERS: { value: DnsChoice; label: string }[] = [
	...(Object.keys(DNS_KINDS) as DnsKind[])
		.filter((k): k is SetupDnsKind => k !== "plugin")
		.map((k) => ({
			value: k,
			label: DNS_KINDS[k].label,
		})),
	{ value: "manual", label: "None, I'll manage records myself" },
];

const hostname = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/,
		"Use a domain like srv1.example.com, without *. or https://",
	);

const ipDashed = (ip: string) => ip.replaceAll(".", "-");

/** The hostnames this instance will hand out, derived from the domain choice. */
function domainBase(v: SetupValues, ip: string) {
	if (v.domainBase === "custom")
		return v.wildcard.trim().toLowerCase() || "srv1.example.com";
	return `${ipDashed(ip)}.${v.domainBase}.io`;
}

function publicUrl(v: SetupValues, ip: string) {
	return v.publicUrl.trim() || `https://logistack.${domainBase(v, ip)}`;
}

/** The server's addresses; `lan` only when it differs from the public IP (behind NAT). */
type Addresses = { ip: string; lan: string | null };

/** Where the `*.base` and `base` records point. */
function recordsIp(v: SetupValues, a: Addresses) {
	return v.domainBase === "custom" && a.lan && v.reachFrom === "lan"
		? a.lan
		: a.ip;
}

function NatWarning({ ip, lan }: { ip: string; lan: string }) {
	return (
		<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
			<TriangleAlert
				className="mt-0.5 size-4 shrink-0 text-warn-text"
				aria-hidden
			/>
			<p>
				<span className="font-medium">This server is behind NAT.</span>{" "}
				<span className="text-muted-foreground">
					Visitors reach {ip} only if your router forwards ports 80 and 443 to{" "}
					{lan}. Without that, the dashboard does not answer.
				</span>
			</p>
		</div>
	);
}

function DnsRecords({ base, ip }: { base: string; ip: string }) {
	const rows = [
		{ type: "A", name: `*.${base}`, value: ip },
		{ type: "A", name: base, value: ip },
	];
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
					{rows.map((r) => (
						<tr key={r.name} className="border-t">
							<td className="px-3 py-2">{r.type}</td>
							<td className="px-3 py-2 break-all">{r.name}</td>
							<td className="px-3 py-2">{r.value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function DomainStep({
	w,
	addresses,
	schemas,
}: {
	w: WizardApi<SetupValues>;
	addresses: Addresses;
	schemas: Record<string, unknown> | undefined;
}) {
	const { ip, lan } = addresses;
	const v = w.values;
	const target = recordsIp(v, addresses);
	const credentialSchema =
		v.dnsProvider === "manual"
			? undefined
			: (schemas?.[v.dnsProvider] as ConfigSchema | undefined);
	return (
		<div className="grid gap-6">
			<ChoiceGroup
				label="Domain"
				value={v.domainBase}
				onChange={(d) => w.set("domainBase", d)}
				columns={1}
				choices={[
					{
						value: "custom",
						title: "Your own wildcard domain",
						badge: "Recommended",
						description:
							"Point *.srv1.example.com at this server. A DNS provider issues one wildcard certificate over DNS-01.",
						icon: ShieldCheck,
					},
					{
						value: "sslip",
						title: "sslip.io",
						badge: "Quick start",
						description: `Works right away: app.${ipDashed(ip)}.sslip.io resolves to ${ip}.`,
						icon: Zap,
					},
					{
						value: "nip",
						title: "nip.io",
						badge: "Quick start",
						description: `The same idea on another resolver: app.${ipDashed(ip)}.nip.io.`,
						icon: Globe,
					},
				]}
			/>

			{v.domainBase === "custom" ? (
				<div className="grid gap-5">
					<Field
						id="wz-wildcard"
						label="Wildcard base"
						error={w.error("wildcard")}
						hint="Every service gets a hostname under it, like web.srv1.example.com."
					>
						<div className="flex items-center rounded-lg ring-1 ring-input focus-within:ring-2 focus-within:ring-ring has-aria-invalid:ring-destructive">
							<span className="pl-2.5 font-mono text-sm text-muted-foreground select-none">
								*.
							</span>
							<Input
								{...w.bind("wildcard")}
								placeholder="srv1.example.com"
								autoCapitalize="none"
								spellCheck={false}
								className="border-0 pl-0.5 font-mono ring-0! focus-visible:ring-0"
							/>
						</div>
					</Field>
					<div className="grid gap-4">
						<Field
							id="wz-dnsProvider"
							label="DNS provider for certificates"
							className="sm:max-w-sm"
						>
							<Select
								value={v.dnsProvider}
								onValueChange={(p) => {
									w.set("dnsProvider", p as DnsChoice);
									const next = p === "manual" ? undefined : schemas?.[p];
									w.set(
										"dnsCredentials",
										next ? initialValues(next as ConfigSchema) : {},
									);
								}}
							>
								<SelectTrigger id="wz-dnsProvider" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DNS_PROVIDERS.map((p) => (
										<SelectItem key={p.value} value={p.value}>
											{p.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						{credentialSchema && v.dnsProvider !== "manual" && (
							<>
								<ConfigFields
									schema={credentialSchema}
									idPrefix="wz-dns"
									values={v.dnsCredentials}
									onChange={(c) => w.set("dnsCredentials", c)}
									errors={
										w.error("dnsCredentials")
											? missingFields(credentialSchema, v.dnsCredentials)
											: {}
									}
								/>
								<p className="text-xs text-muted-foreground">
									{DNS_KINDS[v.dnsProvider].where}
								</p>
							</>
						)}
					</div>
					{lan && (
						<div className="grid gap-2">
							<p className="text-sm font-medium">Who opens these addresses</p>
							<ChoiceGroup
								label="Who opens these addresses"
								value={v.reachFrom}
								onChange={(r) => w.set("reachFrom", r)}
								choices={[
									{
										value: "lan",
										title: "Only this network",
										description: `Records point at ${lan}. No port forwarding needed. Certificates still issue through the DNS provider.`,
										icon: House,
									},
									{
										value: "internet",
										title: "The internet",
										description: `Records point at ${ip}, your router's public address.`,
										icon: Globe,
									},
								]}
							/>
						</div>
					)}
					{lan && v.reachFrom === "internet" && (
						<NatWarning ip={ip} lan={lan} />
					)}
					<div className="grid gap-2">
						<p className="text-sm font-medium">DNS records</p>
						<p className="text-sm text-muted-foreground">
							{v.dnsProvider !== "manual"
								? "LogiStack creates both records with these credentials when you finish, then issues one wildcard certificate over DNS-01."
								: target === lan
									? "Create these two records at your DNS host. Let's Encrypt cannot reach a LAN address, so choose a DNS provider above to get certificates."
									: "Create these two records at your DNS host. Certificates are then issued per hostname over HTTP-01."}
						</p>
						<DnsRecords base={domainBase(v, ip)} ip={target} />
					</div>
				</div>
			) : (
				<div className="grid gap-4">
					{lan && <NatWarning ip={ip} lan={lan} />}
					<div className="flex gap-3 rounded-lg bg-muted/60 p-4 text-sm dark:bg-muted/40">
						<Info
							className="mt-0.5 size-4 shrink-0 text-info-text"
							aria-hidden
						/>
						<p className="text-muted-foreground">
							<span className="font-medium text-foreground">
								Good for trying LogiStack.
							</span>{" "}
							{v.domainBase}.io isn't on the Public Suffix List, so every
							instance using it shares one Let's Encrypt limit of 50
							certificates a week. Issuance can stall when that budget runs out.
							Switch to your own domain any time in Settings.
						</p>
					</div>
				</div>
			)}

			<Field
				id="wz-publicUrl"
				label="Instance URL"
				optional
				error={w.error("publicUrl")}
				hint="Where you and your team open LogiStack."
			>
				<Input
					{...w.bind("publicUrl")}
					placeholder={publicUrl({ ...v, publicUrl: "" }, ip)}
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
				/>
			</Field>
		</div>
	);
}

function buildSteps(
	addresses: Addresses,
	schemas: Record<string, unknown> | undefined,
	tokenRequired: boolean,
): WizardStep<SetupValues>[] {
	const { ip } = addresses;
	const credentialSchema = (v: SetupValues) =>
		v.domainBase === "custom" && v.dnsProvider !== "manual"
			? (schemas?.[v.dnsProvider] as ConfigSchema | undefined)
			: undefined;
	return [
		{
			id: "owner",
			title: "Create the owner account",
			description:
				"The owner can do everything, including adding people and changing these settings later.",
			schema: z.object({
				setupToken: tokenRequired
					? z
							.string()
							.trim()
							.min(1, "Enter the setup token install.sh printed.")
					: z.string(),
				ownerName: z.string().trim().min(1, "Enter your name."),
				ownerEmail: z.email("Enter a valid email address."),
				ownerPassword: z.string().min(12, "Use at least 12 characters."),
			}),
			render: (w) => (
				<div className="grid max-w-md gap-4">
					{tokenRequired && (
						<Field
							id="wz-setupToken"
							label="Setup token"
							error={w.error("setupToken")}
							hint="This server accepts setup from the internet, so it asks for the token install.sh printed."
						>
							<Input
								{...w.bind("setupToken")}
								className="font-mono"
								autoComplete="off"
								spellCheck={false}
								autoFocus
							/>
						</Field>
					)}
					<Field id="wz-ownerName" label="Name" error={w.error("ownerName")}>
						<Input
							{...w.bind("ownerName")}
							autoComplete="name"
							autoFocus={!tokenRequired}
						/>
					</Field>
					<Field id="wz-ownerEmail" label="Email" error={w.error("ownerEmail")}>
						<Input
							{...w.bind("ownerEmail")}
							type="email"
							inputMode="email"
							autoComplete="email"
							placeholder="you@company.com"
						/>
					</Field>
					<Field
						id="wz-ownerPassword"
						label="Password"
						error={w.error("ownerPassword")}
						hint="At least 12 characters. You can add a passkey and two-factor after setup."
					>
						<Input
							{...w.bind("ownerPassword")}
							type="password"
							autoComplete="new-password"
						/>
					</Field>
				</div>
			),
		},
		{
			id: "organization",
			title: "Name your organization",
			description:
				"Projects, members and integrations belong to an organization. You can create more later.",
			schema: z.object({
				orgName: z.string().trim().min(2, "Use at least 2 characters.").max(48),
			}),
			render: (w) => (
				<div className="grid max-w-md gap-4">
					<Field
						id="wz-orgName"
						label="Organization name"
						error={w.error("orgName")}
						hint={
							w.values.orgName.trim()
								? `Slug: ${w.values.orgName
										.trim()
										.toLowerCase()
										.replace(/[^a-z0-9]+/g, "-")
										.replace(/^-|-$/g, "")}`
								: "Usually your company or team."
						}
					>
						<Input {...w.bind("orgName")} placeholder="Logical" autoFocus />
					</Field>
				</div>
			),
		},
		{
			id: "domain",
			title: "Instance URL and domain",
			description:
				"Services get hostnames under one base domain, with HTTPS from Let's Encrypt.",
			schema: (v) =>
				z.object({
					wildcard: v.domainBase === "custom" ? hostname : z.string(),
					dnsCredentials: z.any().superRefine((c, ctx) => {
						const s = credentialSchema(v);
						if (s && Object.keys(missingFields(s, c ?? {})).length)
							ctx.addIssue({
								code: "custom",
								message: "Fill in the provider's credentials.",
							});
					}),
					publicUrl: z.union([
						z.literal(""),
						z.url({ protocol: /^https$/, message: "Use an https:// URL." }),
					]),
				}),
			render: (w) => (
				<DomainStep w={w} addresses={addresses} schemas={schemas} />
			),
		},
		{
			id: "dns",
			title: "Check DNS",
			description:
				"Before certificates are requested, confirm the provider can manage the zone, or that the wildcard already resolves to this server.",
			when: (v) => v.domainBase === "custom",
			testKeys: [
				"domainBase",
				"wildcard",
				"dnsProvider",
				"dnsCredentials",
				"reachFrom",
			],
			test: async (v) => {
				const s = credentialSchema(v);
				const target = recordsIp(v, addresses);
				if (s && v.dnsProvider !== "manual") {
					const base = domainBase(v, ip);
					try {
						const { zone } = await api.networking.dns.setupCheck(
							{
								kind: v.dnsProvider,
								credentials: toConfig(s, v.dnsCredentials),
								base,
							},
							v.setupToken.trim(),
						);
						return {
							ok: true,
							message: `${DNS_KINDS[v.dnsProvider].label} manages ${zone.name}`,
							detail: `On finish, LogiStack points *.${base} and ${base} at ${target} and requests one wildcard certificate over DNS-01.`,
						};
					} catch (err) {
						return {
							ok: false,
							message: "The DNS provider check failed",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				}
				const probe = `ls-check.${domainBase(v, ip)}`;
				const r = await checkDns(probe, v.setupToken.trim(), target);
				return r.ok
					? {
							ok: true,
							message: `${probe} resolves to ${r.expected}`,
							detail:
								v.dnsProvider === "manual"
									? "Certificates will be issued per hostname over HTTP-01."
									: "The DNS token is used for one wildcard certificate over DNS-01.",
						}
					: {
							ok: false,
							message: `${probe} doesn't resolve to ${r.expected} yet`,
							detail: r.resolved.length
								? `It resolves to ${r.resolved.join(", ")}. Update the A records, then test again.`
								: "No A record found. New records can take a few minutes to propagate.",
						};
			},
			render: (w) => {
				const managed = Boolean(credentialSchema(w.values));
				const target = recordsIp(w.values, addresses);
				return (
					<div className="grid gap-5">
						<DnsRecords base={domainBase(w.values, ip)} ip={target} />
						<TestPanel
							w={w}
							action={managed ? "Check credentials" : "Check DNS"}
							idle={
								managed
									? `We'll sign in to ${DNS_KINDS[w.values.dnsProvider as DnsKind]?.label ?? "the provider"} and find the zone that holds ${domainBase(w.values, ip)}. Nothing is written yet.`
									: `We'll look up a name under *.${domainBase(w.values, ip)} and compare it with ${target}.`
							}
						/>
					</div>
				);
			},
		},
		{
			id: "certificates",
			title: "Let's Encrypt email",
			description:
				"Let's Encrypt writes here about expiring certificates and changes to its terms. Nothing else.",
			schema: z.object({ leEmail: z.email("Enter a valid email address.") }),
			render: (w) => (
				<div className="grid max-w-md gap-4">
					<Field
						id="wz-leEmail"
						label="Email for certificate notices"
						error={w.error("leEmail")}
						hint="A shared ops inbox works better than a personal one."
					>
						<Input
							{...w.bind("leEmail")}
							type="email"
							inputMode="email"
							placeholder={w.values.ownerEmail || "ops@company.com"}
							autoFocus
						/>
					</Field>
				</div>
			),
		},
		{
			id: "registry",
			title: "Local registry",
			description:
				"Where images built from your repositories are stored, so every node can pull them.",
			render: (w) => (
				<div className="grid gap-5">
					<label
						htmlFor="wz-registry"
						className="flex cursor-pointer items-start gap-4 rounded-lg bg-card p-4 ring-1 ring-border"
					>
						<span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
							<HardDrive className="size-4" strokeWidth={1.75} aria-hidden />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block text-sm font-medium">
								Run a registry on this server
							</span>
							<span className="mt-1 block text-sm text-muted-foreground">
								LogiStack deploys a private OCI registry at{" "}
								<span className="font-mono text-xs text-foreground">
									registry.{domainBase(w.values, ip)}
								</span>{" "}
								with HTTPS and generated credentials, and cleans up old images
								while keeping the last few for rollbacks.
							</span>
						</span>
						<Switch
							id="wz-registry"
							checked={w.values.registry}
							onCheckedChange={(c) => w.set("registry", c)}
						/>
					</label>
					<ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
						<li className="flex gap-2.5">
							<Cloud className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>
								<span className="text-foreground">
									Needed with more than one node.
								</span>{" "}
								Other servers pull images from it instead of rebuilding.
							</span>
						</li>
						<li className="flex gap-2.5">
							<KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>
								<span className="text-foreground">
									Prefer GHCR or Docker Hub?
								</span>{" "}
								Turn this off and add one under Integrations → Registries.
							</span>
						</li>
					</ul>
				</div>
			),
		},
		{
			id: "review",
			title: "Review and finish",
			description:
				"Check the details. Everything except the owner account can change later.",
			render: (w) => {
				const v = w.values;
				const dns = DNS_PROVIDERS.find((p) => p.value === v.dnsProvider);
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "owner",
								title: "Owner",
								rows: [
									{ label: "Name", value: v.ownerName },
									{ label: "Email", value: v.ownerEmail },
									{
										label: "Password",
										value: v.ownerPassword ? "Set" : "Missing",
									},
								],
							},
							{
								stepId: "organization",
								title: "Organization",
								rows: [{ label: "Name", value: v.orgName }],
							},
							{
								stepId: "domain",
								title: "Domain",
								rows: [
									{
										label: "Instance URL",
										value: (
											<span className="font-mono text-xs">
												{publicUrl(v, ip)}
											</span>
										),
									},
									{
										label: "Service hostnames",
										value: (
											<span className="font-mono text-xs">
												*.{domainBase(v, ip)}
											</span>
										),
									},
									...(v.domainBase === "custom"
										? [
												{
													label: "Records point at",
													value: (
														<span className="font-mono text-xs">
															{recordsIp(v, addresses)}
														</span>
													),
												},
												...(addresses.lan
													? [
															{
																label: "Reachable from",
																value:
																	v.reachFrom === "lan"
																		? "This network only"
																		: "The internet, with ports 80 and 443 forwarded",
															},
														]
													: []),
												{
													label: "Certificates",
													value:
														v.dnsProvider === "manual"
															? "HTTP-01 per hostname"
															: `One wildcard via ${dns?.label}, records created for you`,
												},
											]
										: []),
								],
							},
							{
								stepId: "certificates",
								title: "Let's Encrypt",
								rows: [{ label: "Notices to", value: v.leEmail }],
							},
							{
								stepId: "registry",
								title: "Registry",
								rows: [
									{
										label: "Local registry",
										value: v.registry
											? `On, at registry.${domainBase(v, ip)}`
											: "Off",
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

/** Fixed states of the screen after setup, for design work on the mock (`/setup?move=nat`). */
function movePreview(move: "checking" | "reachable" | "nat" | "unresolved"): {
	result: SetupResult;
	initial: Move;
} {
	const result: SetupResult = {
		userId: "usr_mock",
		organizationId: "org_mock",
		dnsRecords: [
			{
				name: "*.home.example.com",
				type: "A",
				content: "81.57.58.142",
				error: null,
			},
			{
				name: "home.example.com",
				type: "A",
				content: "81.57.58.142",
				error: null,
			},
		],
		dashboard: {
			url: "https://logistack.home.example.com",
			hostname: "logistack.home.example.com",
			resolvesTo: move === "unresolved" ? [] : ["81.57.58.142"],
		},
		publicIp: "81.57.58.142",
	};
	const initial: Move =
		move === "checking"
			? { kind: "checking", since: Date.now() }
			: move === "reachable"
				? { kind: "reachable" }
				: move === "nat"
					? {
							kind: "unreachable",
							diagnosis: {
								kind: "nat",
								publicIp: "81.57.58.142",
								lanIp: "192.168.1.39",
							},
						}
					: { kind: "unreachable", diagnosis: { kind: "unresolved" } };
	return { result, initial };
}

function SetupPage() {
	const { step, move } = Route.useSearch();
	const [done, setDone] = useState<{ result: SetupResult; email: string }>();
	const preview = isMock && move ? movePreview(move) : undefined;
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: status } = useQuery(instanceStatusQuery);
	const complete = useCompleteSetup();
	const ip = status?.publicIp ?? "0.0.0.0";
	const lan =
		status?.lanAddress && status.publicIp && status.lanAddress !== ip
			? status.lanAddress
			: null;
	const { data: schemas } = useQuery(schemasQuery);
	const tokenRequired = status?.setupTokenRequired ?? false;
	const steps = useMemo(
		() => buildSteps({ ip, lan }, schemas?.dns, tokenRequired),
		[ip, lan, schemas, tokenRequired],
	);
	// install.sh prints the setup URL with `#token=`: a fragment never reaches a server or its logs.
	const [defaults] = useState(() => ({
		...DEFAULTS,
		// Behind NAT the public address answers only with port forwarding, so the LAN is the safe default.
		reachFrom: lan ? ("lan" as const) : ("internet" as const),
		setupToken:
			new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
	}));

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<div className="min-h-dvh">
			<header className="flex items-center justify-between px-4 py-4 sm:px-6">
				<Wordmark />
				<ThemeToggle />
			</header>
			<main className="mx-auto w-full max-w-5xl px-4 pt-4 pb-20 sm:px-6 lg:pt-10">
				{preview ? (
					<MoveScreen
						result={preview.result}
						email="owner@example.com"
						initial={preview.initial}
						autoOpen={false}
						browserHostname="192-168-1-39.sslip.io"
					/>
				) : done ? (
					<MoveScreen result={done.result} email={done.email} />
				) : (
					<>
						<div className="mb-8 lg:mb-12 lg:pl-[calc(13.5rem+3rem)]">
							<h1 className="flex items-center gap-2 text-2xl font-semibold">
								Set up LogiStack
							</h1>
							<p className="mt-1.5 max-w-[60ch] text-sm text-muted-foreground">
								A few answers and this server is ready for its first project. It
								takes about two minutes.
							</p>
						</div>
						<Wizard
							id="setup"
							steps={steps}
							defaultValues={defaults}
							secretKeys={["setupToken", "ownerPassword", "dnsCredentials"]}
							step={step}
							onStepChange={onStepChange}
							finishLabel="Finish setup"
							onComplete={async (v) => {
								const result = await complete.mutateAsync({
									setupToken: v.setupToken.trim(),
									input: {
										owner: {
											name: v.ownerName,
											email: v.ownerEmail,
											password: v.ownerPassword,
										},
										organization: { name: v.orgName.trim() },
										instance: {
											publicUrl: publicUrl(v, ip),
											generatedDomainBase: v.domainBase,
											customWildcard:
												v.domainBase === "custom"
													? `*.${domainBase(v, ip)}`
													: undefined,
											letsencryptEmail: v.leEmail,
											localRegistryEnabled: v.registry,
											reachFrom:
												recordsIp(v, { ip, lan }) === lan ? "lan" : "internet",
											dnsProvider:
												v.domainBase === "custom" && v.dnsProvider !== "manual"
													? {
															kind: v.dnsProvider,
															credentials: toConfig(
																schemas?.dns[v.dnsProvider] as ConfigSchema,
																v.dnsCredentials,
															),
														}
													: undefined,
										},
									},
								});
								// No sign-in here: the session would belong to this bootstrap origin, which Caddy
								// stops serving once it switches to the dashboard's own address.
								setDone({ result, email: v.ownerEmail });
							}}
						/>
					</>
				)}
			</main>
		</div>
	);
}
