import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Bell, Loader2, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDelete, KindTile } from "@/components/integrations/parts";
import { RuleEditor } from "@/components/integrations/rule-editor";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import {
	type Channel,
	channelsQuery,
	type Rule,
	type RuleInput,
	rulesQuery,
	useInvalidating,
} from "@/lib/api/networking";
import { projectsQuery } from "@/lib/api/projects";
import type { ProjectSummary } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { CHANNEL_KINDS, eventLabel } from "@/lib/integrations";
import { section } from "@/lib/nav";
import type { StatusMeta } from "@/lib/status";

export const Route = createFileRoute("/_app/integrations/notifications")({
	staticData: { crumb: "Notifications" },
	validateSearch: z.object({ rule: z.string().optional() }),
	component: NotificationsPage,
});

function delivery(c: Channel): { meta: StatusMeta; detail: string | null } {
	const d = c.delivery;
	if (!d || (!d.lastSuccessAt && !d.lastFailureAt))
		return { meta: { label: "No deliveries yet", tone: "idle" }, detail: null };
	if (d.consecutiveFailures > 0)
		return {
			meta: {
				label:
					d.consecutiveFailures === 1
						? "Last delivery failed"
						: `Failing, ${d.consecutiveFailures} in a row`,
				tone: "bad",
			},
			detail: d.lastError,
		};
	return {
		meta: { label: "Delivering", tone: "ok" },
		detail: d.lastSuccessAt
			? `Last sent ${relativeTime(d.lastSuccessAt)}`
			: null,
	};
}

function ChannelRow({ c, onDelete }: { c: Channel; onDelete: () => void }) {
	const kind = CHANNEL_KINDS[c.kind];
	const [sending, setSending] = useState(false);
	const status = delivery(c);
	return (
		<li className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-center">
			<div className="flex min-w-0 items-center gap-3">
				<KindTile icon={kind.icon} />
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{c.name}</p>
					<p className="text-xs text-muted-foreground">
						{kind.label} ·{" "}
						{c.rules === 0
							? "no rules"
							: `${c.rules} rule${c.rules === 1 ? "" : "s"}`}
					</p>
				</div>
			</div>
			<div className="min-w-0">
				<StatusLabel meta={status.meta} />
				{status.detail && (
					<p
						className={
							status.meta.tone === "bad"
								? "truncate text-xs text-bad-text"
								: "truncate text-xs text-muted-foreground"
						}
						title={status.detail}
					>
						{status.detail}
					</p>
				)}
			</div>
			<div className="flex items-center gap-1 sm:justify-end">
				<Button
					variant="outline"
					size="sm"
					disabled={sending}
					onClick={async () => {
						setSending(true);
						try {
							await api.networking.notifications.testChannel(c.id);
							toast.success(`Test sent to ${c.name}`);
						} catch (err) {
							toast.error(`${c.name} didn't accept the test`, {
								description: err instanceof Error ? err.message : String(err),
							});
						} finally {
							setSending(false);
						}
					}}
				>
					{sending ? <Loader2 className="animate-spin" /> : <Send />}
					Send test
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Delete ${c.name}`}
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function scopeLabel(rule: Rule, projects: ProjectSummary[]) {
	const p = projects.find((x) => x.id === rule.scope.projectId);
	const s = p?.services.find((x) => x.id === rule.scope.serviceId);
	if (s && p) return `${s.name} in ${p.name}`;
	if (p) return p.name;
	if (rule.scope.projectId) return "a deleted project";
	return "every project";
}

function RuleRow({
	rule,
	channel,
	projects,
	onEdit,
	onToggle,
	onDelete,
}: {
	rule: Rule;
	channel: Channel | undefined;
	projects: ProjectSummary[];
	onEdit: () => void;
	onToggle: (enabled: boolean) => void;
	onDelete: () => void;
}) {
	const shown = rule.events.slice(0, 3).map(eventLabel);
	const more = rule.events.length - shown.length;
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<Switch
					checked={rule.enabled}
					onCheckedChange={onToggle}
					aria-label={rule.enabled ? "Pause rule" : "Resume rule"}
					className="mt-0.5"
				/>
				<p
					className={rule.enabled ? "text-sm" : "text-sm text-muted-foreground"}
				>
					<span className="font-medium">
						{shown.join(", ")}
						{more > 0 && ` and ${more} more`}
					</span>{" "}
					<span className="text-muted-foreground">in</span>{" "}
					{scopeLabel(rule, projects)}{" "}
					<span className="text-muted-foreground">go to</span>{" "}
					<span className="font-medium">
						{channel?.name ?? "a deleted channel"}
					</span>
				</p>
			</div>
			<div className="flex gap-1 self-end sm:self-auto">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Edit rule"
					onClick={onEdit}
				>
					<Pencil />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Delete rule"
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function NotificationsPage() {
	const s = section("/integrations/notifications");
	const { rule: forChannel } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const channels = useQuery(channelsQuery);
	const rules = useQuery(rulesQuery);
	const { data: projects = [] } = useQuery(projectsQuery);
	const [editing, setEditing] = useState<Rule | "new" | null>(null);
	const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null);
	const [deletingRule, setDeletingRule] = useState<Rule | null>(null);
	const keys = [["notification-rules"], ["notification-channels"]];
	const createRule = useInvalidating(
		api.networking.notifications.createRule,
		keys,
	);
	const updateRule = useInvalidating(
		({ id, input }: { id: string; input: RuleInput }) =>
			api.networking.notifications.updateRule(id, input),
		keys,
	);
	const removeRule = useInvalidating(
		api.networking.notifications.removeRule,
		keys,
	);
	const removeChannel = useInvalidating(
		api.networking.notifications.removeChannel,
		keys,
	);

	// Arriving from the channel wizard opens a new rule for that channel.
	const editor: Rule | "new" | null = editing ?? (forChannel ? "new" : null);
	const closeEditor = () => {
		setEditing(null);
		if (forChannel) navigate({ search: {}, replace: true });
	};
	const save = async (input: RuleInput) => {
		try {
			if (editor && editor !== "new")
				await updateRule.mutateAsync({ id: editor.id, input });
			else await createRule.mutateAsync(input);
			toast.success(editor === "new" ? "Rule added" : "Rule saved");
			closeEditor();
		} catch (err) {
			toast.error("Couldn't save the rule", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const addChannel = (variant: "default" | "outline" = "default") => (
		<Button asChild variant={variant}>
			<Link to="/integrations/notifications/new">
				<Plus data-icon="inline-start" />
				Add channel
			</Link>
		</Button>
	);

	const list = channels.data ?? [];

	return (
		<Page>
			<PageHeader
				title={s.title}
				description={s.description}
				actions={list.length ? addChannel() : undefined}
			/>
			{channels.isPending ? (
				<Panel title="Channels" id="channels">
					<SkeletonRows rows={3} />
				</Panel>
			) : !list.length ? (
				<EmptyState
					icon={Bell}
					title={s.empty?.title ?? "No channels yet"}
					description={s.empty?.body}
				>
					{addChannel()}
				</EmptyState>
			) : (
				<div className="grid gap-10">
					<Panel title="Channels" id="channels">
						<ul className="divide-y">
							{list.map((c) => (
								<ChannelRow
									key={c.id}
									c={c}
									onDelete={() => setDeletingChannel(c)}
								/>
							))}
						</ul>
					</Panel>

					<section aria-labelledby="rules" className="grid gap-2.5">
						<div className="flex min-h-7 items-center justify-between gap-3">
							<h2 id="rules" className="text-sm font-semibold">
								Rules
							</h2>
							{editor === null && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => setEditing("new")}
								>
									<Plus />
									New rule
								</Button>
							)}
						</div>
						{editor !== null && (
							<RuleEditor
								key={editor === "new" ? `new-${forChannel ?? ""}` : editor.id}
								title={editor === "new" ? "New rule" : "Edit rule"}
								channels={list}
								projects={projects}
								initial={
									editor === "new"
										? {
												events: ["deployment.failed"],
												scope: {},
												channelId: forChannel ?? list[0]?.id ?? "",
												enabled: true,
											}
										: {
												events: editor.events,
												scope: editor.scope,
												channelId: editor.channelId,
												enabled: editor.enabled,
											}
								}
								onSave={save}
								onCancel={closeEditor}
							/>
						)}
						<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
							{rules.isPending ? (
								<SkeletonRows rows={3} />
							) : rules.data?.length ? (
								<ul className="divide-y">
									{rules.data.map((r) => (
										<RuleRow
											key={r.id}
											rule={r}
											channel={list.find((c) => c.id === r.channelId)}
											projects={projects}
											onEdit={() => setEditing(r)}
											onDelete={() => setDeletingRule(r)}
											onToggle={(enabled) =>
												updateRule
													.mutateAsync({
														id: r.id,
														input: {
															events: r.events,
															scope: r.scope,
															channelId: r.channelId,
															enabled,
														},
													})
													.catch((err: unknown) =>
														toast.error("Couldn't update the rule", {
															description: String(err),
														}),
													)
											}
										/>
									))}
								</ul>
							) : (
								<p className="px-4 py-6 text-sm text-muted-foreground">
									No rules yet, so nothing is sent. A rule picks events, an
									optional project or service, and the channel they go to.
								</p>
							)}
						</div>
					</section>
				</div>
			)}
			<ConfirmDelete
				open={deletingChannel !== null}
				onOpenChange={(o) => !o && setDeletingChannel(null)}
				title={`Delete ${deletingChannel?.name ?? "channel"}?`}
				description={`Its credentials and its ${deletingChannel?.rules ?? 0} rule${deletingChannel?.rules === 1 ? "" : "s"} are deleted with it.`}
				onConfirm={async () => {
					if (!deletingChannel) return;
					await removeChannel.mutateAsync(deletingChannel.id);
					toast.success(`${deletingChannel.name} deleted`);
				}}
			/>
			<ConfirmDelete
				open={deletingRule !== null}
				onOpenChange={(o) => !o && setDeletingRule(null)}
				title="Delete this rule?"
				description="Its events stop reaching the channel. The channel itself stays."
				onConfirm={async () => {
					if (!deletingRule) return;
					await removeRule.mutateAsync(deletingRule.id);
				}}
			/>
		</Page>
	);
}
