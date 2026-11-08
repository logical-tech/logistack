import type { PluginPolicy } from "@logistack/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus, Puzzle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { DataChip, KindTile } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { shortDigest } from "@/components/plugins/manifest-summary";
import { IndexesPanel, Marketplace } from "@/components/plugins/marketplace";
import { SourceBadge } from "@/components/plugins/plugin-icon";
import { useTogglePlugin } from "@/components/plugins/use-toggle-plugin";
import { Segmented } from "@/components/segmented";
import { SlidingTabs } from "@/components/sliding-tabs";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useMe } from "@/lib/api/access";
import {
	type PluginInstall,
	pluginPolicyQuery,
	pluginsApi,
	pluginsQuery,
} from "@/lib/api/plugins";
import { PLUGIN_STATUS } from "@/lib/status";

export const Route = createFileRoute("/_app/settings/plugins")({
	staticData: { crumb: "Plugins" },
	validateSearch: z.object({
		tab: z.enum(["installed", "marketplace"]).optional().catch(undefined),
	}),
	component: PluginsPage,
});

const POLICY: Record<PluginPolicy, { label: string; detail: string }> = {
	off: {
		label: "Off",
		detail:
			"Nobody can install plugins. Installed ones keep running until someone turns them off.",
	},
	verified: {
		label: "Verified only",
		detail:
			"Only versions a maintainer reviewed on a trusted index. Images, dev URLs and unverified entries are refused.",
	},
	any: {
		label: "Any image",
		detail:
			"Members with the Plugins permission can install from any image or dev URL.",
	},
};

function PluginRow({
	p,
	onToggle,
	busy,
}: {
	p: PluginInstall;
	onToggle: (enabled: boolean) => void;
	busy: boolean;
}) {
	const author = p.manifest.author?.name;
	return (
		<li className="relative flex flex-col gap-3 px-4 py-3.5 transition-colors duration-(--duration-quick) has-[a:hover]:bg-muted/40 sm:flex-row sm:items-center">
			<div className="flex min-w-40 flex-1 items-center gap-3">
				<KindTile icon={Puzzle} />
				<div className="min-w-0">
					<p className="flex items-center gap-2 text-sm font-medium">
						<Link
							to="/settings/plugins/$installId"
							params={{ installId: p.id }}
							className="truncate rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring"
						>
							{p.name}
						</Link>
						<SourceBadge indexId={p.indexId} verified={p.verified} />
						{p.yanked && (
							<span
								className="inline-flex items-center gap-1 text-2xs font-medium text-warn-text"
								title="The index withdrew this version. It keeps running; update or roll back."
							>
								<TriangleAlert className="size-3" aria-hidden />
								Yanked
							</span>
						)}
					</p>
					<p
						className={
							p.status === "error" && p.statusMessage
								? "truncate text-xs text-bad-text"
								: "truncate text-xs text-muted-foreground"
						}
					>
						{p.status === "error" && p.statusMessage
							? p.statusMessage
							: `${author ? `${author} · ` : ""}v${p.version}`}
					</p>
				</div>
			</div>
			<div
				className="flex min-w-0 shrink sm:max-w-[34%]"
				title={p.image ?? p.devUrl ?? undefined}
			>
				<DataChip>{p.image ? shortDigest(p.image) : "Dev URL"}</DataChip>
			</div>
			<div className="relative flex items-center justify-between gap-4 sm:w-44 sm:shrink-0 sm:justify-end">
				<StatusLabel meta={PLUGIN_STATUS[p.enabled ? p.status : "disabled"]} />
				<Switch
					checked={p.enabled}
					aria-label={p.enabled ? `Turn off ${p.name}` : `Turn on ${p.name}`}
					disabled={busy}
					onCheckedChange={onToggle}
				/>
			</div>
		</li>
	);
}

function PolicyPanel() {
	const { data } = useQuery(pluginPolicyQuery);
	const qc = useQueryClient();
	const [saving, setSaving] = useState(false);
	if (!data) return null;
	const { policy } = data;
	const save = async (
		patch: Parameters<typeof pluginsApi.setPolicy>[0],
		done: string,
	) => {
		setSaving(true);
		try {
			qc.setQueryData(
				pluginPolicyQuery.queryKey,
				await pluginsApi.setPolicy(patch),
			);
			await qc.invalidateQueries({ queryKey: ["plugins", "marketplace"] });
			toast.success(done);
		} catch (err) {
			toast.error("Couldn't change the setting", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setSaving(false);
		}
	};
	return (
		<Panel title="Instance policy" id="policy">
			<div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
				<p className="max-w-[56ch] text-sm text-muted-foreground">
					{POLICY[policy].detail} Applies to every organization on this
					instance.
				</p>
				<Segmented
					label="Who may install plugins"
					value={policy}
					disabled={saving}
					onChange={(next) =>
						save({ policy: next }, `Plugin policy: ${POLICY[next].label}`)
					}
					options={(Object.keys(POLICY) as PluginPolicy[]).map((v) => ({
						value: v,
						label: POLICY[v].label,
					}))}
				/>
			</div>
			<div className="flex items-center justify-between gap-4 border-t px-4 py-3">
				<div>
					<p id="install-ping" className="text-sm font-medium">
						Count installs on the index
					</p>
					<p className="max-w-[56ch] text-sm text-muted-foreground">
						Each marketplace install sends its index the plugin id and a random
						install id, nothing about this instance. Off by default.
					</p>
				</div>
				<Switch
					checked={data.installPing}
					aria-labelledby="install-ping"
					disabled={saving}
					onCheckedChange={(on) =>
						save(
							{ installPing: on },
							on ? "Installs are counted" : "Installs are not counted",
						)
					}
				/>
			</div>
		</Panel>
	);
}

function PluginsPage() {
	const { tab = "installed" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data, isPending } = useQuery(pluginsQuery);
	const { data: me } = useMe();
	const { toggle, dialog, busy } = useTogglePlugin();
	const add = (
		<Button asChild>
			<Link to="/settings/plugins/new">
				<Plus data-icon="inline-start" />
				Install plugin
			</Link>
		</Button>
	);
	return (
		<Page>
			<PageHeader
				title="Plugins"
				description="Add pages, events, agent tools and providers to LogiStack. Each plugin runs in its own container with only the permissions you approve."
				actions={data?.length ? add : undefined}
			/>
			<div className="mb-5 border-b">
				<SlidingTabs
					label="Plugins"
					idPrefix="plugins"
					value={tab}
					onChange={(id) =>
						navigate({
							search: { tab: id === "installed" ? undefined : id },
							replace: true,
						})
					}
					items={[
						{ id: "installed", label: "Installed" },
						{ id: "marketplace", label: "Marketplace" },
					]}
				/>
			</div>
			<div
				id="plugins-panel"
				role="tabpanel"
				aria-labelledby={`plugins-tab-${tab}`}
				className="grid gap-8"
			>
				{tab === "marketplace" ? (
					<>
						<Marketplace />
						{me?.instanceAdmin && <IndexesPanel />}
					</>
				) : isPending ? (
					<Panel title="Installed" id="installed">
						<SkeletonRows rows={2} />
					</Panel>
				) : !data?.length ? (
					<EmptyState
						icon={Puzzle}
						title="No plugins installed"
						description="Browse the marketplace, install from a container image, or point at a plugin you're developing with a dev URL."
					>
						<div className="flex flex-wrap justify-center gap-2">
							<Button
								variant="outline"
								onClick={() =>
									navigate({ search: { tab: "marketplace" }, replace: true })
								}
							>
								Browse marketplace
							</Button>
							{add}
						</div>
					</EmptyState>
				) : (
					<Panel title="Installed" id="installed">
						<ul className="divide-y">
							{data.map((p) => (
								<PluginRow
									key={p.id}
									p={p}
									busy={busy}
									onToggle={(on) => toggle(p, on)}
								/>
							))}
						</ul>
					</Panel>
				)}
				{me?.instanceAdmin && <PolicyPanel />}
			</div>
			{dialog}
		</Page>
	);
}
