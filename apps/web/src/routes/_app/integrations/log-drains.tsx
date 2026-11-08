import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	Plus,
	ScrollText,
	Send,
	SlidersHorizontal,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import {
	type DrainScope,
	DrainScopePicker,
	scopeSummary,
} from "@/components/integrations/drain-scope";
import {
	ConfirmDelete,
	DataChip,
	KindTile,
} from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
	type LogDrain,
	logDrainsApi,
	logDrainsQuery,
} from "@/lib/api/log-drains";
import { useInvalidating } from "@/lib/api/networking";
import { relativeTime } from "@/lib/format";
import { DRAIN_KINDS } from "@/lib/integrations";
import type { StatusMeta } from "@/lib/status";

export const Route = createFileRoute("/_app/integrations/log-drains")({
	staticData: { crumb: "Log drains" },
	component: LogDrainsPage,
});

const HEALTH: Record<LogDrain["health"], StatusMeta> = {
	healthy: { label: "Delivering", tone: "ok" },
	degraded: { label: "Degraded", tone: "warn" },
	failing: { label: "Failing", tone: "bad" },
	unknown: { label: "No logs yet", tone: "idle" },
};
const PAUSED: StatusMeta = { label: "Paused", tone: "idle" };

/** The most useful line under the name: the newest node error, else what it ships. */
function detail(d: LogDrain): { text: string; bad: boolean } {
	const failing = d.nodes
		.filter((n) => n.state === "failing")
		.sort((a, b) => (b.lastFailureAt ?? 0) - (a.lastFailureAt ?? 0))[0];
	if (d.enabled && failing)
		return {
			text: `${failing.hostname}: ${failing.lastError ?? "failing"}`,
			bad: true,
		};
	const dropped = d.nodes.reduce((n, x) => n + x.droppedLines, 0);
	return {
		text: `${scopeSummary(d)}${dropped ? ` · ${dropped.toLocaleString()} lines dropped` : ""} · added ${relativeTime(d.createdAt)}`,
		bad: false,
	};
}

function DrainRow({
	d,
	onScope,
	onDelete,
}: {
	d: LogDrain;
	onScope: () => void;
	onDelete: () => void;
}) {
	const kind = DRAIN_KINDS[d.kind];
	const update = useInvalidating(logDrainsApi.update, [["log-drains"]]);
	const [testing, setTesting] = useState(false);
	const line = detail(d);
	async function sendTest() {
		setTesting(true);
		try {
			const r = await logDrainsApi.test(d.id);
			if (r.ok)
				toast.success("Test event delivered", { description: d.target });
			else
				toast.error(
					r.status ? `${d.target} answered ${r.status}` : "Test event failed",
					{ description: r.error },
				);
		} catch (err) {
			toast.error("Test event failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setTesting(false);
		}
	}
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="flex min-w-40 flex-1 items-center gap-3">
				<KindTile icon={kind.icon} />
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{d.name}</p>
					<p
						className={
							line.bad
								? "truncate text-xs text-bad-text"
								: "truncate text-xs text-muted-foreground tabular"
						}
						title={line.text}
					>
						{line.text}
					</p>
				</div>
			</div>
			<div className="flex min-w-0 shrink sm:max-w-[40%]" title={d.target}>
				<DataChip>{d.target}</DataChip>
			</div>
			<div className="flex items-center justify-between gap-3 sm:shrink-0 sm:justify-end">
				<StatusLabel meta={d.enabled ? HEALTH[d.health] : PAUSED} />
				<Switch
					checked={d.enabled}
					aria-label={d.enabled ? `Pause ${d.name}` : `Resume ${d.name}`}
					disabled={update.isPending}
					onCheckedChange={(enabled) =>
						update.mutate(
							{ id: d.id, enabled },
							{
								onSuccess: () =>
									toast.success(
										enabled ? `${d.name} resumed` : `${d.name} paused`,
									),
							},
						)
					}
				/>
				<div className="flex items-center">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Send a test event to ${d.name}`}
						disabled={testing}
						onClick={sendTest}
					>
						<Send />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Choose which logs ${d.name} receives`}
						onClick={onScope}
					>
						<SlidersHorizontal />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Delete ${d.name}`}
						onClick={onDelete}
					>
						<Trash2 />
					</Button>
				</div>
			</div>
		</li>
	);
}

function ScopeDialog({
	drain,
	onOpenChange,
}: {
	drain: LogDrain | null;
	onOpenChange: (open: boolean) => void;
}) {
	const [scope, setScope] = useState<DrainScope | null>(null);
	const update = useInvalidating(logDrainsApi.update, [["log-drains"]]);
	const value = scope ?? {
		projectIds: drain?.projectIds ?? [],
		serviceIds: drain?.serviceIds ?? [],
	};
	const close = (open: boolean) => {
		if (!open) setScope(null);
		onOpenChange(open);
	};
	return (
		<Dialog open={drain !== null} onOpenChange={close}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Logs for {drain?.name}</DialogTitle>
					<DialogDescription>
						A whole project includes services added to it later.
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-[60vh] overflow-y-auto">
					<DrainScopePicker value={value} onChange={setScope} />
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button
						disabled={update.isPending || scope === null}
						onClick={async () => {
							if (!drain) return;
							await update.mutateAsync({ id: drain.id, ...value });
							toast.success(
								`${drain.name} now receives ${scopeSummary(value).toLowerCase()}`,
							);
							close(false);
						}}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function LogDrainsPage() {
	const { data, isPending } = useQuery(logDrainsQuery);
	const [deleting, setDeleting] = useState<LogDrain | null>(null);
	const [scoping, setScoping] = useState<LogDrain | null>(null);
	const remove = useInvalidating(logDrainsApi.remove, [["log-drains"]]);
	const add = (
		<Button asChild>
			<Link to="/integrations/log-drains/new">
				<Plus data-icon="inline-start" />
				Add drain
			</Link>
		</Button>
	);
	return (
		<Page>
			<PageHeader
				title="Log drains"
				description="Ship service logs to Loki, an OpenTelemetry collector, Datadog, syslog or any HTTP endpoint. Each node sends its own containers' logs."
				actions={data?.length ? add : undefined}
			/>
			{isPending ? (
				<Panel title="Drains" id="drains">
					<SkeletonRows rows={2} />
				</Panel>
			) : !data?.length ? (
				<EmptyState
					icon={ScrollText}
					title="Logs stay on the servers"
					description="Add a drain to keep service logs past container restarts and search them next to your metrics and traces."
				>
					{add}
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<Panel title="Drains" id="drains">
						<ul className="divide-y">
							{data.map((d) => (
								<DrainRow
									key={d.id}
									d={d}
									onScope={() => setScoping(d)}
									onDelete={() => setDeleting(d)}
								/>
							))}
						</ul>
					</Panel>
					<p className="max-w-[70ch] text-sm text-muted-foreground">
						Each node buffers up to 8 MB per drain. While a destination is down,
						the oldest lines are dropped first and the count shows here;
						containers never wait for a drain.
					</p>
				</div>
			)}
			<ScopeDialog
				drain={scoping}
				onOpenChange={(o) => !o && setScoping(null)}
			/>
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "drain"}?`}
				description="Nodes stop shipping to it within seconds. Logs already delivered stay at the destination."
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.id);
					toast.success(`${deleting.name} deleted`);
				}}
			/>
		</Page>
	);
}
