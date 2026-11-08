import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	Loader2,
	Plus,
	Puzzle,
	RefreshCw,
	Search,
	Store,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { DataChip, KindTile } from "@/components/integrations/parts";
import { Panel, SkeletonRows } from "@/components/panel";
import { SourceBadge } from "@/components/plugins/plugin-icon";
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
import { Textarea } from "@/components/ui/textarea";
import { useInvalidating } from "@/lib/api/networking";
import {
	type PluginIndex,
	type PluginMarketEntry,
	pluginMarketplaceQuery,
	pluginsApi,
} from "@/lib/api/plugins";
import { relativeTime } from "@/lib/format";

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/** Why an entry cannot be installed here, or null when it can. */
function blocked(e: PluginMarketEntry, policy: string): string | null {
	if (policy === "off") return "Plugins are turned off on this instance";
	if (policy === "verified" && !e.verified)
		return e.latestVerified
			? `This instance installs verified versions only; ${e.latestVerified} is the newest`
			: "This instance installs verified plugins only";
	if (!e.compatible)
		return `Needs LogiStack ${e.latest.manifest.logistack ?? ""}`.trim();
	return null;
}

function EntryRow({ e, policy }: { e: PluginMarketEntry; policy: string }) {
	const reason = blocked(e, policy);
	const installed = e.installed;
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-start gap-3">
				{e.iconUrl ? (
					<img
						src={e.iconUrl}
						alt=""
						className="size-8 shrink-0 rounded-md outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
					/>
				) : (
					<KindTile icon={Puzzle} />
				)}
				<div className="min-w-0">
					<p className="flex flex-wrap items-center gap-2 text-sm font-medium">
						<span className="truncate">{e.name}</span>
						<SourceBadge indexId={e.indexId} verified={e.verified} />
					</p>
					{e.description && (
						<p className="mt-0.5 line-clamp-2 text-sm text-pretty text-muted-foreground">
							{e.description}
						</p>
					)}
					<p className="mt-1 text-xs text-muted-foreground">
						{e.publisher} · v{e.latest.version} · {e.indexName}
						{e.installs > 0 && (
							<span className="tabular-nums"> · {e.installs} installs</span>
						)}
					</p>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-3 sm:justify-end">
				{installed ? (
					<Button asChild variant="outline" size="sm">
						<Link
							to="/settings/plugins/$installId"
							params={{ installId: installed.installId }}
						>
							{installed.indexId === e.indexId &&
							installed.version !== e.latest.version
								? `Update from ${installed.version}`
								: "Installed"}
						</Link>
					</Button>
				) : reason ? (
					<span className="max-w-56 text-right text-xs text-muted-foreground">
						{reason}
					</span>
				) : (
					<Button asChild size="sm">
						<Link
							to="/settings/plugins/new"
							search={{
								index: e.indexId,
								plugin: e.id,
								version: e.latest.version,
							}}
						>
							Install
						</Link>
					</Button>
				)}
			</div>
		</li>
	);
}

/** Search and install across every trusted index. Opening it refreshes indexes older than an hour. */
export function Marketplace() {
	const { data, isPending, isError, error } = useQuery(pluginMarketplaceQuery);
	const [q, setQ] = useState("");
	const qc = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);
	const shown = useMemo(() => {
		const needle = q.trim().toLowerCase();
		const all = data?.entries ?? [];
		if (!needle) return all;
		return all.filter((e) =>
			[e.name, e.description, e.id, e.publisher, e.author ?? ""].some((s) =>
				s.toLowerCase().includes(needle),
			),
		);
	}, [data, q]);
	const failing = (data?.indexes ?? []).filter((i) => i.lastError);

	const refreshAll = async () => {
		setRefreshing(true);
		const results = await Promise.allSettled(
			(data?.indexes ?? []).map((i) => pluginsApi.refreshIndex(i.id)),
		);
		await qc.invalidateQueries({ queryKey: ["plugins"] });
		setRefreshing(false);
		const failed = results.filter((r) => r.status === "rejected").length;
		if (failed)
			toast.error(
				failed === results.length
					? "Couldn't refresh the indexes"
					: `${failed} of ${results.length} indexes didn't refresh`,
			);
		else toast.success("Marketplace refreshed");
	};

	return (
		<div className="grid gap-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="relative max-w-md flex-1">
					<Search
						className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden
					/>
					<Input
						type="search"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search plugins"
						aria-label="Search plugins"
						className="pl-8"
					/>
				</div>
				<Button
					variant="outline"
					disabled={refreshing || !data}
					onClick={refreshAll}
					className="sm:ml-auto"
				>
					<RefreshCw className={refreshing ? "animate-spin" : undefined} />
					Refresh
				</Button>
			</div>
			{failing.length > 0 && (
				<div
					role="status"
					className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm"
				>
					<TriangleAlert
						className="mt-0.5 size-4 shrink-0 text-warn-text"
						aria-hidden
					/>
					<div className="grid gap-1">
						{failing.map((i) => (
							<p key={i.id}>
								<span className="font-medium">{i.name}:</span>{" "}
								<span className="text-muted-foreground">{i.lastError}</span>
							</p>
						))}
					</div>
				</div>
			)}
			{isPending ? (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					<SkeletonRows rows={3} />
				</div>
			) : isError ? (
				<p className="text-sm text-bad-text">{errorText(error)}</p>
			) : !shown.length ? (
				<EmptyState
					icon={Store}
					title={q ? "No plugins match" : "Nothing listed yet"}
					description={
						q
							? "Try another name, publisher or plugin id."
							: "The trusted indexes list no plugins. An instance admin can add a private index below."
					}
				/>
			) : (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					<ul className="divide-y">
						{shown.map((e) => (
							<EntryRow
								key={`${e.indexId}:${e.id}`}
								e={e}
								policy={data?.policy ?? "any"}
							/>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function AddIndexDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [keys, setKeys] = useState("");
	const [error, setError] = useState<string | null>(null);
	const add = useInvalidating(pluginsApi.addIndex, [["plugins"]]);
	const publicKeys = keys
		.split(/[\s,]+/)
		.map((k) => k.trim())
		.filter(Boolean);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (o) {
					setUrl("");
					setName("");
					setKeys("");
					setError(null);
				}
				onOpenChange(o);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<form
					className="grid gap-5"
					onSubmit={async (e) => {
						e.preventDefault();
						setError(null);
						try {
							const row = await add.mutateAsync({
								url: url.trim(),
								...(name.trim() && { name: name.trim() }),
								publicKeys,
							});
							toast.success(`${row.name} added`, {
								description: `${row.plugins} plugins listed.`,
							});
							onOpenChange(false);
						} catch (err) {
							setError(errorText(err));
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Add a private index</DialogTitle>
						<DialogDescription>
							An index that serves the same signed format as the official one,
							such as a company's internal marketplace. LogiStack fetches it
							once now and checks the signature before saving.
						</DialogDescription>
					</DialogHeader>
					<Field id="index-url" label="URL" error={error ?? undefined}>
						<Input
							id="index-url"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="https://plugins.example.com/api"
							className="font-mono"
							autoCapitalize="none"
							spellCheck={false}
							required
							aria-describedby="index-url-msg"
						/>
					</Field>
					<Field
						id="index-name"
						label="Name"
						optional
						hint="Defaults to the host."
					>
						<Input
							id="index-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Acme internal"
						/>
					</Field>
					<Field
						id="index-keys"
						label="Public keys"
						hint="Base64url raw Ed25519 keys, one per line. Add the next key before the index rotates to it."
					>
						<Textarea
							id="index-keys"
							value={keys}
							onChange={(e) => setKeys(e.target.value)}
							className="font-mono text-xs"
							spellCheck={false}
							rows={2}
						/>
					</Field>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={add.isPending || !url.trim() || !publicKeys.length}
						>
							{add.isPending && <Loader2 className="animate-spin" />}
							Check and add
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function IndexRow({ i }: { i: PluginIndex }) {
	const [confirm, setConfirm] = useState(false);
	const refresh = useInvalidating(pluginsApi.refreshIndex, [["plugins"]]);
	const remove = useInvalidating(pluginsApi.removeIndex, [["plugins"]]);
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-2 text-sm font-medium">
					{i.name}
					{i.builtin && (
						<span className="rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
							Official
						</span>
					)}
				</p>
				<p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
					{i.url}
				</p>
				<p
					className={
						i.lastError
							? "mt-1 text-xs text-bad-text"
							: "mt-1 text-xs text-muted-foreground"
					}
				>
					{i.lastError ??
						(i.fetchedAt
							? `${i.plugins} plugins · fetched ${relativeTime(i.fetchedAt)}`
							: "Not fetched yet")}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<span title={i.publicKeys.join("\n") || undefined}>
					<DataChip>
						{i.publicKeys.length === 1
							? "1 key"
							: `${i.publicKeys.length} keys`}
					</DataChip>
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={refresh.isPending}
					onClick={async () => {
						try {
							await refresh.mutateAsync(i.id);
							toast.success(`${i.name} refreshed`);
						} catch (err) {
							toast.error(`Couldn't refresh ${i.name}`, {
								description: errorText(err),
							});
						}
					}}
				>
					<RefreshCw
						className={refresh.isPending ? "animate-spin" : undefined}
					/>
					Refresh
				</Button>
				{!i.builtin && (
					<Button
						variant="ghost"
						size="sm"
						className="text-bad-text hover:text-bad-text"
						aria-label={`Remove ${i.name}`}
						onClick={() => setConfirm(true)}
					>
						<Trash2 />
					</Button>
				)}
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title={`Stop trusting ${i.name}?`}
				description="Its plugins disappear from the marketplace. Plugins already installed from it keep running and show as Unlisted."
				confirmLabel="Remove index"
				pending={remove.isPending}
				onConfirm={async () => {
					try {
						await remove.mutateAsync(i.id);
						toast.success(`${i.name} removed`);
						setConfirm(false);
					} catch (err) {
						toast.error(`Couldn't remove ${i.name}`, {
							description: errorText(err),
						});
					}
				}}
			/>
		</li>
	);
}

/** Instance admins: the indexes this instance trusts. */
export function IndexesPanel() {
	const { data } = useQuery(pluginMarketplaceQuery);
	const [adding, setAdding] = useState(false);
	return (
		<Panel
			title="Indexes"
			id="indexes"
			actions={
				<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
					<Plus data-icon="inline-start" />
					Add index
				</Button>
			}
		>
			{!data ? (
				<SkeletonRows rows={2} />
			) : (
				<ul className="divide-y">
					{data.indexes.map((i) => (
						<IndexRow key={i.id} i={i} />
					))}
				</ul>
			)}
			<AddIndexDialog open={adding} onOpenChange={setAdding} />
		</Panel>
	);
}
