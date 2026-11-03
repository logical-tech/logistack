import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import {
	Cloud,
	Globe,
	HardDrive,
	Info,
	KeyRound,
	ShieldCheck,
	Zap,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
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
import { auth } from "@/lib/auth";
import { DNS_KINDS } from "@/lib/integrations";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/setup")({
	validateSearch: z.object({ step: stepParam }),
	beforeLoad: async ({ context }) => {
		const status =
			await context.queryClient.ensureQueryData(instanceStatusQuery);
		// The mock instance is already set up; keep the flow reachable for design work.
		if (status.setupCompleted && !isMock) throw redirect({ to: "/" });
	},
	component: SetupPage,
});

type DnsChoice = DnsKind | "manual";

type SetupValues = {
	ownerName: string;
	ownerEmail: string;
	ownerPassword: string;
	orgName: string;
	domainBase: "custom" | "sslip" | "nip";
	wildcard: string;
	dnsProvider: DnsChoice;
	/** The provider's credential fields, from its config schema; never persisted. */
	dnsCredentials: ConfigValues;
	publicUrl: string;
	leEmail: string;
	registry: boolean;
};

const DEFAULTS: SetupValues = {
	ownerName: "",
	ownerEmail: "",
	ownerPassword: "",
	orgName: "",
	domainBase: "custom",
	wildcard: "",
	dnsProvider: "cloudflare",
	dnsCredentials: {},
	publicUrl: "",
	leEmail: "",
	registry: true,
};

const DNS_PROVIDERS: { value: DnsChoice; label: string }[] = [
	...(Object.keys(DNS_KINDS) as DnsKind[]).map((k) => ({
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
	ip,
	schemas,
}: {
	w: WizardApi<SetupValues>;
	ip: string;
	schemas: Record<string, unknown> | undefined;
}) {
	const v = w.values;
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
					<div className="grid gap-2">
						<p className="text-sm font-medium">DNS records</p>
						<p className="text-sm text-muted-foreground">
							{v.dnsProvider === "manual"
								? "Create these two records at your DNS host. Certificates are then issued per hostname over HTTP-01."
								: "LogiStack creates both records with these credentials when you finish, then issues one wildcard certificate over DNS-01."}
						</p>
						<DnsRecords base={domainBase(v, ip)} ip={ip} />
					</div>
				</div>
			) : (
				<div className="flex gap-3 rounded-lg bg-muted/60 p-4 text-sm dark:bg-muted/40">
					<Info className="mt-0.5 size-4 shrink-0 text-info-text" aria-hidden />
					<p className="text-muted-foreground">
						<span className="font-medium text-foreground">
							Good for trying LogiStack.
						</span>{" "}
						{v.domainBase}.io isn't on the Public Suffix List, so every instance
						using it shares one Let's Encrypt limit of 50 certificates a week.
						Issuance can stall when that budget runs out. Switch to your own
						domain any time in Settings.
					</p>
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
	ip: string,
	schemas: Record<string, unknown> | undefined,
): WizardStep<SetupValues>[] {
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
				ownerName: z.string().trim().min(1, "Enter your name."),
				ownerEmail: z.email("Enter a valid email address."),
				ownerPassword: z.string().min(12, "Use at least 12 characters."),
			}),
			render: (w) => (
				<div className="grid max-w-md gap-4">
					<Field id="wz-ownerName" label="Name" error={w.error("ownerName")}>
						<Input {...w.bind("ownerName")} autoComplete="name" autoFocus />
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
			render: (w) => <DomainStep w={w} ip={ip} schemas={schemas} />,
		},
		{
			id: "dns",
			title: "Check DNS",
			description:
				"Before certificates are requested, confirm the provider can manage the zone, or that the wildcard already resolves to this server.",
			when: (v) => v.domainBase === "custom",
			testKeys: ["domainBase", "wildcard", "dnsProvider", "dnsCredentials"],
			test: async (v) => {
				const s = credentialSchema(v);
				if (s && v.dnsProvider !== "manual") {
					const base = domainBase(v, ip);
					try {
						const { zone } = await api.networking.dns.setupCheck({
							kind: v.dnsProvider,
							credentials: toConfig(s, v.dnsCredentials),
							base,
						});
						return {
							ok: true,
							message: `${DNS_KINDS[v.dnsProvider].label} manages ${zone.name}`,
							detail: `On finish, LogiStack points *.${base} and ${base} at ${ip} and requests one wildcard certificate over DNS-01.`,
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
				const r = await checkDns(probe);
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
				return (
					<div className="grid gap-5">
						<DnsRecords base={domainBase(w.values, ip)} ip={ip} />
						<TestPanel
							w={w}
							action={managed ? "Check credentials" : "Check DNS"}
							idle={
								managed
									? `We'll sign in to ${DNS_KINDS[w.values.dnsProvider as DnsKind]?.label ?? "the provider"} and find the zone that holds ${domainBase(w.values, ip)}. Nothing is written yet.`
									: `We'll look up a name under *.${domainBase(w.values, ip)} and compare it with ${ip}.`
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

function SetupPage() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: status } = useQuery(instanceStatusQuery);
	const complete = useCompleteSetup();
	const ip = status?.publicIp ?? "0.0.0.0";
	const { data: schemas } = useQuery(schemasQuery);
	const steps = useMemo(() => buildSteps(ip, schemas?.dns), [ip, schemas]);

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
					defaultValues={DEFAULTS}
					secretKeys={["ownerPassword", "dnsCredentials"]}
					step={step}
					onStepChange={onStepChange}
					finishLabel="Finish setup"
					onComplete={async (v) => {
						await complete.mutateAsync({
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
						});
						// Setup creates the owner but no session; sign in as them.
						const signedIn = await auth.signInEmail({
							email: v.ownerEmail,
							password: v.ownerPassword,
							remember: true,
						});
						if (signedIn.kind !== "signed-in") {
							toast.success("LogiStack is ready", {
								description: "Sign in with the owner account.",
							});
							await navigate({ to: "/sign-in" });
							return;
						}
						toast.success("LogiStack is ready", {
							description: `Signed in as ${v.ownerEmail}.`,
						});
						await navigate({ to: "/" });
					}}
				/>
			</main>
		</div>
	);
}
