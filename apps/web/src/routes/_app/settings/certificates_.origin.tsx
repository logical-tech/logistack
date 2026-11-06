import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import {
	domainsQuery,
	type OriginRequest,
	type OriginTarget,
	useInvalidating,
} from "@/lib/api/networking";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/settings/certificates_/origin")({
	staticData: { crumb: "Cloudflare Origin certificate" },
	validateSearch: z.object({ step: stepParam }),
	component: IssueOriginCertificate,
});

type V = {
	domainId: string;
	keyType: OriginRequest["keyType"];
	validityDays: string;
};

const defaults: V = { domainId: "", keyType: "ecc", validityDays: "5475" };

const validities: { days: OriginRequest["validityDays"]; label: string }[] = [
	{ days: 5475, label: "15 years" },
	{ days: 1095, label: "3 years" },
	{ days: 730, label: "2 years" },
	{ days: 365, label: "1 year" },
	{ days: 90, label: "90 days" },
	{ days: 30, label: "30 days" },
	{ days: 7, label: "7 days" },
];
const validityLabel = (days: string) =>
	validities.find((v) => String(v.days) === days)?.label ?? days;

function FullStrict() {
	return (
		<Instructions
			href="https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/"
			link="Full (strict) in Cloudflare's docs"
		>
			<p>
				<strong>Then, in Cloudflare:</strong> set SSL/TLS encryption mode to{" "}
				<strong>Full (strict)</strong> and keep the DNS record{" "}
				<strong>proxied</strong>.
			</p>
			<p>
				Only Cloudflare trusts origin certificates. A browser that reaches this
				server directly, past Cloudflare, will show a certificate warning.
			</p>
		</Instructions>
	);
}

function IssueOriginCertificate() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: allDomains = [] } = useQuery(domainsQuery);
	const [target, setTarget] = useState<OriginTarget | null>(null);
	const issue = useInvalidating(
		(v: V) =>
			api.networking.certificates.originIssue(v.domainId, {
				keyType: v.keyType,
				validityDays: Number(v.validityDays) as OriginRequest["validityDays"],
			}),
		[["certificates"], ["domains"]],
	);
	// Tunnel domains are plain HTTP to cloudflared; wildcards stay on DNS-01.
	const domains = useMemo(
		() =>
			allDomains
				.filter((d) => !d.tunnel && !d.hostname.startsWith("*."))
				.sort((a, b) => a.hostname.localeCompare(b.hostname)),
		[allDomains],
	);
	const hostnameOf = useCallback(
		(id: string) => domains.find((d) => d.id === id)?.hostname ?? "",
		[domains],
	);

	const steps = useMemo(
		(): WizardStep<V>[] => [
			{
				id: "domain",
				title: "Domain",
				description:
					"The certificate names exactly this hostname, and the domain switches to it once issued.",
				schema: z.object({ domainId: z.string().min(1, "Pick a domain.") }),
				render: (w) => (
					<div className="grid max-w-md gap-4">
						<Field
							id="wz-domainId"
							label="Domain"
							error={w.error("domainId")}
							hint="Its zone must be on a Cloudflare DNS provider."
						>
							<Select
								value={w.values.domainId}
								onValueChange={(id) => w.set("domainId", id)}
							>
								<SelectTrigger
									id="wz-domainId"
									className="w-full"
									aria-invalid={Boolean(w.error("domainId")) || undefined}
								>
									<SelectValue placeholder="Choose a domain" />
								</SelectTrigger>
								<SelectContent>
									{domains.map((d) => (
										<SelectItem key={d.id} value={d.id}>
											<span className="font-mono">{d.hostname}</span>
											<span className="text-muted-foreground">
												{d.service.name}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</div>
				),
			},
			{
				id: "access",
				title: "Check Cloudflare access",
				description:
					"LogiStack finds the Cloudflare provider that manages this zone and asks Origin CA, with that provider's token, to list the zone's origin certificates. Nothing is issued yet.",
				testKeys: ["domainId"],
				test: async (v) => {
					try {
						const t = await api.networking.certificates.originTest(v.domainId);
						setTarget(t);
						return {
							ok: true,
							message: `Ready to issue through ${t.provider.name}`,
							detail: `Zone ${t.zone.name}. The token reaches Origin CA.`,
						};
					} catch (err) {
						return {
							ok: false,
							message: "Cloudflare can't issue for this domain yet",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<div className="grid gap-5">
						<Instructions
							href="https://dash.cloudflare.com/profile/api-tokens"
							link="Edit API tokens"
						>
							<p>
								The provider's API token needs{" "}
								<strong>Zone › SSL and Certificates › Edit</strong> on this
								zone, next to the DNS permission it already has.
							</p>
						</Instructions>
						<TestPanel
							w={w}
							action="Check access"
							idle={`We'll check Origin CA access for ${hostnameOf(w.values.domainId)}.`}
						/>
					</div>
				),
			},
			{
				id: "key",
				title: "Key and validity",
				description:
					"The private key is generated on this server and encrypted at rest. Only the signing request goes to Cloudflare.",
				schema: z.object({
					keyType: z.enum(["ecc", "rsa"]),
					validityDays: z.string().min(1),
				}),
				render: (w) => (
					<div className="grid gap-5">
						<ChoiceGroup
							label="Key type"
							value={w.values.keyType}
							onChange={(k) => w.set("keyType", k)}
							choices={[
								{
									value: "ecc",
									title: "ECDSA P-256",
									description:
										"Smaller and faster. Cloudflare's edge accepts it.",
									badge: "Recommended",
								},
								{
									value: "rsa",
									title: "RSA 2048",
									description: "For tooling that only reads RSA keys.",
								},
							]}
						/>
						<Field
							id="wz-validityDays"
							label="Valid for"
							hint="Cloudflare sends no expiry reminders; LogiStack lists the date with your certificates."
							className="max-w-xs"
						>
							<Select
								value={w.values.validityDays}
								onValueChange={(d) => w.set("validityDays", d)}
							>
								<SelectTrigger id="wz-validityDays" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{validities.map((v) => (
										<SelectItem key={v.days} value={String(v.days)}>
											{v.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</div>
				),
			},
			{
				id: "review",
				title: "Review and issue",
				render: (w) => (
					<div className="grid gap-5">
						<Summary
							w={w}
							sections={[
								{
									stepId: "domain",
									title: "Certificate",
									rows: [
										{
											label: "Hostname",
											value: (
												<span className="font-mono">
													{hostnameOf(w.values.domainId)}
												</span>
											),
										},
										...(target
											? [
													{ label: "Provider", value: target.provider.name },
													{ label: "Zone", value: target.zone.name },
												]
											: []),
									],
								},
								{
									stepId: "key",
									title: "Key",
									rows: [
										{
											label: "Type",
											value:
												w.values.keyType === "ecc" ? "ECDSA P-256" : "RSA 2048",
										},
										{
											label: "Valid for",
											value: validityLabel(w.values.validityDays),
										},
										{
											label: "Private key",
											value: "Generated here, encrypted at rest",
										},
									],
								},
							]}
						/>
						<FullStrict />
					</div>
				),
			},
		],
		[domains, hostnameOf, target],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Issue a Cloudflare Origin certificate"
				description="For a domain proxied through Cloudflare: a free certificate Cloudflare trusts for up to 15 years, so the zone can run Full (strict)."
			/>
			<Wizard
				id="certificate-origin"
				steps={steps}
				defaultValues={defaults}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Issue certificate"
				onComplete={async (v) => {
					const c = await issue.mutateAsync(v);
					toast.success(`Origin certificate issued for ${c.sans[0]}`, {
						description:
							"The domain now serves it. Set SSL/TLS to Full (strict) in Cloudflare.",
					});
					await navigate({ to: "/settings/certificates" });
				}}
			/>
		</Page>
	);
}
