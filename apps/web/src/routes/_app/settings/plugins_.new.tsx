import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Container, Link2, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CopyLine } from "@/components/access/mcp-section";
import { Field } from "@/components/field";
import {
	ConfigFields,
	type ConfigSchema,
	type ConfigValues,
	hasFields,
	initialValues,
	missingFields,
	toConfig,
} from "@/components/integrations/config-form";
import { Page, PageHeader } from "@/components/page-header";
import {
	ManifestSummary,
	shortDigest,
} from "@/components/plugins/manifest-summary";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ChoiceGroup, Summary, TestPanel } from "@/components/wizard/parts";
import {
	type TestResult,
	Wizard,
	type WizardStep,
} from "@/components/wizard/wizard";
import { registriesQuery } from "@/lib/api/integrations";
import { useInvalidating } from "@/lib/api/networking";
import {
	type CreatedPlugin,
	type PluginInspection,
	type PluginSource,
	pluginsApi,
} from "@/lib/api/plugins";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/settings/plugins_/new")({
	staticData: { crumb: "Install plugin" },
	validateSearch: z.object({ step: stepParam }),
	component: NewPlugin,
});

type V = {
	kind: "image" | "url";
	image: string;
	/** "" means a public image. */
	registryId: string;
	url: string;
	config: ConfigValues;
};

const DEFAULTS: V = {
	kind: "image",
	image: "",
	registryId: "",
	url: "",
	config: {},
};

const sourceOf = (v: V): PluginSource =>
	v.kind === "image"
		? {
				kind: "image",
				image: v.image.trim(),
				...(v.registryId && { registryId: v.registryId }),
			}
		: { kind: "url", url: v.url.trim() };

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

const POLL_MS = 1500;
const START_TIMEOUT_MS = 120_000;

/** Polls the install until the reconciler settles it, then asks the plugin itself. */
async function waitAndTest(id: string): Promise<TestResult> {
	const until = Date.now() + START_TIMEOUT_MS;
	for (;;) {
		const p = await pluginsApi.get(id);
		if (p.status === "error")
			return {
				ok: false,
				message: "The plugin didn't start",
				detail: p.statusMessage ?? undefined,
			};
		if (p.status === "running") break;
		if (Date.now() > until)
			return {
				ok: false,
				message: "Still starting after two minutes",
				detail:
					"Pulling a large image can take a while. Test again in a moment, or check the plugin's service logs.",
			};
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	const t = await pluginsApi.test(id);
	if (t.ok)
		return {
			ok: true,
			message: "Running and healthy",
			detail:
				t.config === null
					? "The plugin answered its health check."
					: "The plugin answered its health check and accepted the settings.",
		};
	return {
		ok: false,
		message: !t.health.ok
			? "The plugin doesn't answer its health check"
			: "The plugin rejected the settings",
		detail: (!t.health.ok ? t.health.error : t.config?.error) ?? undefined,
	};
}

function SourceFields({ w }: { w: Parameters<WizardStep<V>["render"]>[0] }) {
	const { data } = useQuery(registriesQuery);
	const registries = data?.registries ?? [];
	return (
		<div className="grid gap-6">
			<ChoiceGroup
				label="Source"
				value={w.values.kind}
				onChange={(kind) => w.set("kind", kind)}
				choices={[
					{
						value: "image",
						title: "Container image",
						description:
							"Any OCI image with a LogiStack manifest label, pinned to its digest.",
						icon: Container,
					},
					{
						value: "url",
						title: "Dev URL",
						description:
							"A plugin running elsewhere while you build it. No container starts here.",
						icon: Link2,
					},
				]}
			/>
			<div className="grid max-w-md gap-4">
				{w.values.kind === "image" ? (
					<>
						<Field
							id="wz-image"
							label="Image"
							hint="A tag or a digest; LogiStack pins it to the digest it reads now."
							error={w.error("image")}
						>
							<Input
								{...w.bind("image")}
								placeholder="ghcr.io/acme/cost-report:1.2.0"
								className="font-mono"
								autoCapitalize="none"
								spellCheck={false}
								autoFocus
							/>
						</Field>
						<Field
							id="wz-registry"
							label="Registry credentials"
							hint="For a private image; nodes pull with these."
						>
							<Select
								value={w.values.registryId || "public"}
								onValueChange={(v) =>
									w.set("registryId", v === "public" ? "" : v)
								}
							>
								<SelectTrigger id="wz-registry" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="public">None, a public image</SelectItem>
									{registries.map((r) => (
										<SelectItem key={r.id} value={r.id}>
											{r.url}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</>
				) : (
					<Field
						id="wz-url"
						label="URL"
						hint="Where the plugin answers, as https://my-laptop.tailnet.ts.net:8080. LogiStack calls it with signed requests."
						error={w.error("url")}
					>
						<Input
							{...w.bind("url")}
							placeholder="https://"
							className="font-mono"
							autoCapitalize="none"
							spellCheck={false}
							autoFocus
						/>
					</Field>
				)}
			</div>
			<TestPanel
				w={w}
				action="Read manifest"
				idle={
					w.values.kind === "image"
						? "We'll resolve the image to a digest and read its manifest label. Nothing runs yet."
						: "We'll fetch the plugin's manifest from that URL. Nothing is installed yet."
				}
			/>
		</div>
	);
}

/** Shown once, like a new API key: what a plugin running elsewhere needs to talk back. */
function DevCredentials({
	installId,
	creds,
}: {
	installId: string;
	creds: NonNullable<CreatedPlugin["devCredentials"]>;
}) {
	const env = [
		["LOGISTACK_URL", window.location.origin, "Instance URL"],
		["LOGISTACK_INSTALL_ID", installId, "Install ID"],
		["LOGISTACK_TOKEN", creds.token, "API token"],
		["LOGISTACK_SIGNING_SECRET", creds.signingSecret, "Signing secret"],
	] as const;
	return (
		<div className="t-reveal grid gap-5">
			<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
				<TriangleAlert
					className="mt-0.5 size-4 shrink-0 text-warn-text"
					aria-hidden
				/>
				<p>
					<span className="font-medium">Copy these now.</span>{" "}
					<span className="text-muted-foreground">
						Set them in the plugin's environment. LogiStack stores them
						encrypted and won't show them again.
					</span>
				</p>
			</div>
			{env.map(([name, value, label]) => (
				<div key={name} className="grid gap-1.5">
					<span className="font-mono text-xs font-medium">{name}</span>
					<CopyLine value={value} label={label} wrap />
				</div>
			))}
		</div>
	);
}

function NewPlugin() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const create = useInvalidating(pluginsApi.create, [["plugins"]]);
	const [inspection, setInspection] = useState<PluginInspection | null>(null);
	const [installed, setInstalled] = useState<CreatedPlugin | null>(null);
	const manifestSchema = inspection?.manifest.config as
		| ConfigSchema
		| undefined;
	// A plugin without settings has no form; treat it like no schema at all.
	const schema =
		manifestSchema && hasFields(manifestSchema) ? manifestSchema : undefined;
	// Untouched settings mean the schema's defaults.
	const configOf = useCallback(
		(v: V) =>
			schema && !Object.keys(v.config).length
				? initialValues(schema)
				: v.config,
		[schema],
	);

	const steps = useMemo(
		(): WizardStep<V>[] => [
			{
				id: "source",
				title: "Where is the plugin?",
				description:
					"A plugin is a container LogiStack runs for this organization, never code inside LogiStack itself.",
				schema: (v: V) =>
					v.kind === "image"
						? z.object({
								image: z
									.string()
									.trim()
									.min(1, "Enter an image reference.")
									.regex(/^[^\s]+$/, "No spaces in an image reference."),
							})
						: z.object({
								url: z
									.string()
									.trim()
									.regex(/^https?:\/\/\S+$/, "An http:// or https:// URL."),
							}),
				testKeys: ["kind", "image", "registryId", "url"],
				test: async (v) => {
					try {
						const r = await pluginsApi.inspect(sourceOf(v));
						setInspection(r);
						if (r.installedId)
							return {
								ok: false,
								message: `${r.manifest.name} is already installed`,
								detail:
									"Open it from Settings → Plugins to change its settings, or uninstall it first.",
							};
						return {
							ok: true,
							message: `${r.manifest.name} ${r.manifest.version}`,
							detail: r.image
								? `Pinned to ${shortDigest(r.image)}.`
								: "Manifest read from the dev URL.",
						};
					} catch (err) {
						setInspection(null);
						return {
							ok: false,
							message: "Couldn't read a plugin manifest",
							detail: errorText(err),
						};
					}
				},
				render: (w) => <SourceFields w={w} />,
			},
			{
				id: "review",
				title: "Review what it gets",
				description:
					"Read this like an app's permission prompt: what it adds, what its API token may do, and where it says it connects.",
				ready: () =>
					!inspection
						? "Read the manifest first"
						: inspection.missingPermissions.length
							? "You can't grant permissions you don't hold"
							: true,
				render: (w) =>
					inspection ? (
						<div className="grid gap-4">
							{inspection.missingPermissions.length > 0 && (
								<div
									role="alert"
									className="flex items-start gap-3 rounded-lg bg-bad/10 px-3.5 py-3 text-sm"
								>
									<TriangleAlert
										className="mt-0.5 size-4 shrink-0 text-bad-text"
										aria-hidden
									/>
									<p>
										<span className="font-medium">
											It asks for more than you hold.
										</span>{" "}
										<span className="text-muted-foreground">
											A plugin can't receive a permission its installer doesn't
											have. Ask an owner to install it, or to grant you the
											missing permission on the whole organization.
										</span>
									</p>
								</div>
							)}
							<ManifestSummary
								manifest={inspection.manifest}
								image={inspection.image}
								devUrl={inspection.devUrl}
								missingPermissions={inspection.missingPermissions}
							/>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							<button
								type="button"
								className="underline underline-offset-4"
								onClick={() => w.goTo("source")}
							>
								Go back to Source
							</button>{" "}
							and read the manifest.
						</p>
					),
			},
			{
				id: "configure",
				title: "Settings",
				description:
					"Secrets are encrypted and sent to the plugin with each request, never put in its environment.",
				schema: (v: V) =>
					z.any().superRefine((_, ctx) => {
						if (
							schema &&
							Object.keys(missingFields(schema, configOf(v))).length > 0
						)
							ctx.addIssue({
								code: "custom",
								path: ["config"],
								message: "Fill in the required settings.",
							});
					}),
				render: (w) => {
					if (!schema)
						return (
							<p className="text-sm text-muted-foreground">
								This plugin has no settings.
							</p>
						);
					return (
						<ConfigFields
							schema={schema}
							values={configOf(w.values)}
							onChange={(c) => w.set("config", c)}
							errors={
								w.error("config")
									? missingFields(schema, configOf(w.values))
									: {}
							}
							idPrefix="wz-config"
						/>
					);
				},
			},
			{
				id: "install",
				title: "Install and test",
				description: inspection?.image
					? "LogiStack starts the container, waits for its health check, then sends it the settings to validate."
					: "LogiStack registers the dev URL, waits for its health check, then sends it the settings to validate.",
				testKeys: ["config"],
				test: async (v) => {
					if (!inspection)
						return { ok: false, message: "Read the manifest first" };
					const config = schema ? toConfig(schema, configOf(v)) : {};
					try {
						let id = installed?.id;
						if (id) await pluginsApi.update(id, { config });
						else {
							const p = await create.mutateAsync({
								source: sourceOf(v),
								config,
							});
							setInstalled(p);
							id = p.id;
						}
						return await waitAndTest(id);
					} catch (err) {
						return {
							ok: false,
							message: installed
								? "Couldn't save the settings"
								: "Couldn't install",
							detail: errorText(err),
						};
					}
				},
				render: (w) => (
					<div className="grid gap-6">
						<TestPanel
							w={w}
							action={installed ? "Save and test" : "Install"}
							idle={
								installed
									? "Installed. Run the test again after changing settings."
									: `We'll install ${inspection?.manifest.name ?? "the plugin"} in this organization and start it.`
							}
						/>
						{installed?.devCredentials && (
							<DevCredentials
								installId={installed.id}
								creds={installed.devCredentials}
							/>
						)}
					</div>
				),
			},
			{
				id: "summary",
				title: "Summary",
				description:
					"Installed and healthy. Its pages show up for everyone who can read them.",
				render: (w) => {
					const m = inspection?.manifest;
					const pages = m?.contributes.pages ?? [];
					return (
						<Summary
							w={w}
							sections={[
								{
									stepId: "source",
									title: "Plugin",
									rows: [
										{ label: "Name", value: m ? `${m.name} ${m.version}` : "" },
										{
											label: inspection?.image ? "Image" : "Dev URL",
											value: (
												<span className="font-mono text-xs">
													{inspection?.image
														? shortDigest(inspection.image)
														: inspection?.devUrl}
												</span>
											),
										},
									],
								},
								{
									stepId: "review",
									title: "Contributes",
									rows: [
										{
											label: "Pages",
											value: pages.length
												? pages.map((p) => p.title).join(", ")
												: "None",
										},
										{
											label: "Events",
											value: m?.contributes.events.length
												? m.contributes.events.join(", ")
												: "None",
										},
									],
								},
								{
									stepId: "install",
									title: "Status",
									rows: [{ label: "Test", value: "Running and healthy" }],
								},
							]}
						/>
					);
				},
			},
		],
		[inspection, installed, schema, create, configOf],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Install a plugin"
				description="Review what it adds and what it may do before anything runs."
			/>
			<Wizard<V>
				id="install-plugin"
				steps={steps}
				defaultValues={DEFAULTS}
				// Settings can hold secrets: never written to sessionStorage.
				secretKeys={["config"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Done"
				onComplete={async () => {
					if (!installed) throw new Error("Install the plugin first.");
					toast.success(`${installed.name} installed`);
					await navigate({
						to: "/settings/plugins/$installId",
						params: { installId: installed.id },
					});
				}}
			/>
		</Page>
	);
}
