import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { KeyRound, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/access/copy-button";
import { CopyLine } from "@/components/access/mcp-section";
import { useAiSettings } from "@/components/ai/ai-page";
import { TierBadge } from "@/components/ai/parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { Field } from "@/components/field";
import { Panel, SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	type AiGatewayKey,
	type AiModel,
	type AiSettings,
	aiGatewayKeysQuery,
	aiModelsQuery,
	type CreatedAiGatewayKey,
	gatewayBaseUrl,
	useCreateGatewayKey,
	useRemoveGatewayKey,
	useUpdateAiSettings,
} from "@/lib/api/ai";
import { relativeTime } from "@/lib/format";

export const Route = createFileRoute("/_app/ai/gateway")({
	staticData: { crumb: "Gateway" },
	component: GatewayPage,
});

function GatewayPage() {
	const settings = useAiSettings();
	const [creating, setCreating] = useState(false);
	return (
		<div className="grid gap-10">
			<Endpoint settings={settings} />
			<Keys settings={settings} onCreate={() => setCreating(true)} />
			<Snippets />
			<Models settings={settings} />
			<CreateKeyDialog open={creating} onOpenChange={setCreating} />
		</div>
	);
}

function Endpoint({ settings }: { settings: AiSettings }) {
	const save = useUpdateAiSettings();
	const on = settings.gatewayEnabled;
	return (
		<Panel title="Endpoint" id="endpoint">
			<div className="grid gap-5 p-4 sm:p-5">
				<div className="flex items-start justify-between gap-6">
					<div className="grid gap-1">
						<label htmlFor="gateway-enabled" className="text-sm font-medium">
							{on ? "Accepting requests" : "Gateway is off"}
						</label>
						<p className="max-w-[64ch] text-sm text-pretty text-muted-foreground">
							{on
								? "Any member's gateway key can call the endpoint below, within their monthly budget."
								: settings.canAdmin
									? "Requests are refused until you turn it on. Keys and budgets stay as they are."
									: "An admin has turned the gateway off. Your keys will work again once it's back on."}
						</p>
					</div>
					{settings.canAdmin && (
						<Switch
							id="gateway-enabled"
							checked={on}
							disabled={save.isPending}
							onCheckedChange={(gatewayEnabled) =>
								save.mutate(
									{ gatewayEnabled },
									{
										onSuccess: () =>
											toast.success(
												gatewayEnabled ? "Gateway on" : "Gateway off",
											),
										onError: (e) =>
											toast.error("Couldn't change the gateway", {
												description: e.message,
											}),
									},
								)
							}
						/>
					)}
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="grid content-start gap-1.5">
						<span className="text-sm font-medium">Base URL</span>
						<CopyLine value={gatewayBaseUrl()} label="gateway base URL" />
						<p className="text-xs text-muted-foreground">
							OpenAI-compatible:{" "}
							<code className="font-mono">/chat/completions</code>,{" "}
							<code className="font-mono">/responses</code>,{" "}
							<code className="font-mono">/embeddings</code>,{" "}
							<code className="font-mono">/models</code>. Anthropic-compatible:{" "}
							<code className="font-mono">/messages</code>.
						</p>
					</div>
					<div className="grid content-start gap-1.5">
						<span className="text-sm font-medium">Model names</span>
						<ul className="grid gap-1.5 text-sm text-muted-foreground">
							<li>
								<code className="font-mono text-xs text-foreground">auto</code>{" "}
								tries the free chain in order.
							</li>
							<li>
								<code className="font-mono text-xs text-foreground">
									groq/llama-3.3-70b-versatile
								</code>{" "}
								pins a provider.
							</li>
							<li>
								<code className="font-mono text-xs text-foreground">
									gpt-5-mini
								</code>{" "}
								goes to any provider serving it.
							</li>
						</ul>
					</div>
				</div>
			</div>
		</Panel>
	);
}

const keyCol = createColumnHelper<BaseFeatures, AiGatewayKey>();

function Keys({
	settings,
	onCreate,
}: {
	settings: AiSettings;
	onCreate: () => void;
}) {
	const { data: keys } = useQuery(aiGatewayKeysQuery);
	const remove = useRemoveGatewayKey();
	const [revoking, setRevoking] = useState<AiGatewayKey | null>(null);
	const columns = keyCol.columns([
		keyCol.display({
			id: "name",
			header: "Name",
			cell: ({ row: { original: k } }) => (
				<div className="min-w-0">
					<span className="block truncate font-medium">{k.name}</span>
					<span className="block truncate font-mono text-xs text-muted-foreground">
						{k.start}…
					</span>
				</div>
			),
		}),
		...(settings.canAdmin
			? [
					keyCol.display({
						id: "owner",
						header: "Owner",
						meta: { className: "w-[22%] max-sm:hidden" },
						cell: ({ row: { original: k } }) => (
							<span className="block truncate">{k.userName}</span>
						),
					}),
				]
			: []),
		keyCol.display({
			id: "used",
			header: "Last used",
			meta: { className: "w-32 max-sm:hidden" },
			cell: ({ row: { original: k } }) =>
				k.lastUsedAt ? (
					<time
						dateTime={k.lastUsedAt}
						title={new Date(k.lastUsedAt).toLocaleString()}
						className="whitespace-nowrap"
					>
						{relativeTime(k.lastUsedAt)}
					</time>
				) : (
					<span className="text-muted-foreground">Never</span>
				),
		}),
		keyCol.display({
			id: "created",
			header: "Created",
			meta: { className: "w-28 max-md:hidden" },
			cell: ({ row: { original: k } }) => (
				<span className="whitespace-nowrap text-muted-foreground">
					{relativeTime(k.createdAt)}
				</span>
			),
		}),
		keyCol.display({
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			meta: { className: "w-14 text-right" },
			cell: ({ row: { original: k } }) => (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Revoke ${k.name}`}
					onClick={() => setRevoking(k)}
				>
					<Trash2 />
				</Button>
			),
		}),
	]);
	return (
		<Panel
			title={settings.canAdmin ? "Gateway keys" : "Your keys"}
			id="gateway-keys"
			actions={
				<Button size="sm" variant="outline" onClick={onCreate}>
					<Plus data-icon="inline-start" />
					Create key
				</Button>
			}
		>
			{!keys ? (
				<SkeletonRows rows={3} />
			) : (
				<DataTable
					label="Gateway keys"
					columns={columns}
					data={keys}
					getRowId={(k) => k.id}
					empty={
						<div className="grid justify-items-center gap-3">
							<KeyRound
								className="size-5 text-muted-foreground"
								strokeWidth={1.75}
								aria-hidden
							/>
							<p className="text-sm text-muted-foreground">
								No keys yet. Each app or tool gets its own, so you can revoke
								one without touching the rest.
							</p>
							<Button variant="outline" onClick={onCreate}>
								Create key
							</Button>
						</div>
					}
				/>
			)}
			<ConfirmDialog
				open={!!revoking}
				onOpenChange={(o) => !o && setRevoking(null)}
				title={`Revoke ${revoking?.name ?? "key"}?`}
				description="Apps using this key start getting 401 errors right away. This can't be undone."
				confirmLabel="Revoke key"
				pending={remove.isPending}
				onConfirm={() =>
					revoking &&
					remove.mutate(revoking.id, {
						onSuccess: () => {
							toast.success(`Revoked ${revoking.name}`);
							setRevoking(null);
						},
						onError: (e) =>
							toast.error("Couldn't revoke the key", {
								description: e.message,
							}),
					})
				}
			/>
		</Panel>
	);
}

function CreateKeyDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const create = useCreateGatewayKey();
	const [name, setName] = useState("");
	const [error, setError] = useState<string>();
	const [created, setCreated] = useState<CreatedAiGatewayKey | null>(null);

	const close = (o: boolean) => {
		onOpenChange(o);
		if (!o) {
			// Wait for the close animation before the secret leaves the DOM.
			setTimeout(() => {
				setCreated(null);
				setName("");
				setError(undefined);
			}, 200);
		}
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!name.trim())
			return setError("Name the key after the app that uses it.");
		create.mutate(name.trim(), {
			onSuccess: setCreated,
			onError: (err) => setError(err.message),
		});
	};

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-lg">
				{created ? (
					<>
						<DialogHeader>
							<DialogTitle>{created.name}</DialogTitle>
							<DialogDescription>
								Use it as the API key in any OpenAI or Anthropic client.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4">
							<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
								<TriangleAlert
									className="mt-0.5 size-4 shrink-0 text-warn-text"
									aria-hidden
								/>
								<p>
									<span className="font-medium">Copy the key now.</span>{" "}
									<span className="text-muted-foreground">
										LogiStack keeps only its hash. Lost it? Revoke it and create
										another.
									</span>
								</p>
							</div>
							<CopyLine value={created.key} label="gateway key" wrap />
						</div>
						<DialogFooter>
							<Button onClick={() => close(false)}>Done</Button>
						</DialogFooter>
					</>
				) : (
					<form onSubmit={submit} noValidate>
						<DialogHeader>
							<DialogTitle>Create a gateway key</DialogTitle>
							<DialogDescription>
								The key acts as you and spends from your monthly budget.
							</DialogDescription>
						</DialogHeader>
						<Field
							id="gateway-key-name"
							label="Name"
							hint="Where it's used, e.g. Cursor on my laptop."
							error={error}
							className="my-5"
						>
							<Input
								id="gateway-key-name"
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									setError(undefined);
								}}
								aria-invalid={!!error || undefined}
								aria-describedby="gateway-key-name-msg"
								autoComplete="off"
								maxLength={64}
								autoFocus
							/>
						</Field>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => close(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={create.isPending}>
								{create.isPending && <Loader2 className="animate-spin" />}
								Create key
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

type Snippet = "openai" | "compatible" | "anthropic" | "curl";

const SNIPPETS: Record<
	Snippet,
	{ label: string; code: (base: string) => string }
> = {
	openai: {
		label: "AI SDK",
		code: (base) => `import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const logistack = createOpenAI({
  baseURL: "${base}",
  apiKey: process.env.LOGISTACK_AI_KEY,
});

const { text } = await generateText({
  model: logistack.chat("auto"),
  prompt: "Summarize this deploy log.",
});`,
	},
	compatible: {
		label: "OpenAI-compatible",
		code: (
			base,
		) => `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

const logistack = createOpenAICompatible({
  name: "logistack",
  baseURL: "${base}",
  apiKey: process.env.LOGISTACK_AI_KEY,
});

const { text } = await generateText({
  model: logistack("groq/llama-3.3-70b-versatile"),
  prompt: "Write a commit message for this diff.",
});`,
	},
	anthropic: {
		label: "Anthropic",
		code: (base) => `import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

const logistack = createAnthropic({
  baseURL: "${base}",
  apiKey: process.env.LOGISTACK_AI_KEY,
});

const { text } = await generateText({
  model: logistack("claude-sonnet-4-5"),
  prompt: "Review this migration.",
});`,
	},
	curl: {
		label: "curl",
		code: (base) => `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $LOGISTACK_AI_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'`,
	},
};

function Snippets() {
	const [tab, setTab] = useState<Snippet>("openai");
	const code = SNIPPETS[tab].code(gatewayBaseUrl());
	return (
		<Panel title="Use it" id="snippets">
			<div className="flex items-center justify-between gap-2 border-b p-2 [&_button]:whitespace-nowrap">
				<div className="no-scrollbar min-w-0 overflow-x-auto">
					<Segmented
						label="Client"
						value={tab}
						onChange={setTab}
						options={(Object.keys(SNIPPETS) as Snippet[]).map((k) => ({
							value: k,
							label: SNIPPETS[k].label,
						}))}
					/>
				</div>
				<CopyButton value={code} label="snippet" />
			</div>
			<pre
				key={tab}
				className="t-reveal overflow-x-auto bg-muted/40 p-4 font-mono text-xs leading-5 dark:bg-muted/20"
			>
				<code>{code}</code>
			</pre>
		</Panel>
	);
}

const price = (n: number) =>
	n === 0 ? "$0" : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;

const modelCol = createColumnHelper<BaseFeatures, AiModel>();

function Models({ settings }: { settings: AiSettings }) {
	const { data: models } = useQuery(aiModelsQuery);
	const [tier, setTier] = useState<"all" | "free" | "paid">("all");
	const name = (id: string) =>
		settings.providers.find((p) => p.id === id)?.name ?? id;
	const rows = models
		?.filter((m) => tier === "all" || m.tier === tier)
		.sort((a, b) =>
			a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier === "free" ? -1 : 1,
		);
	const columns = modelCol.columns([
		modelCol.display({
			id: "model",
			header: "Model",
			cell: ({ row: { original: m } }) => (
				<div className="flex min-w-0 items-center gap-2">
					<div className="min-w-0">
						<span className="block truncate font-mono text-xs">{m.model}</span>
						<span className="block truncate text-xs text-muted-foreground">
							{name(m.provider)}
						</span>
					</div>
					<CopyButton
						value={m.id}
						label={`model id ${m.id}`}
						className="opacity-60 hover:opacity-100 max-sm:hidden"
					/>
				</div>
			),
		}),
		modelCol.display({
			id: "tier",
			header: "Tier",
			meta: { className: "w-20" },
			cell: ({ row: { original: m } }) => <TierBadge tier={m.tier} />,
		}),
		modelCol.display({
			id: "input",
			header: "Input / 1M",
			meta: { className: "w-28 text-right max-sm:hidden" },
			cell: ({ row: { original: m } }) => (
				<span className="tabular text-muted-foreground">
					{m.price ? price(m.price.input) : "–"}
				</span>
			),
		}),
		modelCol.display({
			id: "output",
			header: "Output / 1M",
			meta: { className: "w-28 text-right" },
			cell: ({ row: { original: m } }) => (
				<span className="tabular text-muted-foreground">
					{m.price ? price(m.price.output) : "–"}
				</span>
			),
		}),
	]);
	return (
		<Panel
			title={models ? `Models (${models.length})` : "Models"}
			id="models"
			actions={
				<Segmented
					label="Tier"
					value={tier}
					onChange={setTier}
					options={[
						{ value: "all", label: "All" },
						{ value: "free", label: "Free" },
						{ value: "paid", label: "Paid" },
					]}
				/>
			}
		>
			{!rows ? (
				<SkeletonRows rows={5} />
			) : (
				<div className="max-h-[28rem] overflow-y-auto">
					<DataTable
						label="Models"
						columns={columns}
						data={rows}
						getRowId={(m) => m.id}
						empty={
							<span className="text-sm text-muted-foreground">
								No models yet. An admin adds providers in the Providers tab.
							</span>
						}
					/>
				</div>
			)}
			<p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
				Prices in USD per million tokens. Free models list what the same model
				costs elsewhere; you pay nothing for them here.
			</p>
		</Panel>
	);
}
