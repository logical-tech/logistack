import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileCode2, Link2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import {
	type AutoJoinValues,
	autoJoinStep,
	domainOf,
	newProviderId,
} from "@/components/sso/auto-join";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import { serviceProviderQuery } from "@/lib/api/sso";
import { useSessionUser } from "@/lib/auth";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/settings/authentication_/saml")({
	staticData: { crumb: "Add SAML provider" },
	validateSearch: z.object({ step: stepParam }),
	component: NewSamlProvider,
});

type V = AutoJoinValues & {
	providerId: string;
	source: "url" | "xml";
	metadataUrl: string;
	metadataXml: string;
};

function ServiceProviderValues({ providerId }: { providerId: string }) {
	const { data } = useQuery(serviceProviderQuery(providerId));
	const rows = data
		? [
				[
					"ACS URL",
					data.acsUrl,
					"Also called Reply URL or Single sign-on URL.",
				],
				["Entity ID", data.entityId, "Also called Audience URI or Identifier."],
			]
		: [];
	return (
		<div className="grid max-w-2xl gap-5">
			{data ? (
				rows.map(([label, value, hint]) => (
					<Field key={label} id={`wz-${label}`} label={label ?? ""} hint={hint}>
						<CopyField value={value ?? ""} label={`Copy ${label}`} />
					</Field>
				))
			) : (
				<>
					<div className="t-skel h-9 rounded-lg bg-muted/60" />
					<div className="t-skel h-9 rounded-lg bg-muted/60" />
				</>
			)}
			<p className="text-sm text-muted-foreground">
				Send the email address as the NameID, or as an attribute named{" "}
				<code className="font-mono text-xs text-foreground">email</code>. Your
				identity provider then gives you its metadata for the next step.
			</p>
		</div>
	);
}

const metadataSchema = (v: V) =>
	v.source === "url"
		? z.object({
				metadataUrl: z.url({
					protocol: /^https$/,
					error: "Enter the metadata's https URL.",
				}),
			})
		: z.object({
				metadataXml: z
					.string()
					.trim()
					.min(1, "Paste the metadata XML.")
					.max(100_000, "Metadata over 100 KB isn't accepted.")
					.refine((x) => x.includes("EntityDescriptor"), {
						message:
							"That doesn't look like SAML metadata (no EntityDescriptor).",
					}),
			});

function NewSamlProvider() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const qc = useQueryClient();
	const user = useSessionUser();

	const steps = useMemo(
		(): WizardStep<V>[] => [
			{
				id: "service-provider",
				title: "Register LogiStack at your IdP",
				description:
					"Create a SAML application at your identity provider with these two values.",
				render: (w) => (
					<ServiceProviderValues providerId={w.values.providerId} />
				),
			},
			{
				id: "metadata",
				title: "Identity provider metadata",
				description:
					"The XML that names your identity provider, its sign-in URL and its signing certificate.",
				schema: metadataSchema,
				render: (w) => (
					<div className="grid gap-5">
						<ChoiceGroup
							label="Metadata source"
							value={w.values.source}
							onChange={(source) => w.set("source", source)}
							choices={[
								{
									value: "url",
									title: "Metadata URL",
									description: "LogiStack fetches it from the server.",
									icon: Link2,
								},
								{
									value: "xml",
									title: "Paste XML",
									description: "For a downloaded metadata file.",
									icon: FileCode2,
								},
							]}
						/>
						{w.values.source === "url" ? (
							<Field
								id="wz-metadataUrl"
								label="Metadata URL"
								error={w.error("metadataUrl")}
							>
								<Input
									{...w.bind("metadataUrl")}
									inputMode="url"
									autoCapitalize="none"
									spellCheck={false}
									placeholder="https://idp.company.com/saml/metadata"
									className="font-mono"
								/>
							</Field>
						) : (
							<Field
								id="wz-metadataXml"
								label="Metadata XML"
								error={w.error("metadataXml")}
							>
								<Textarea
									{...w.bind("metadataXml")}
									rows={8}
									spellCheck={false}
									placeholder={
										'<md:EntityDescriptor entityID="https://idp.company.com">…'
									}
									className="font-mono text-xs"
								/>
							</Field>
						)}
					</div>
				),
			},
			autoJoinStep<V>(),
			{
				id: "review",
				title: "Review",
				description:
					"LogiStack checks the metadata and its certificate as it saves.",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "metadata",
								title: "Identity provider",
								rows: [
									w.values.source === "url"
										? {
												label: "Metadata URL",
												value: (
													<span className="font-mono text-xs">
														{w.values.metadataUrl}
													</span>
												),
											}
										: {
												label: "Metadata",
												value: `Pasted XML, ${Math.ceil(w.values.metadataXml.length / 1024)} KB`,
											},
								],
							},
							{
								stepId: "auto-join",
								title: "Auto-join",
								rows: [
									{ label: "Email domain", value: `@${w.values.domain}` },
									{
										label: "Joins as",
										value: (
											<span className="capitalize">{w.values.defaultRole}</span>
										),
									},
								],
							},
						]}
					/>
				),
			},
		],
		[],
	);

	const defaults = useMemo<V>(
		() => ({
			providerId: newProviderId("saml"),
			source: "url",
			metadataUrl: "",
			metadataXml: "",
			domain: domainOf(user?.email),
			defaultRole: "developer",
		}),
		[user?.email],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add a SAML provider"
				description="Entra ID, Okta, OneLogin, ADFS, JumpCloud or any SAML 2.0 identity provider."
			/>
			<Wizard
				id="sso-saml"
				steps={steps}
				defaultValues={defaults}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Save provider"
				onComplete={async (v) => {
					const p = await api.sso.createSaml({
						providerId: v.providerId,
						domain: v.domain.trim().toLowerCase(),
						defaultRole: v.defaultRole,
						...(v.source === "url"
							? { metadataUrl: v.metadataUrl.trim() }
							: { metadataXml: v.metadataXml.trim() }),
					});
					await qc.invalidateQueries({ queryKey: ["sso"] });
					toast.success(`${p.issuer} connected`, {
						description: `People at @${p.domain} can sign in with SSO.`,
					});
					await navigate({ to: "/settings/authentication" });
				}}
			/>
		</Page>
	);
}
