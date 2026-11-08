import type { PluginPolicy } from "@logistack/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Puzzle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { DataChip, KindTile } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { shortDigest } from "@/components/plugins/manifest-summary";
import { UnlistedBadge } from "@/components/plugins/plugin-icon";
import { useTogglePlugin } from "@/components/plugins/use-toggle-plugin";
import { Segmented } from "@/components/segmented";
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
			"Only plugins a maintainer reviewed in the marketplace. Images and dev URLs are refused.",
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
						<UnlistedBadge />
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
	const { data: policy } = useQuery(pluginPolicyQuery);
	const qc = useQueryClient();
	const [saving, setSaving] = useState(false);
	if (!policy) return null;
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
					onChange={async (next) => {
						setSaving(true);
						try {
							qc.setQueryData(
								pluginPolicyQuery.queryKey,
								await pluginsApi.setPolicy(next),
							);
							toast.success(`Plugin policy: ${POLICY[next].label}`);
						} catch (err) {
							toast.error("Couldn't change the policy", {
								description: err instanceof Error ? err.message : String(err),
							});
						} finally {
							setSaving(false);
						}
					}}
					options={(Object.keys(POLICY) as PluginPolicy[]).map((v) => ({
						value: v,
						label: POLICY[v].label,
					}))}
				/>
			</div>
		</Panel>
	);
}

function PluginsPage() {
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
			<div className="grid gap-8">
				{isPending ? (
					<Panel title="Installed" id="installed">
						<SkeletonRows rows={2} />
					</Panel>
				) : !data?.length ? (
					<EmptyState
						icon={Puzzle}
						title="No plugins installed"
						description="Install one from a container image, or point at a plugin you're developing with a dev URL."
					>
						{add}
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
