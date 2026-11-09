/*
 * The task's history: comments and activity in one timeline, newest at the bottom, with replies
 * one level deep, reactions from a fixed set, resolve for question threads, and a composer with
 * mentions, task references and pasted images (⌘Enter sends).
 */
import {
	type PmDoc,
	type WorkActivity,
	type WorkComment,
	type WorkFeedItem,
	type WorkReaction,
	workReactions,
} from "@logistack/contracts";
import type { Editor } from "@tiptap/react";
import {
	Check,
	CornerDownRight,
	Link2,
	MoreHorizontal,
	Pencil,
	SmilePlus,
	Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import {
	useCreateWorkComment,
	useDeleteWorkComment,
	useResolveWorkComment,
	useUpdateWorkComment,
	useWorkActivity,
	useWorkReaction,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { formatDay, personName, priorityMeta, timeAgo } from "../lib";
import { PersonAvatar } from "../parts";
import type { WorkProjectContext } from "../views/types";
import { RichEditor, RichText } from "./editor";
import { Section } from "./sections";

const emptyDoc = (d: PmDoc | null) =>
	!d?.content?.some(
		(n) => n.type !== "paragraph" || (n.content?.length ?? 0) > 0,
	);

/** One line for an activity entry, in plain words. */
function describe(a: WorkActivity, project: WorkProjectContext): string {
	const d = a.data as Record<string, unknown>;
	const name = (id: unknown) => personName(project.people, String(id ?? ""));
	const list = (id: unknown) =>
		project.lists.find((l) => l.id === id)?.name ?? "another list";
	const dates = (v: unknown) =>
		Array.isArray(v)
			? v
					.filter(Boolean)
					.map((x) => formatDay(String(x)))
					.join(" → ") || "no dates"
			: String(v ?? "");
	switch (a.kind) {
		case "created":
			return "created this task";
		case "status":
			return `moved this from ${d.from ?? "?"} to ${d.to ?? "?"}`;
		case "assignee_added":
			return `assigned ${name(d.userId)}`;
		case "assignee_removed":
			return `unassigned ${name(d.userId)}`;
		case "dates":
			return `changed the dates to ${dates(d.to)}`;
		case "priority":
			return `set priority to ${priorityMeta(String(d.to) as "none").label}`;
		case "list_moved":
			return `moved this to ${list(d.to)}`;
		case "project_moved":
			return "moved this from another project";
		case "field":
			return `changed ${String(d.name ?? "a field")}`;
		case "tag_added":
			return `added a tag`;
		case "tag_removed":
			return `removed a tag`;
		case "dependency_added":
			return "added a dependency";
		case "dependency_removed":
			return "removed a dependency";
		case "attachment_added":
			return `attached ${String(d.name ?? "a file")}`;
		case "attachment_removed":
			return `removed ${String(d.name ?? "a file")}`;
		case "archived":
			return "archived this task";
		case "restored":
			return "restored this task";
		case "checklist":
			return "updated the checklist";
		case "git_linked":
			return "linked a commit or pull request";
		case "git_closed":
			return "closed this from a commit";
		case "imported":
			return "imported this task";
		case "recurred":
			return "created the next occurrence";
	}
	return "updated this task";
}

type Thread = { comment: WorkComment; replies: WorkComment[] };
type Entry =
	| { type: "activity"; activity: WorkActivity; at: string }
	| { type: "thread"; thread: Thread; at: string };

function Reactions({
	comment,
	me,
	onToggle,
	canReact,
}: {
	comment: WorkComment;
	me?: string;
	onToggle: (emoji: WorkReaction, on: boolean) => void;
	canReact: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-wrap items-center gap-1">
			{comment.reactions.map((r) => {
				const mine = !!me && r.userIds.includes(me);
				return (
					<button
						key={r.emoji}
						type="button"
						disabled={!canReact}
						aria-pressed={mine}
						aria-label={`${r.emoji} ${r.userIds.length}${mine ? ", including you" : ""}`}
						onClick={() => onToggle(r.emoji, !mine)}
						className={cn(
							"t-press inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs tabular ring-1 transition-colors duration-(--duration-quick)",
							mine ? "bg-brand/10 ring-brand/40" : "ring-border hover:bg-muted",
						)}
					>
						<span aria-hidden>{r.emoji}</span>
						{r.userIds.length}
					</button>
				);
			})}
			{canReact && (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Add a reaction"
							className="text-muted-foreground opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
						>
							<SmilePlus />
						</Button>
					</PopoverTrigger>
					<PopoverContent align="start" className="w-auto flex-row gap-0.5 p-1">
						{workReactions.map((emoji) => (
							<button
								key={emoji}
								type="button"
								aria-label={`React with ${emoji}`}
								onClick={() => {
									const on = !comment.reactions
										.find((r) => r.emoji === emoji)
										?.userIds.includes(me ?? "");
									onToggle(emoji, on);
									setOpen(false);
								}}
								className="t-press grid size-8 place-items-center rounded-md text-base hover:bg-muted"
							>
								{emoji}
							</button>
						))}
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
}

function CommentView({
	comment,
	project,
	taskId,
	me,
	onReply,
	isReply,
}: {
	comment: WorkComment;
	project: WorkProjectContext;
	taskId: string;
	me?: string;
	onReply?: () => void;
	isReply?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<PmDoc | null>(comment.body);
	const update = useUpdateWorkComment();
	const remove = useDeleteWorkComment();
	const resolve = useResolveWorkComment();
	const react = useWorkReaction();
	const author = project.people.find((p) => p.userId === comment.authorId);
	const mine = comment.authorId === me;
	const deleted = !!comment.deletedAt;
	const canComment = true;
	return (
		<article
			id={`comment-${comment.id}`}
			aria-label={`Comment by ${author?.name ?? "Former member"}`}
			className="group/comment flex gap-3"
		>
			<PersonAvatar
				person={author ?? { name: "Former member", avatar: null }}
				className={cn(
					"mt-0.5 shrink-0",
					isReply ? "size-5" : "size-7 text-2xs",
				)}
			/>
			<div className="min-w-0 flex-1">
				<header className="flex items-center gap-2 text-sm">
					<span className="font-medium">{author?.name ?? "Former member"}</span>
					<time
						dateTime={comment.createdAt}
						className="text-xs text-muted-foreground"
					>
						{timeAgo(comment.createdAt)}
					</time>
					{comment.editedAt && (
						<span className="text-xs text-muted-foreground">edited</span>
					)}
					{comment.resolvedAt && (
						<span className="inline-flex items-center gap-1 rounded-full bg-ok/12 px-1.5 text-2xs font-medium text-ok-text">
							<Check className="size-3" aria-hidden /> Resolved
						</span>
					)}
					{!deleted && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="Comment actions"
									className="ml-auto text-muted-foreground opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
								>
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-44">
								{mine && (
									<DropdownMenuItem onSelect={() => setEditing(true)}>
										<Pencil /> Edit
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									onSelect={() => {
										const url = new URL(window.location.href);
										url.searchParams.set("task", taskId);
										url.hash = `comment-${comment.id}`;
										void navigator.clipboard.writeText(url.toString());
										toast.success("Link copied");
									}}
								>
									<Link2 /> Copy link
								</DropdownMenuItem>
								{!isReply && project.canEdit && (
									<DropdownMenuItem
										onSelect={() =>
											resolve.mutate({
												taskId,
												id: comment.id,
												resolved: !comment.resolvedAt,
											})
										}
									>
										<Check />{" "}
										{comment.resolvedAt ? "Reopen thread" : "Resolve thread"}
									</DropdownMenuItem>
								)}
								{(mine || project.canAdmin) && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											variant="destructive"
											onSelect={() => remove.mutate({ taskId, id: comment.id })}
										>
											<Trash2 /> Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</header>
				{deleted ? (
					<p className="mt-0.5 text-sm text-muted-foreground italic">
						This comment was deleted.
					</p>
				) : editing ? (
					<div className="mt-1 rounded-lg bg-background p-2 ring-1 ring-input focus-within:ring-ring">
						<RichEditor
							value={comment.body}
							onChange={setDraft}
							people={project.people}
							projectId={project.id}
							autofocus
							label="Edit comment"
							onSubmit={() => {
								if (!draft || emptyDoc(draft)) return;
								update.mutate({
									taskId,
									id: comment.id,
									patch: { body: draft },
								});
								setEditing(false);
							}}
						/>
						<div className="mt-2 flex justify-end gap-1.5">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setEditing(false)}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								disabled={!draft || emptyDoc(draft)}
								onClick={() => {
									if (!draft) return;
									update.mutate({
										taskId,
										id: comment.id,
										patch: { body: draft },
									});
									setEditing(false);
								}}
							>
								Save
							</Button>
						</div>
					</div>
				) : (
					<RichText value={comment.body} className="mt-0.5" />
				)}
				{!deleted && !editing && comment.attachments.length > 0 && (
					<ul className="mt-2 flex flex-wrap gap-2">
						{comment.attachments.map((a) => (
							<li key={a.id}>
								<a
									href={a.url}
									target="_blank"
									rel="noreferrer"
									className="block"
								>
									{a.contentType.startsWith("image/") ? (
										<img
											src={a.thumbUrl ?? a.url}
											alt={a.name}
											className="h-24 rounded-md outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
										/>
									) : (
										<span className="text-sm text-info-text underline">
											{a.name}
										</span>
									)}
								</a>
							</li>
						))}
					</ul>
				)}
				{!deleted && (
					<div className="mt-1.5 flex items-center gap-2">
						<Reactions
							comment={comment}
							me={me}
							canReact={canComment}
							onToggle={(emoji, on) =>
								react.mutate({ taskId, id: comment.id, emoji, on })
							}
						/>
						{onReply && (
							<Button
								variant="ghost"
								size="xs"
								className="text-muted-foreground opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100"
								onClick={onReply}
							>
								<CornerDownRight data-icon="inline-start" /> Reply
							</Button>
						)}
					</div>
				)}
			</div>
		</article>
	);
}

/** The comment box: rich text, mentions, #refs, pasted images; ⌘Enter sends. */
export function Composer({
	taskId,
	project,
	parentId,
	onSent,
	autofocus,
	placeholder = "Write a comment. @ mentions, # links a task, paste a screenshot.",
}: {
	taskId: string;
	project: WorkProjectContext;
	parentId?: string;
	onSent?: () => void;
	autofocus?: boolean;
	placeholder?: string;
}) {
	const create = useCreateWorkComment();
	const [doc, setDoc] = useState<PmDoc | null>(null);
	const [uploads, setUploads] = useState<string[]>([]);
	const editor = useRef<Editor | null>(null);
	const send = async () => {
		if (!doc || emptyDoc(doc) || create.isPending) return;
		try {
			await create.mutateAsync({
				taskId,
				input: {
					body: doc,
					...(parentId && { parentId }),
					...(uploads.length && { attachmentIds: uploads }),
				},
			});
			editor.current?.commands.clearContent();
			setDoc(null);
			setUploads([]);
			onSent?.();
		} catch (e) {
			toast.error("The comment wasn't sent", {
				description:
					e instanceof Error ? e.message : "Your text is still here.",
			});
		}
	};
	return (
		<div className="rounded-lg bg-background p-2 ring-1 ring-input transition-shadow duration-(--duration-quick) focus-within:ring-2 focus-within:ring-ring/60">
			<RichEditor
				value={null}
				onChange={setDoc}
				people={project.people}
				projectId={project.id}
				placeholder={placeholder}
				label={parentId ? "Reply" : "Comment"}
				autofocus={autofocus}
				onSubmit={send}
				editorRef={(e) => {
					editor.current = e;
				}}
				className="max-h-64 overflow-y-auto px-1 [&_.work-prose]:min-h-12"
				onUpload={async (file) => {
					const a = await api.work.attachments.upload({
						file,
						taskId,
						inline: "comment",
					});
					setUploads((u) => [...u, a.id]);
					return a;
				}}
			/>
			<div className="mt-1 flex items-center justify-end gap-2">
				<span className="hidden text-xs text-muted-foreground sm:inline">
					<Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send
				</span>
				<Button
					size="sm"
					disabled={!doc || emptyDoc(doc) || create.isPending}
					onClick={send}
				>
					{parentId ? "Reply" : "Comment"}
				</Button>
			</div>
		</div>
	);
}

export function Activity({
	taskId,
	project,
	me,
}: {
	taskId: string;
	project: WorkProjectContext;
	me?: string;
}) {
	const feed = useWorkActivity(taskId);
	const [filter, setFilter] = useState<"all" | "comments">("all");
	const [replyTo, setReplyTo] = useState<string | null>(null);

	const entries = useMemo(() => {
		const items: WorkFeedItem[] = [...(feed.data?.pages ?? [])]
			.reverse()
			.flatMap((p) => p.items);
		const comments = items.flatMap((i) =>
			i.type === "comment" ? [i.comment] : [],
		);
		const threads = new Map<string, Thread>();
		for (const c of comments)
			if (!c.parentId) threads.set(c.id, { comment: c, replies: [] });
		for (const c of comments)
			if (c.parentId) threads.get(c.parentId)?.replies.push(c);
		const out: Entry[] = [];
		for (const i of items) {
			if (i.type === "activity") {
				if (filter === "all")
					out.push({
						type: "activity",
						activity: i.activity,
						at: i.activity.createdAt,
					});
			} else if (!i.comment.parentId) {
				const thread = threads.get(i.comment.id);
				if (thread)
					out.push({ type: "thread", thread, at: i.comment.createdAt });
			}
		}
		return out;
	}, [feed.data, filter]);

	return (
		<Section
			id="sheet-activity"
			title="Activity"
			actions={
				<Segmented
					label="Show"
					value={filter}
					onChange={setFilter}
					options={[
						{ value: "all", label: "All" },
						{ value: "comments", label: "Comments" },
					]}
				/>
			}
		>
			{feed.hasNextPage && (
				<Button
					variant="ghost"
					size="sm"
					className="justify-self-start text-muted-foreground"
					disabled={feed.isFetchingNextPage}
					onClick={() => void feed.fetchNextPage()}
				>
					Show older
				</Button>
			)}
			<ol className="grid gap-4">
				{entries.map((e) =>
					e.type === "activity" ? (
						<li
							key={e.activity.id}
							className="flex items-center gap-3 pl-1.5 text-sm text-muted-foreground"
						>
							<span
								aria-hidden
								className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
							/>
							<span className="min-w-0">
								<span className="font-medium text-foreground/80">
									{personName(project.people, e.activity.actorId) ||
										"LogiStack"}
								</span>{" "}
								{describe(e.activity, project)}
								<span className="text-xs">
									{" "}
									· {timeAgo(e.activity.createdAt)}
								</span>
							</span>
						</li>
					) : (
						<li key={e.thread.comment.id} className="grid gap-3">
							<CommentView
								comment={e.thread.comment}
								project={project}
								taskId={taskId}
								me={me}
								onReply={() => setReplyTo(e.thread.comment.id)}
							/>
							{(e.thread.replies.length > 0 ||
								replyTo === e.thread.comment.id) && (
								<div className="ml-10 grid gap-3 border-l pl-4">
									{e.thread.replies.map((r) => (
										<CommentView
											key={r.id}
											comment={r}
											project={project}
											taskId={taskId}
											me={me}
											isReply
										/>
									))}
									{replyTo === e.thread.comment.id && (
										<Composer
											taskId={taskId}
											project={project}
											parentId={e.thread.comment.id}
											autofocus
											placeholder="Reply to this thread"
											onSent={() => setReplyTo(null)}
										/>
									)}
								</div>
							)}
						</li>
					),
				)}
			</ol>
		</Section>
	);
}
