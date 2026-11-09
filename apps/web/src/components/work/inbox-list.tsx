/* Inbox: what happened on tasks I care about, newest first, grouped Today / Earlier. */
import type {
	WorkNotification,
	WorkNotificationKind,
} from "@logistack/contracts";
import { useQueries } from "@tanstack/react-query";
import { Bell, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	useMarkWorkInboxRead,
	useWorkInbox,
	workPeopleQuery,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { timeAgo } from "./lib";
import { PersonAvatar, TaskKey } from "./parts";
import { useShortcut } from "./shortcuts";
import { useOpenTask } from "./task-sheet/open-task";

const KIND_TEXT: Record<WorkNotificationKind, string> = {
	assigned: "assigned you",
	unassigned: "unassigned you",
	mentioned: "mentioned you",
	commented: "commented",
	replied: "replied to you",
	status_changed: "changed the status",
	due_soon: "Due soon",
	overdue: "Overdue",
	checklist_assigned: "gave you a checklist item",
	timer_running_long: "Your timer is still running",
};

const FILTERS: { id: string; label: string; kinds?: WorkNotificationKind[] }[] =
	[
		{ id: "all", label: "Everything" },
		{
			id: "mentions",
			label: "Mentions and replies",
			kinds: ["mentioned", "replied"],
		},
		{
			id: "assigned",
			label: "Assignments",
			kinds: ["assigned", "unassigned", "checklist_assigned"],
		},
		{
			id: "comments",
			label: "Comments",
			kinds: ["commented", "replied", "mentioned"],
		},
		{ id: "dates", label: "Due dates", kinds: ["due_soon", "overdue"] },
		{ id: "status", label: "Status changes", kinds: ["status_changed"] },
	];

export function InboxList() {
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [filter, setFilter] = useState("all");
	const inbox = useWorkInbox(unreadOnly);
	const markRead = useMarkWorkInboxRead();
	const openTask = useOpenTask();
	const all = inbox.data?.pages.flatMap((p) => p.items) ?? [];
	// People come from each project's people list: work-only actors can't list org members.
	const people = useQueries({
		queries: [...new Set(all.map((n) => n.projectId))].map((id) =>
			workPeopleQuery(id),
		),
		combine: (rs) => rs.flatMap((r) => r.data ?? []),
	});
	const name = (id: string | null) =>
		id ? (people.find((p) => p.userId === id)?.name ?? "Former member") : null;

	const kinds = FILTERS.find((f) => f.id === filter)?.kinds;
	const items = useMemo(
		() =>
			(inbox.data?.pages.flatMap((p) => p.items) ?? []).filter(
				(n) => !kinds || kinds.includes(n.kind),
			),
		[inbox.data, kinds],
	);
	const unread = inbox.data?.pages[0]?.unread ?? 0;
	const startOfToday = new Date().setHours(0, 0, 0, 0);
	const groups = [
		{
			label: "Today",
			items: items.filter(
				(n) => new Date(n.createdAt).getTime() >= startOfToday,
			),
		},
		{
			label: "Earlier",
			items: items.filter(
				(n) => new Date(n.createdAt).getTime() < startOfToday,
			),
		},
	].filter((g) => g.items.length);

	const [focus, setFocus] = useState(0);
	const open = (n: WorkNotification) => {
		if (!n.readAt) markRead.mutate({ ids: [n.id] });
		openTask(n.taskId);
	};
	useShortcut("j", () => setFocus((f) => Math.min(items.length - 1, f + 1)));
	useShortcut("k", () => setFocus((f) => Math.max(0, f - 1)));
	useShortcut("Enter", () => {
		const n = items[focus];
		if (n) open(n);
	});

	return (
		<Page className="max-w-3xl">
			<PageHeader
				title="Inbox"
				description="Mentions, assignments, comments and dates on the tasks you follow."
				actions={
					<Button
						variant="outline"
						disabled={unread === 0 || markRead.isPending}
						onClick={() => markRead.mutate({ all: true })}
					>
						Mark all read
					</Button>
				}
			/>
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<Select value={filter} onValueChange={setFilter}>
					<SelectTrigger size="sm" aria-label="Show">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{FILTERS.map((f) => (
							<SelectItem key={f.id} value={f.id}>
								{f.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={unreadOnly ? "unread" : "all"}
					onValueChange={(v) => setUnreadOnly(v === "unread")}
				>
					<SelectTrigger size="sm" aria-label="Read state">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">Read and unread</SelectItem>
						<SelectItem value="unread">Unread only</SelectItem>
					</SelectContent>
				</Select>
				{unread > 0 && (
					<span className="text-sm text-muted-foreground tabular">
						{unread} unread
					</span>
				)}
			</div>
			{inbox.isLoading ? (
				<div className="grid gap-2">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-14" />
					))}
				</div>
			) : groups.length === 0 ? (
				<EmptyState
					icon={Inbox}
					title={unreadOnly ? "All caught up" : "Nothing here yet"}
					description="When someone mentions you, assigns you or a task you follow changes, it lands here."
				/>
			) : (
				<div className="grid gap-6">
					{groups.map((g) => (
						<section key={g.label} aria-label={g.label}>
							<h2 className="mb-1 px-2 text-xs font-semibold text-muted-foreground">
								{g.label}
							</h2>
							<ul className="divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
								{g.items.map((n) => {
									const i = items.indexOf(n);
									const actor = name(n.actorId);
									const bundled = Number(n.data.count ?? 0);
									return (
										<li key={n.id}>
											<button
												type="button"
												tabIndex={i === focus ? 0 : -1}
												onFocus={() => setFocus(i)}
												onClick={() => open(n)}
												className={cn(
													"flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors duration-(--duration-quick) hover:bg-muted/60 focus-visible:bg-muted/60",
													i === focus && "bg-muted/40",
												)}
											>
												<span className="relative mt-0.5">
													{actor ? (
														<PersonAvatar
															person={{ name: actor, avatar: null }}
															className="size-7 text-2xs"
														/>
													) : (
														<span className="grid size-7 place-items-center rounded-full bg-muted text-muted-foreground">
															<Bell className="size-3.5" aria-hidden />
														</span>
													)}
													{!n.readAt && (
														<span
															role="img"
															aria-label="Unread"
															className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-brand ring-2 ring-card"
														/>
													)}
												</span>
												<span className="min-w-0 flex-1">
													<span
														className={cn(
															"block text-sm",
															!n.readAt && "font-medium",
														)}
													>
														{actor &&
														n.kind !== "due_soon" &&
														n.kind !== "overdue" ? (
															<>
																{actor} {KIND_TEXT[n.kind]}
																{bundled > 1 && ` (${bundled} changes)`}
															</>
														) : (
															KIND_TEXT[n.kind]
														)}
													</span>
													<span className="mt-0.5 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
														<TaskKey value={n.taskKey} />
														<span className="truncate">{n.taskTitle}</span>
													</span>
												</span>
												<span className="shrink-0 text-right text-xs text-muted-foreground">
													<span className="block">{timeAgo(n.createdAt)}</span>
													<span className="block truncate">
														{n.projectName}
													</span>
												</span>
											</button>
										</li>
									);
								})}
							</ul>
						</section>
					))}
					{inbox.hasNextPage && (
						<Button
							variant="ghost"
							className="justify-self-center"
							disabled={inbox.isFetchingNextPage}
							onClick={() => void inbox.fetchNextPage()}
						>
							Load older
						</Button>
					)}
				</div>
			)}
		</Page>
	);
}
