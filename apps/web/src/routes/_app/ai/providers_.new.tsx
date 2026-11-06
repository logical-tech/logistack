import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { TierBadge } from "@/components/ai/parts";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
	type AiProviderKey,
	type AiProviderKeyInput,
	aiSettingsQuery,
	useCreateProviderKey,
	useRemoveProviderKey,
} from "@/lib/api/ai";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/ai/providers_/new")({
	staticData: { crumb: "Add provider" },
	validateSearch: z.object({ step: stepParam }),
	component: AddProvider,
});

type V = { provider: string; label: string; key: string; baseUrl: string };

const defaults: V = { provider: "", label: "", key: "", baseUrl: "" };

/** One line per provider for the picker; the catalog itself comes from the server. */
const BLURB: Record<string, string> = {
	groq: "Very fast Llama, Qwen and gpt-oss on a generous free tier.",
	cerebras: "gpt-oss-120b and Llama at thousands of tokens a second, free.",
	gemini: "Gemini Flash and Pro from Google AI Studio's free tier.",
	mistral: "Mistral Small, Medium and Codestral on the free plan.",
	openrouter: "Only the :free models from many labs, behind one key.",
	nvidia: "Hosted NIM endpoints for Llama, DeepSeek and more.",
	huggingface: "Inference Providers through the Hugging Face router.",
	cloudflare: "Workers AI models on Cloudflare's free daily allowance.",
	custom: "Ollama, vLLM, LM Studio or any OpenAI-compatible server.",
	openai: "GPT-5 and embeddings. Billed by OpenAI, counted as paid.",
	anthropic: "Claude Sonnet, Haiku and Opus. Billed by Anthropic.",
};

function AddProvider() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: settings } = useQuery(aiSettingsQuery);
	const create = useCreateProviderKey();
	const remove = useRemoveProviderKey();
	/** The key saved by the last passing test; finishing keeps it, a re-test replaces it. */
	const [saved, setSaved] = useState<AiProviderKey | null>(null);
	const providers = settings?.providers ?? [];
	const defOf = useCallback(
		(id: string) => providers.find((p) => p.id === id),
		[providers],
	);

	const steps = useMemo(
		(): WizardStep<V>[] => [
			{
				id: "provider",
				title: "Provider",
				description:
					"Free providers carry the auto chain at no cost. Paid ones bill your account with them and count against each member's paid budget.",
				schema: z.object({ provider: z.string().min(1, "Pick a provider.") }),
				render: (w) => (
					<ChoiceGroup
						label="Provider"
						value={w.values.provider || undefined}
						invalid={Boolean(w.error("provider"))}
						onChange={(id) => {
							w.set("provider", id);
							// Default the label to the provider's name until the user types one.
							if (
								!w.values.label ||
								providers.some((p) => p.name === w.values.label)
							)
								w.set("label", defOf(id)?.name ?? "");
						}}
						choices={providers.map((p) => ({
							value: p.id,
							title: p.name,
							description: BLURB[p.id] ?? "",
							badge: p.tier === "free" ? "Free" : "Paid",
						}))}
					/>
				),
			},
			{
				id: "key",
				title: "Key",
				description:
					"The key is encrypted at rest and never shown again, not even to admins.",
				schema: (v) => {
					const d = defOf(v.provider);
					return z.object({
						label: z.string().trim().min(1, "Name this key.").max(64),
						key: d?.customBaseUrl
							? z.string()
							: d?.id === "cloudflare"
								? z
										.string()
										.trim()
										.regex(/^[^:\s]+:\S+$/, "Use account-id:api-token.")
								: z
										.string()
										.trim()
										.min(1, `Paste your ${d?.name ?? ""} key.`),
						baseUrl: d?.customBaseUrl
							? z.url({
									protocol: /^https?$/,
									error: "An http(s) URL, ending in /v1.",
								})
							: z.string(),
					});
				},
				render: (w) => {
					const d = defOf(w.values.provider);
					return (
						<div className="grid gap-5">
							<Instructions
								href={d?.keyUrl ?? undefined}
								link={d?.keyUrl ? `Get a key from ${d.name}` : undefined}
							>
								{d?.customBaseUrl ? (
									<p>
										Point LogiStack at the server's OpenAI-compatible base URL,
										for Ollama <strong>http://host:11434/v1</strong>. The key is
										optional: leave it empty when the server has no auth.
									</p>
								) : d?.id === "cloudflare" ? (
									<p>
										Create an API token with <strong>Workers AI › Read</strong>,
										then paste it after your account ID, separated by a colon:{" "}
										<strong>account-id:api-token</strong>.
									</p>
								) : (
									<p>
										Create a key in the {d?.name} console. It looks like{" "}
										<strong className="font-mono">{d?.keyHint}</strong>.
									</p>
								)}
							</Instructions>
							<div className="grid max-w-md gap-4">
								<Field
									id="wz-label"
									label="Name"
									hint="Shown in the provider list, e.g. who owns the account."
									error={w.error("label")}
								>
									<Input {...w.bind("label")} autoComplete="off" />
								</Field>
								{d?.customBaseUrl && (
									<Field
										id="wz-baseUrl"
										label="Base URL"
										error={w.error("baseUrl")}
									>
										<Input
											{...w.bind("baseUrl")}
											inputMode="url"
											placeholder="http://10.0.0.5:11434/v1"
											className="font-mono"
										/>
									</Field>
								)}
								<Field
									id="wz-key"
									label={
										d?.id === "cloudflare" ? "Account ID and token" : "API key"
									}
									optional={d?.customBaseUrl}
									error={w.error("key")}
								>
									<Input
										{...w.bind("key")}
										type="password"
										autoComplete="off"
										spellCheck={false}
										placeholder={d?.keyHint}
										className="font-mono"
									/>
								</Field>
							</div>
						</div>
					);
				},
			},
			{
				id: "test",
				title: "Test the key",
				description:
					"LogiStack saves the key, asks the provider for its models and keeps the key only if the provider accepts it.",
				testKeys: ["provider", "key", "baseUrl", "label"],
				test: async (v) => {
					try {
						if (saved) {
							await remove.mutateAsync(saved.id).catch(() => undefined);
							setSaved(null);
						}
						const k = await create.mutateAsync({
							provider: v.provider as AiProviderKeyInput["provider"],
							label: v.label.trim(),
							key: v.key.trim(),
							...(defOf(v.provider)?.customBaseUrl && {
								baseUrl: v.baseUrl.trim(),
							}),
						});
						if (k.status === "unhealthy") {
							await remove.mutateAsync(k.id).catch(() => undefined);
							return {
								ok: false,
								message: "The provider rejected the key",
								detail: k.lastError ?? "Check the key and try again.",
							};
						}
						setSaved(k);
						return {
							ok: true,
							message:
								k.models.length > 0
									? `Connected: ${k.models.length} models available`
									: "Saved, but the provider listed no models",
							detail:
								k.models.length > 0
									? undefined
									: "Requests may still work; test again later from the provider list.",
						};
					} catch (err) {
						return {
							ok: false,
							message: "Couldn't save the key",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<div className="grid gap-5">
						<TestPanel
							w={w}
							action="Test key"
							idle={`We'll call ${defOf(w.values.provider)?.name ?? "the provider"} with this key and list its models.`}
						/>
						{w.test.phase === "passed" && saved && saved.models.length > 0 && (
							<ModelList models={saved.models} />
						)}
					</div>
				),
			},
			{
				id: "review",
				title: "Done",
				render: (w) => {
					const d = defOf(w.values.provider);
					return (
						<Summary
							w={w}
							sections={[
								{
									stepId: "provider",
									title: "Provider",
									rows: [
										{
											label: "Provider",
											value: (
												<span className="inline-flex items-center gap-2">
													{d?.name}
													{d && <TierBadge tier={d.tier} />}
												</span>
											),
										},
									],
								},
								{
									stepId: "key",
									title: "Key",
									rows: [
										{ label: "Name", value: w.values.label },
										...(d?.customBaseUrl
											? [
													{
														label: "Base URL",
														value: (
															<span className="font-mono">
																{w.values.baseUrl}
															</span>
														),
													},
												]
											: []),
										{ label: "Secret", value: "Encrypted at rest" },
									],
								},
								{
									stepId: "test",
									title: "Test",
									rows: [
										{
											label: "Status",
											value:
												saved?.status === "healthy"
													? "Healthy"
													: "Saved, not verified",
										},
										{
											label: "Models",
											value: saved ? `${saved.models.length}` : "–",
										},
									],
								},
							]}
						/>
					);
				},
			},
		],
		[providers, defOf, saved, create, remove],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add a model provider"
				description="Connect a provider's API key. The gateway routes to it as soon as the key passes its test."
			/>
			{settings && (
				<Wizard
					id="ai-provider"
					steps={steps}
					defaultValues={defaults}
					secretKeys={["key"]}
					step={step}
					onStepChange={onStepChange}
					finishLabel="Done"
					onComplete={async (v) => {
						toast.success(`${v.label} added`, {
							description:
								defOf(v.provider)?.tier === "paid"
									? "Its spend counts against each member's paid budget."
									: "Add its models to the auto chain to use them for free.",
						});
						await navigate({ to: "/ai/providers" });
					}}
				/>
			)}
		</Page>
	);
}

function ModelList({ models }: { models: string[] }) {
	const shown = models.slice(0, 24);
	return (
		<div className="t-reveal grid gap-2">
			<span className="text-sm font-medium">Models this key serves</span>
			<ul className="flex flex-wrap gap-1.5">
				{shown.map((m) => (
					<li
						key={m}
						className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground dark:bg-muted/60"
					>
						{m}
					</li>
				))}
				{models.length > shown.length && (
					<li className="px-2 py-1 text-xs text-muted-foreground">
						and {models.length - shown.length} more
					</li>
				)}
			</ul>
		</div>
	);
}
