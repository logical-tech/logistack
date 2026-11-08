import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import {
	ConfigFields,
	type ConfigSchema,
	type ConfigValues,
	initialValues,
	missingFields,
	toConfig,
} from "@/components/integrations/config-form";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { ChoiceGroup, Summary, TestPanel } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import { schemasQuery, useInvalidating } from "@/lib/api/networking";
import type { SecretProviderKind } from "@/lib/api/secrets";
import { SECRET_PROVIDER_KINDS } from "@/lib/integrations";
import { usePluginChoices } from "@/lib/plugin-providers";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute(
	"/_app/integrations/secret-providers_/new",
)({
	staticData: { crumb: "Add provider" },
	validateSearch: z.object({ step: stepParam }),
	component: NewSecretProvider,
});

/** `kind` is the radio value: a built-in kind, or a plugin provider's key. */
type V = { kind: string; config: ConfigValues; name: string };

const HINTS: Partial<Record<SecretProviderKind, Record<string, string>>> = {
	vault: {
		url: "The Vault address, like https://vault.example.com:8200. Plain http works only to a private address, once private hosts are allowed in Settings.",
		token:
			"A token whose policy can read the KV v2 paths you will reference. A periodic token keeps working without renewals.",
		namespace: "Vault Enterprise or HCP only.",
	},
	infisical: {
		url: "Keep the default for Infisical Cloud, or your instance's address.",
		clientId:
			"Organization settings → Access Control → Identities → a machine identity with Universal Auth.",
		clientSecret: "Created on the identity's Universal Auth panel.",
		projectId:
			"Project settings → Project ID. Add the identity to the project with read access.",
	},
	onepassword: {
		url: "Your 1Password Connect server, like https://op-connect.example.com.",
		token:
			"Developer → Connect servers → an access token with read access to the vaults you need.",
	},
};

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function NewSecretProvider() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: schemas } = useQuery(schemasQuery);
	const create = useInvalidating(api.secrets.providers.create, [
		["secret-providers"],
	]);
	const fromPlugins = usePluginChoices<SecretProviderKind>("secretProviders");
	const { resolve } = fromPlugins;
	const schemaOf = useCallback(
		(value: string) => {
			const { kind, plugin } = resolve(value);
			return plugin
				? plugin.schema
				: (schemas?.secrets[kind] as ConfigSchema | undefined);
		},
		[schemas, resolve],
	);
	/** The label and reference shape of a radio value. */
	const meta = useCallback(
		(value: string) => {
			const { kind, plugin } = resolve(value);
			const k = SECRET_PROVIDER_KINDS[kind];
			return { ...k, kind, plugin, label: plugin?.title ?? k.label };
		},
		[resolve],
	);

	const steps = useMemo((): WizardStep<V>[] => {
		const config = (v: V) => {
			const s = schemaOf(v.kind);
			return s ? toConfig(s, v.config) : {};
		};
		return [
			{
				id: "kind",
				title: "Where do your secrets live?",
				description:
					"LogiStack reads them at deploy time and keeps no copy. Add one provider per server or project.",
				render: (w) => (
					<ChoiceGroup
						label="Provider"
						value={w.values.kind}
						onChange={(kind) => {
							w.set("kind", kind);
							const s = schemaOf(kind);
							w.set("config", s ? initialValues(s) : {});
						}}
						choices={[
							...(Object.keys(SECRET_PROVIDER_KINDS) as SecretProviderKind[])
								.filter((k) => k !== "plugin")
								.map((k) => ({
									value: k as string,
									title: SECRET_PROVIDER_KINDS[k].label,
									description: SECRET_PROVIDER_KINDS[k].blurb,
									icon: SECRET_PROVIDER_KINDS[k].icon,
								})),
							...fromPlugins.choices,
						]}
					/>
				),
			},
			{
				id: "configure",
				title: "Connect it",
				description:
					"Masked fields are credentials: they are encrypted at rest and never shown again. Give it read access only.",
				schema: (v) =>
					z.object({ config: z.any() }).superRefine((_, ctx) => {
						const s = schemaOf(v.kind);
						if (s && Object.keys(missingFields(s, v.config)).length)
							ctx.addIssue({
								code: "custom",
								path: ["config"],
								message: "Fill in the required fields.",
							});
					}),
				render: (w) => {
					const s = schemaOf(w.values.kind);
					if (!s) return null;
					return (
						<ConfigFields
							schema={s}
							idPrefix="wz-cfg"
							values={w.values.config}
							onChange={(c) => w.set("config", c)}
							errors={
								w.error("config") ? missingFields(s, w.values.config) : {}
							}
							hints={HINTS[meta(w.values.kind).kind]}
						/>
					);
				},
			},
			{
				id: "test",
				title: "Test the connection",
				description:
					"LogiStack signs in with these credentials. It reads no secret.",
				testKeys: ["kind", "config"],
				test: async (v) => {
					try {
						const m = meta(v.kind);
						await api.secrets.providers.testConfig(
							m.kind,
							config(v),
							m.plugin?.ref,
						);
						return {
							ok: true,
							message: `Signed in to ${m.label}`,
							detail: "The credentials work from this server.",
						};
					} catch (err) {
						return {
							ok: false,
							message: "Couldn't sign in",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<TestPanel
						w={w}
						action="Test connection"
						idle={`We'll sign in to ${meta(w.values.kind).label} from this server.`}
					/>
				),
			},
			{
				id: "name",
				title: "Name it",
				description:
					"References start with this name, so keep it short and stable.",
				schema: z.object({
					name: z
						.string()
						.trim()
						.regex(
							NAME,
							"Lowercase letters, digits and dashes, starting with a letter or digit.",
						),
				}),
				render: (w) => (
					<div className="grid max-w-md gap-4">
						<Field
							id="wz-name"
							label="Name"
							error={w.error("name")}
							hint={
								<>
									Secrets will read{" "}
									<code className="font-mono text-foreground">
										secret://{w.values.name || "name"}/
										{meta(w.values.kind).path}
									</code>
								</>
							}
						>
							<Input
								{...w.bind("name")}
								autoFocus
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								placeholder={`${meta(w.values.kind).kind}-prod`}
							/>
						</Field>
					</div>
				),
			},
			{
				id: "review",
				title: "Review and add",
				description:
					"Next, create a secret with a reference, or type one as a service variable's value.",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "kind",
								title: "Provider",
								rows: [
									{
										label: "Kind",
										value: meta(w.values.kind).label,
									},
									{ label: "Name", value: w.values.name },
									{
										label: "Example",
										value: (
											<code className="font-mono">
												secret://{w.values.name}/{meta(w.values.kind).example}
											</code>
										),
									},
									{ label: "Connection", value: "Signed in" },
								],
							},
						]}
					/>
				),
			},
		];
	}, [schemaOf, meta, fromPlugins.choices]);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	if (!schemas) return null;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add a secret provider"
				description="Keep secrets in the manager your company already uses; deployments read them when they start."
			/>
			<Wizard<V>
				id="secret-provider"
				steps={steps}
				defaultValues={{
					kind: "vault",
					config: initialValues(schemas.secrets.vault as ConfigSchema),
					name: "",
				}}
				secretKeys={["config"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Add provider"
				onComplete={async (v) => {
					const s = schemaOf(v.kind);
					const m = meta(v.kind);
					const p = await create.mutateAsync({
						kind: m.kind,
						name: v.name.trim(),
						config: s ? toConfig(s, v.config) : {},
						...m.plugin?.ref,
					});
					toast.success(`${p.name} added`, {
						description: `Reference its secrets as secret://${p.name}/…`,
					});
					await navigate({ to: "/integrations/secret-providers" });
				}}
			/>
		</Page>
	);
}
