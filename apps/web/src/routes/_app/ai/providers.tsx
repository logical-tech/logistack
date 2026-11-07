import { aiProvider } from "@logistack/core/ai-providers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowUp,
	Loader2,
	MoreHorizontal,
	RefreshCw,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AddProviderButton, useAiSettings } from "@/components/ai/ai-page";
import { formatAllowance, formatAllowances } from "@/components/ai/parts";
import { SignupLinks } from "@/components/ai/signup-links";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	type AiProviderDef,
	type AiProviderKey,
	type AiSettings,
	aiModelsQuery,
	aiProviderKeysQuery,
	useRemoveProviderKey,
	useTestProviderKey,
	useUpdateAiSettings,
	useUpdateProviderKey,
} from "@/lib/api/ai";
import { relativeTime } from "@/lib/format";
import type { StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/ai/providers")({
	staticData: { crumb: "Providers" },
	component: ProvidersPage,
});

const KEY_STATUS: Record<AiProviderKey["status"], StatusMeta> = {
	healthy: { label: "Healthy", tone: "ok" },
	unhealthy: { label: "Failing", tone: "bad" },
	unknown: { label: "Not tested", tone: "idle" },
};

function ProvidersPage() {
	return <Providers settings={useAiSettings()} />;
}

function Providers({ settings }: { settings: AiSettings }) {
	const { data: keys } = useQuery(aiProviderKeysQuery);
	const defs = new Map(settings.providers.map((p) => [p.id, p]));
	const tierOf = (k: AiProviderKey) => defs.get(k.provider)?.tier ?? "free";
	const connected = new Set(keys?.map((k) => k.provider));

	if (keys && keys.length === 0)
		return (
			<div className="grid gap-10">
				<EmptyState
					icon={Sparkles}
					title="Connect a model provider"
					description="Groq, Cerebras, Gemini, Mistral and OpenRouter have free tiers; a key takes a minute to create. Add OpenAI or Anthropic for paid models."
				>
					<AddProviderButton variant="outline" />
				</EmptyState>
				<SignupLinks settings={settings} connected={connected} />
			</div>
		);

	return (
		<div className="grid gap-10">
			{(["free", "paid"] as const).map((tier) => {
				const group = keys?.filter((k) => tierOf(k) === tier);
				return (
					<Panel
						key={tier}
						id={`keys-${tier}`}
						title={tier === "free" ? "Free providers" : "Paid providers"}
					>
						{!group ? (
							<SkeletonRows rows={3} />
						) : group.length === 0 ? (
							<p className="px-4 py-6 text-sm text-muted-foreground">
								{tier === "free"
									? "No free providers yet. They carry the auto chain at no cost."
									: "No paid providers. Add OpenAI or Anthropic when free models aren't enough; spend counts against each member's paid budget."}
							</p>
						) : (
							<ul className="divide-y">
								{group.map((k) => (
									<KeyRow key={k.id} k={k} def={defs.get(k.provider)} />
								))}
							</ul>
						)}
					</Panel>
				);
			})}
			<AutoChain settings={settings} />
			{keys && <SignupLinks settings={settings} connected={connected} />}
		</div>
	);
}

function KeyRow({ k, def }: { k: AiProviderKey; def?: AiProviderDef }) {
	const update = useUpdateProviderKey();
	const test = useTestProviderKey();
	const remove = useRemoveProviderKey();
	const [deleting, setDeleting] = useState(false);
	const meta = KEY_STATUS[k.status];
	/** The published free tier; paid providers have none to show. */
	const allowance =
		def?.tier === "free" && !def.customBaseUrl
			? (aiProvider(k.provider)?.freeQuota?.limits ?? [])
			: null;

	const runTest = () =>
		test.mutate(k.id, {
			onSuccess: (r) =>
				r.status === "healthy"
					? toast.success(`${k.label} works`, {
							description: `${r.models.length} models available.`,
						})
					: toast.error(`${k.label} failed the test`, {
							description: r.lastError ?? "The provider didn't answer.",
						}),
			onError: (e) =>
				toast.error("Couldn't run the test", { description: e.message }),
		});

	return (
		<li
			className={cn(
				"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_9rem_10rem_auto]",
			)}
		>
			<div className={cn("min-w-0", !k.enabled && "opacity-60")}>
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm">{k.label}</span>
					{def?.name !== k.label && (
						<span className="truncate text-xs text-muted-foreground">
							{def?.name ?? k.provider}
						</span>
					)}
				</span>
				{k.lastError ? (
					<span
						className="mt-0.5 block truncate text-xs text-bad-text"
						title={k.lastError}
					>
						{k.lastError}
					</span>
				) : k.baseUrl ? (
					<span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
						{k.baseUrl}
					</span>
				) : null}
			</div>
			<div className="max-sm:hidden">
				<span className="inline-flex items-center gap-2 text-sm whitespace-nowrap">
					{test.isPending ? (
						<Loader2
							className="size-3 animate-spin text-muted-foreground"
							aria-hidden
						/>
					) : (
						<StatusDot meta={meta} />
					)}
					{test.isPending ? "Testing…" : meta.label}
				</span>
				<span className="block text-xs text-muted-foreground tabular">
					{k.lastCheckedAt
						? `Checked ${relativeTime(k.lastCheckedAt)}`
						: "Never checked"}
				</span>
			</div>
			<div className="min-w-0 max-sm:hidden">
				<span className="block text-sm text-muted-foreground tabular">
					{k.models.length} {k.models.length === 1 ? "model" : "models"}
				</span>
				{allowance && (
					<span
						className="block truncate text-xs text-muted-foreground tabular"
						title={`Free tier: ${formatAllowances(allowance)}`}
					>
						{allowance[0] ? formatAllowance(allowance[0], true) : "Unpublished"}
					</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				<Switch
					checked={k.enabled}
					disabled={update.isPending}
					aria-label={`${k.enabled ? "Disable" : "Enable"} ${k.label}`}
					onCheckedChange={(enabled) =>
						update.mutate(
							{ id: k.id, input: { enabled } },
							{
								onError: (e) =>
									toast.error(`Couldn't update ${k.label}`, {
										description: e.message,
									}),
							},
						)
					}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Actions for ${k.label}`}
						>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={runTest} disabled={test.isPending}>
							<RefreshCw /> Test and refresh models
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={() => setDeleting(true)}
						>
							<Trash2 /> Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${k.label}?`}
				description="The gateway stops routing to this key right away. Models only it served drop out of the auto chain."
				confirmLabel="Delete key"
				pending={remove.isPending}
				onConfirm={() =>
					remove.mutate(k.id, {
						onSuccess: () => {
							setDeleting(false);
							toast.success(`Deleted ${k.label}`);
						},
						onError: (e) =>
							toast.error("Couldn't delete the key", {
								description: e.message,
							}),
					})
				}
			/>
		</li>
	);
}

/** The ordered free models `auto` tries; the first that answers wins. */
function AutoChain({ settings }: { settings: AiSettings }) {
	const { data: models } = useQuery(aiModelsQuery);
	const save = useUpdateAiSettings();
	const [chain, setChain] = useState(settings.autoChain);
	useEffect(() => setChain(settings.autoChain), [settings.autoChain]);
	const dirty = chain.join("\n") !== settings.autoChain.join("\n");
	const known = new Set(models?.map((m) => m.id));
	const free =
		models?.filter((m) => m.tier === "free" && !chain.includes(m.id)) ?? [];
	const byProvider = new Map<string, typeof free>();
	for (const m of free)
		byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
	const name = (id: string) =>
		settings.providers.find((p) => p.id === id)?.name ?? id;

	const move = (i: number, d: -1 | 1) =>
		setChain((c) => {
			const next = [...c];
			[next[i], next[i + d]] = [next[i + d] as string, next[i] as string];
			return next;
		});

	return (
		<Panel
			title="Auto chain"
			id="auto-chain"
			actions={
				dirty && (
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setChain(settings.autoChain)}
						>
							Discard
						</Button>
						<Button
							size="sm"
							disabled={save.isPending}
							onClick={() =>
								save.mutate(
									{ autoChain: chain },
									{
										onSuccess: () => toast.success("Auto chain saved"),
										onError: (e) =>
											toast.error("Couldn't save the chain", {
												description: e.message,
											}),
									},
								)
							}
						>
							{save.isPending && <Loader2 className="animate-spin" />}
							Save order
						</Button>
					</div>
				)
			}
		>
			<div className="grid gap-4 p-4">
				<p className="max-w-[70ch] text-sm text-pretty text-muted-foreground">
					Requests for the model{" "}
					<code className="font-mono text-xs text-foreground">auto</code> try
					these free models in order and fall through on rate limits or errors.
					Empty, the gateway uses each healthy provider's default model.
				</p>
				{chain.length > 0 && (
					<ol className="divide-y overflow-hidden rounded-lg ring-1 ring-border">
						{chain.map((id, i) => {
							const [provider, ...rest] = id.split("/");
							const missing = models && !known.has(id);
							return (
								<li
									key={id}
									className="flex h-11 items-center gap-3 bg-card pr-1.5 pl-3"
								>
									<span className="w-5 text-right text-xs text-muted-foreground tabular">
										{i + 1}
									</span>
									<span className="min-w-0 flex-1 truncate text-sm">
										<span className="font-medium">{rest.join("/")}</span>{" "}
										<span className="text-muted-foreground">
											{name(provider ?? "")}
										</span>
									</span>
									{missing && (
										<span className="shrink-0 text-xs text-warn-text">
											No healthy key serves it
										</span>
									)}
									<div className="flex shrink-0 items-center">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Move ${id} up`}
											disabled={i === 0}
											onClick={() => move(i, -1)}
										>
											<ArrowUp />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Move ${id} down`}
											disabled={i === chain.length - 1}
											onClick={() => move(i, 1)}
										>
											<ArrowDown />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Remove ${id}`}
											onClick={() => setChain((c) => c.filter((x) => x !== id))}
										>
											<X />
										</Button>
									</div>
								</li>
							);
						})}
					</ol>
				)}
				<Select
					value=""
					onValueChange={(id) => setChain((c) => [...c, id])}
					disabled={!models || free.length === 0}
				>
					<SelectTrigger
						className="w-full sm:w-80"
						aria-label="Add a model to the chain"
					>
						<SelectValue
							placeholder={
								!models
									? "Loading models…"
									: free.length === 0
										? "Every free model is in the chain"
										: "Add a free model…"
							}
						/>
					</SelectTrigger>
					<SelectContent>
						{[...byProvider].map(([provider, list]) => (
							<SelectGroup key={provider}>
								<SelectLabel>{name(provider)}</SelectLabel>
								{list.map((m) => (
									<SelectItem key={m.id} value={m.id}>
										{m.model}
									</SelectItem>
								))}
							</SelectGroup>
						))}
					</SelectContent>
				</Select>
			</div>
		</Panel>
	);
}
