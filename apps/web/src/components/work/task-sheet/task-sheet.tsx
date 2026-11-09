/*
 * The task sheet (section 13.2): a side sheet over any page, opened by `?task=`, or the same task
 * as a full page at `/work/t/<key>` (content left, activity right, like ClickUp). Every edit
 * autosaves with an optimistic update; the title and description carry the concurrency token, and
 * a 409 shows who changed what with Reload / Overwrite (section 9).
 */
import type { PmDoc, WorkTask } from "@logistack/contracts";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import {
	Archive,
	Copy,
	Eye,
	EyeOff,
	GitBranch,
	Link2,
	Maximize2,
	MoreHorizontal,
	Paperclip,
	Trash2,
	X,
} from "lucide-react";
import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { TextMorph } from "torph/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { useMe } from "@/lib/api/access";
import {
	useArchiveWorkTask,
	useCreateWorkTask,
	useDeleteWorkTask,
	useDuplicateWorkTask,
	usePatchWorkTask,
	useWorkTask,
	useWorkTaskWatcher,
	workKeys,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { TaskAiActions } from "../ai/task-ai-actions";
import { TaskDevelopmentSection } from "../git/task-development-section";
import { ColorDot, TaskKey } from "../parts";
import { useSurfaces } from "../shell/work-nav";
import { useShortcut } from "../shortcuts";
import { useTaskEdits } from "../task-edits";
import { requestSaveAsTemplate } from "../templates/save-as-template-wizard";
import { useWorkProjectContext } from "../use-work-project";
import { useWorkSubscription } from "../use-work-subscription";
import type { WorkProjectContext } from "../views/types";
import { Activity, Composer } from "./activity";
import { RichEditor } from "./editor";
import { OpenTaskOverride, useOpenTask } from "./open-task";
import { Properties } from "./properties";
import {
	Attachments,
	Checklist,
	Dependencies,
	Subtasks,
	useUploadFiles,
} from "./sections";

/** Mounted once in the app layout; shows the sheet while `?task=` is in the URL. */
export function TaskSheetHost() {
	const taskId = useRouterState({
		select: (s) => (s.location.search as { task?: string }).task,
	});
	const openTask = useOpenTask();
	// Keep the last task on screen while the sheet animates out.
	const [shown, setShown] = useState(taskId);
	useEffect(() => {
		if (taskId) setShown(taskId);
	}, [taskId]);
	return (
		<Sheet open={!!taskId} onOpenChange={(o) => !o && openTask(null)}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-full gap-0 p-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[720px] motion-reduce:animate-none"
				aria-describedby={undefined}
			>
				{shown && (
					<TaskSheetBody
						key={shown}
						taskId={shown}
						onClose={() => openTask(null)}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

type Layout = "sheet" | "page";

/** Radix titles only exist inside the sheet's dialog; the page uses plain elements. */
function A11yTitle({
	layout,
	children,
}: {
	layout: Layout;
	children: ReactElement;
}) {
	return layout === "sheet" ? (
		<SheetTitle asChild>{children}</SheetTitle>
	) : (
		children
	);
}

function A11yDescription({
	layout,
	className,
	children,
}: {
	layout: Layout;
	className?: string;
	children: ReactNode;
}) {
	return layout === "sheet" ? (
		<SheetDescription className={className}>{children}</SheetDescription>
	) : (
		<p className={className}>{children}</p>
	);
}

/** `/work/t/<key>`: the task as a full page. Opening another task from it moves to its page. */
export function TaskPage({ taskId }: { taskId: string }) {
	const navigate = useNavigate();
	const goTo = useCallback(
		(id: string | null) => {
			if (id) void navigate({ to: "/work/t/$key", params: { key: id } });
		},
		[navigate],
	);
	const close = useCallback(() => {
		if (window.history.length > 1) window.history.back();
		else void navigate({ to: "/work" });
	}, [navigate]);
	return (
		<OpenTaskOverride.Provider value={goTo}>
			{/* Under the 3.5rem top bar: each column scrolls on its own, like a document beside its thread. */}
			<div className="flex min-h-0 flex-col bg-background xl:h-[calc(100svh-3.5rem)]">
				<TaskSheetBody
					key={taskId}
					taskId={taskId}
					onClose={close}
					layout="page"
				/>
			</div>
		</OpenTaskOverride.Provider>
	);
}

function TaskSheetBody({
	taskId,
	onClose,
	layout = "sheet",
}: {
	taskId: string;
	onClose: () => void;
	layout?: Layout;
}) {
	const { data: task, error } = useWorkTask(taskId);
	const { data: project } = useWorkProjectContext(task?.projectId ?? "");
	useWorkSubscription(task?.projectId);
	if (error)
		return (
			<div className="grid h-full place-items-center p-8 text-center">
				<div>
					<A11yTitle layout={layout}>
						<h2 className="text-md font-semibold">This task isn't available</h2>
					</A11yTitle>
					<A11yDescription
						layout={layout}
						className="mt-1 text-sm text-muted-foreground"
					>
						It may have been deleted, or you no longer have access to its
						project.
					</A11yDescription>
					<Button variant="outline" className="mt-4" onClick={onClose}>
						Close
					</Button>
				</div>
			</div>
		);
	if (!task || !project)
		return (
			<div className="grid gap-4 p-6">
				<A11yTitle layout={layout}>
					<h2 className="sr-only">Loading task</h2>
				</A11yTitle>
				<Skeleton className="h-5 w-48" />
				<Skeleton className="h-8 w-3/4" />
				<Skeleton className="h-48" />
				<Skeleton className="h-32" />
			</div>
		);
	return (
		<TaskSheet
			task={task}
			project={project}
			onClose={onClose}
			layout={layout}
		/>
	);
}

const isConflict = (e: unknown): e is ApiError & { details: WorkTask } =>
	e instanceof ApiError && e.status === 409 && !!e.details;

function SaveState() {
	const busy = useIsMutating() > 0;
	const [saved, setSaved] = useState(false);
	const was = useRef(false);
	useEffect(() => {
		if (was.current && !busy) {
			setSaved(true);
			const t = setTimeout(() => setSaved(false), 2000);
			was.current = busy;
			return () => clearTimeout(t);
		}
		was.current = busy;
	}, [busy]);
	return (
		<span aria-live="polite" className="text-xs text-muted-foreground">
			<TextMorph>{busy ? "Saving…" : saved ? "Saved" : ""}</TextMorph>
		</span>
	);
}

function TaskSheet({
	task,
	project,
	onClose,
	layout,
}: {
	task: WorkTask;
	project: WorkProjectContext;
	onClose: () => void;
	layout: Layout;
}) {
	const page = layout === "page";
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { data: me } = useMe();
	const myId = me?.userId;
	const { ops } = useSurfaces();
	const edits = useTaskEdits();
	const patch = usePatchWorkTask();
	const openTask = useOpenTask();
	const watcher = useWorkTaskWatcher();
	const duplicate = useDuplicateWorkTask();
	const archive = useArchiveWorkTask();
	const del = useDeleteWorkTask();
	const create = useCreateWorkTask();
	const uploadFiles = useUploadFiles(task);
	const [deleting, setDeleting] = useState(false);
	const [commentDraft, setCommentDraft] = useState<PmDoc | null>(null);
	const descEditor = useRef<Editor | null>(null);
	const setDescEditor = useCallback((e: Editor | null) => {
		descEditor.current = e;
	}, []);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	/** Whatever scrolls the activity: the sheet body, or the page's right column. */
	const activityRef = useRef<HTMLDivElement | null>(null);
	const [dragging, setDragging] = useState(false);
	const [conflict, setConflict] = useState<{
		mine: { title?: string; description?: PmDoc | null };
		theirs: WorkTask;
	} | null>(null);
	const list = project.lists.find((l) => l.id === task.listId);
	const can = project.canEdit;

	/** Title and description carry the concurrency token. */
	const save = (
		p: { title?: string; description?: PmDoc | null },
		expected = task.updatedAt,
	) =>
		patch.mutate(
			{ id: task.id, patch: { ...p, expectedUpdatedAt: expected } },
			{
				onError: (e) => {
					if (isConflict(e)) setConflict({ mine: p, theirs: e.details });
					else
						toast.error(`${task.key} wasn't saved`, {
							description: e instanceof Error ? e.message : undefined,
						});
				},
			},
		);

	// Title: inline, autosized, saved on blur or Enter.
	const [title, setTitle] = useState(task.title);
	useEffect(() => setTitle(task.title), [task.title]);
	const titleRef = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes.
	useEffect(() => {
		const el = titleRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [title]);
	const commitTitle = () => {
		const t = title.trim();
		if (!t) setTitle(task.title);
		else if (t !== task.title) save({ title: t });
	};

	// Description: autosave 800 ms after typing stops.
	const descTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const pendingDesc = useRef<PmDoc | null | undefined>(undefined);
	const flushDesc = () => {
		clearTimeout(descTimer.current);
		if (pendingDesc.current !== undefined) {
			save({ description: pendingDesc.current });
			pendingDesc.current = undefined;
		}
	};
	useEffect(() => () => flushDesc());

	const link = () => {
		const url = new URL(
			`/work/t/${task.key}`,
			window.location.origin,
		).toString();
		void navigator.clipboard.writeText(url);
		toast.success("Link copied", { description: url });
	};
	useShortcut("mod+.", link);
	const expand = () => {
		flushDesc();
		void navigate({ to: "/work/t/$key", params: { key: task.key } });
	};
	useShortcut("f", expand, !page);
	useShortcut("t", () =>
		window.dispatchEvent(
			new CustomEvent("work:timer-toggle", { detail: { taskId: task.id } }),
		),
	);

	const canDelete =
		project.canAdmin ||
		(task.createdBy === myId &&
			Date.now() - new Date(task.createdAt).getTime() < 15 * 60_000);
	const branch = `${task.key.toLowerCase()}-${task.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)}`;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a file drop zone; the Attach button is the keyboard path.
		<div
			className="relative flex h-full min-h-0 flex-col"
			onDragOver={(e) => {
				if (!can || !e.dataTransfer.types.includes("Files")) return;
				if ((e.target as HTMLElement).closest(".ProseMirror")) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node))
					setDragging(false);
			}}
			onDrop={(e) => {
				if ((e.target as HTMLElement).closest(".ProseMirror")) return;
				e.preventDefault();
				setDragging(false);
				const files = [...e.dataTransfer.files];
				if (files.length) void uploadFiles(files);
			}}
		>
			{/* Header */}
			<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
				<nav
					aria-label="Task location"
					className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
				>
					<span className="truncate">{project.name}</span>
					<span aria-hidden className="max-sm:hidden">
						/
					</span>
					<span className="inline-flex min-w-0 items-center gap-1.5 max-sm:hidden">
						<ColorDot color={list?.color} />
						<span className="truncate">{list?.name}</span>
					</span>
					{task.parent && (
						<>
							<span aria-hidden>/</span>
							<button
								type="button"
								onClick={() => openTask(task.parent?.id ?? null)}
								className="truncate hover:text-foreground hover:underline"
							>
								{task.parent.key}
							</button>
						</>
					)}
				</nav>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<SaveState />
					{!page && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={expand}
							aria-label="Open as full page (F)"
							title="Open as full page (F)"
						>
							<Maximize2 />
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={link}
						aria-label={`Copy link to ${task.key} (⌘.)`}
					>
						<TaskKey value={task.key} />
						<Link2 data-icon="inline-end" className="text-muted-foreground" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-pressed={task.watching}
						aria-label={task.watching ? "Stop watching" : "Watch this task"}
						onClick={() =>
							myId &&
							watcher.mutate({ id: task.id, userId: myId, on: !task.watching })
						}
					>
						{task.watching ? <Eye className="text-info-text" /> : <EyeOff />}
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-sm" aria-label="More actions">
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-56">
							{can && (
								<DropdownMenuItem
									onSelect={() =>
										duplicate.mutate(
											{ id: task.id, input: {} },
											{
												onSuccess: (t) => {
													toast.success(`Duplicated as ${t.key}`);
													openTask(t.id);
												},
											},
										)
									}
								>
									<Copy /> Duplicate
								</DropdownMenuItem>
							)}
							{can && project.lists.length > 1 && (
								<DropdownMenuSub>
									<DropdownMenuSubTrigger>Move to list</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										{project.lists.map((l) => (
											<DropdownMenuItem
												key={l.id}
												disabled={l.id === task.listId}
												onSelect={() => void edits.move(task, { listId: l.id })}
											>
												<ColorDot color={l.color} /> {l.name}
											</DropdownMenuItem>
										))}
									</DropdownMenuSubContent>
								</DropdownMenuSub>
							)}
							{can && task.parentId && (
								<DropdownMenuItem
									onSelect={() => void edits.move(task, { parentId: null })}
								>
									Make it a top-level task
								</DropdownMenuItem>
							)}
							{project.canAdmin && (
								<DropdownMenuItem
									onSelect={() =>
										requestSaveAsTemplate({
											source: { kind: "task", taskId: task.id },
											projectId: project.id,
											defaultName: task.title,
										})
									}
								>
									Save as template…
								</DropdownMenuItem>
							)}
							{ops && (
								<DropdownMenuItem
									onSelect={() => {
										void navigator.clipboard.writeText(branch);
										toast.success("Branch name copied", {
											description: branch,
										});
									}}
								>
									<GitBranch /> Copy branch name
								</DropdownMenuItem>
							)}
							{can && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onSelect={() =>
											archive.mutate(
												{ id: task.id, archived: true },
												{
													onSuccess: () => {
														toast.success(`${task.key} archived`);
														onClose();
													},
												},
											)
										}
									>
										<Archive /> Archive
									</DropdownMenuItem>
								</>
							)}
							{canDelete && (
								<DropdownMenuItem
									variant="destructive"
									onSelect={() => setDeleting(true)}
								>
									<Trash2 /> Delete
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={page ? "Back" : "Close"}
						onClick={onClose}
					>
						<X />
					</Button>
				</div>
			</header>

			{conflict && (
				<div
					role="alert"
					className="flex flex-wrap items-center gap-2 border-b bg-warn/10 px-4 py-2.5 text-sm"
				>
					<p className="min-w-0 flex-1">
						<span className="font-medium">Someone else changed this task.</span>{" "}
						<span className="text-muted-foreground">
							Your edit: {conflict.mine.title ?? "the description"}
						</span>
					</p>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							qc.setQueryData(workKeys.task(task.id), conflict.theirs);
							setConflict(null);
						}}
					>
						Reload
					</Button>
					<Button
						size="sm"
						onClick={() => {
							save(conflict.mine, conflict.theirs.updatedAt);
							setConflict(null);
						}}
					>
						Overwrite
					</Button>
				</div>
			)}

			{/* Body: one scroll in the sheet; content and activity side by side on the page. */}
			{page ? (
				<div className="flex min-h-0 flex-1 max-xl:flex-col">
					<div ref={bodyRef} className="min-h-0 flex-1 xl:overflow-y-auto">
						<div className="mx-auto grid w-full max-w-3xl gap-8 px-6 pt-8 pb-16 lg:px-10">
							<div className="grid gap-5">
								<A11yTitle layout={layout}>
									<textarea
										ref={titleRef}
										rows={1}
										value={title}
										readOnly={!can}
										aria-label="Title"
										onChange={(e) =>
											setTitle(e.target.value.replace(/\n/g, ""))
										}
										onBlur={commitTitle}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												e.currentTarget.blur();
											}
											if (e.key === "Escape") {
												setTitle(task.title);
											}
										}}
										className={cn(
											"w-full resize-none overflow-hidden bg-transparent leading-snug font-semibold [font-stretch:108%] outline-none placeholder:text-muted-foreground",
											page ? "text-2xl" : "text-xl",
										)}
									/>
								</A11yTitle>
								<A11yDescription layout={layout} className="sr-only">
									{task.key} in {project.name}
								</A11yDescription>
								<Properties
									task={task}
									project={project}
									edits={edits}
									me={myId}
								/>
								{can && (
									<TaskAiActions
										taskId={task.id}
										onDraftComment={setCommentDraft}
										onDescription={(doc) => {
											const ed = descEditor.current;
											if (!ed) return;
											// Lands in the editor like typing, so the usual autosave keeps it. An existing
											// description stays: the draft goes below it, for the person to merge.
											if (ed.isEmpty)
												ed.chain()
													.setContent(doc, { emitUpdate: true })
													.focus("end")
													.run();
											else
												ed.chain()
													.focus("end")
													.insertContent(doc.content ?? [])
													.run();
										}}
										onCreateSubtasks={async (items) => {
											for (const s of items)
												await create.mutateAsync({
													listId: task.listId,
													parentId: task.id,
													title: s.title,
													estimateMinutes: s.estimateMinutes,
												});
											toast.success(
												`${items.length} subtask${items.length === 1 ? "" : "s"} created`,
											);
										}}
									/>
								)}
							</div>

							<section aria-label="Description" className="grid gap-2">
								<h3 className="text-sm font-semibold [font-stretch:100%]">
									Description
								</h3>
								<div
									className={cn(
										"-mx-2 rounded-lg px-2 py-1.5 transition-colors duration-(--duration-quick)",
										can &&
											"hover:bg-muted/40 focus-within:bg-transparent focus-within:ring-1 focus-within:ring-input",
									)}
								>
									<RichEditor
										value={task.description}
										editable={can}
										people={project.people}
										projectId={project.id}
										placeholder="Add a description. Paste screenshots, @mention people, # link tasks."
										editorRef={setDescEditor}
										onChange={(doc) => {
											pendingDesc.current = doc;
											clearTimeout(descTimer.current);
											descTimer.current = setTimeout(flushDesc, 800);
										}}
										onUpload={(file) =>
											api.work.attachments.upload({
												file,
												taskId: task.id,
												inline: "description",
											})
										}
									/>
									{!can && !task.description && (
										<p className="text-sm text-muted-foreground">
											No description.
										</p>
									)}
								</div>
							</section>

							<Subtasks
								task={task}
								project={project}
								edits={edits}
								onCreate={(title) =>
									create.mutateAsync({
										listId: task.listId,
										parentId: task.id,
										title,
									})
								}
							/>
							<Checklist task={task} project={project} me={myId} />
							<Dependencies task={task} project={project} />
							<TaskDevelopmentSection
								projectId={project.id}
								taskKey={task.key}
								title={task.title}
								git={task.git}
							/>
							<Attachments task={task} project={project} />
						</div>
					</div>
					<aside
						aria-label="Activity"
						className="flex min-h-0 flex-col border-t bg-muted/20 max-xl:min-h-[480px] xl:w-[420px] xl:border-t-0 xl:border-l 2xl:w-[480px]"
					>
						<div
							ref={activityRef}
							className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-6"
						>
							<Activity taskId={task.id} project={project} me={myId} />
						</div>
						<div className="shrink-0 border-t bg-popover px-5 py-3">
							<Composer
								taskId={task.id}
								project={project}
								draft={commentDraft}
								onSent={() =>
									requestAnimationFrame(() =>
										activityRef.current?.scrollTo({
											top: activityRef.current.scrollHeight,
											behavior: "smooth",
										}),
									)
								}
							/>
						</div>
					</aside>
				</div>
			) : (
				<>
					<div
						ref={(el) => {
							bodyRef.current = el;
							activityRef.current = el;
						}}
						className="min-h-0 flex-1 overflow-y-auto"
					>
						<div className="grid gap-8 px-6 pt-5 pb-10">
							<div className="grid gap-5">
								<A11yTitle layout={layout}>
									<textarea
										ref={titleRef}
										rows={1}
										value={title}
										readOnly={!can}
										aria-label="Title"
										onChange={(e) =>
											setTitle(e.target.value.replace(/\n/g, ""))
										}
										onBlur={commitTitle}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												e.currentTarget.blur();
											}
											if (e.key === "Escape") {
												setTitle(task.title);
											}
										}}
										className={cn(
											"w-full resize-none overflow-hidden bg-transparent leading-snug font-semibold [font-stretch:108%] outline-none placeholder:text-muted-foreground",
											page ? "text-2xl" : "text-xl",
										)}
									/>
								</A11yTitle>
								<A11yDescription layout={layout} className="sr-only">
									{task.key} in {project.name}
								</A11yDescription>
								<Properties
									task={task}
									project={project}
									edits={edits}
									me={myId}
								/>
								{can && (
									<TaskAiActions
										taskId={task.id}
										onDraftComment={setCommentDraft}
										onDescription={(doc) => {
											const ed = descEditor.current;
											if (!ed) return;
											// Lands in the editor like typing, so the usual autosave keeps it. An existing
											// description stays: the draft goes below it, for the person to merge.
											if (ed.isEmpty)
												ed.chain()
													.setContent(doc, { emitUpdate: true })
													.focus("end")
													.run();
											else
												ed.chain()
													.focus("end")
													.insertContent(doc.content ?? [])
													.run();
										}}
										onCreateSubtasks={async (items) => {
											for (const s of items)
												await create.mutateAsync({
													listId: task.listId,
													parentId: task.id,
													title: s.title,
													estimateMinutes: s.estimateMinutes,
												});
											toast.success(
												`${items.length} subtask${items.length === 1 ? "" : "s"} created`,
											);
										}}
									/>
								)}
							</div>

							<section aria-label="Description" className="grid gap-2">
								<h3 className="text-sm font-semibold [font-stretch:100%]">
									Description
								</h3>
								<div
									className={cn(
										"-mx-2 rounded-lg px-2 py-1.5 transition-colors duration-(--duration-quick)",
										can &&
											"hover:bg-muted/40 focus-within:bg-transparent focus-within:ring-1 focus-within:ring-input",
									)}
								>
									<RichEditor
										value={task.description}
										editable={can}
										people={project.people}
										projectId={project.id}
										placeholder="Add a description. Paste screenshots, @mention people, # link tasks."
										editorRef={setDescEditor}
										onChange={(doc) => {
											pendingDesc.current = doc;
											clearTimeout(descTimer.current);
											descTimer.current = setTimeout(flushDesc, 800);
										}}
										onUpload={(file) =>
											api.work.attachments.upload({
												file,
												taskId: task.id,
												inline: "description",
											})
										}
									/>
									{!can && !task.description && (
										<p className="text-sm text-muted-foreground">
											No description.
										</p>
									)}
								</div>
							</section>

							<Subtasks
								task={task}
								project={project}
								edits={edits}
								onCreate={(title) =>
									create.mutateAsync({
										listId: task.listId,
										parentId: task.id,
										title,
									})
								}
							/>
							<Checklist task={task} project={project} me={myId} />
							<Dependencies task={task} project={project} />
							<TaskDevelopmentSection
								projectId={project.id}
								taskKey={task.key}
								title={task.title}
								git={task.git}
							/>
							<Attachments task={task} project={project} />
							<Activity taskId={task.id} project={project} me={myId} />
						</div>
					</div>
					<div className="shrink-0 border-t bg-popover px-6 py-3">
						<Composer
							taskId={task.id}
							project={project}
							draft={commentDraft}
							onSent={() =>
								requestAnimationFrame(() =>
									activityRef.current?.scrollTo({
										top: activityRef.current.scrollHeight,
										behavior: "smooth",
									}),
								)
							}
						/>
					</div>
				</>
			)}

			{dragging && (
				<div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-brand/60 bg-background/80 backdrop-blur-[2px]">
					<p className="flex items-center gap-2 text-sm font-medium">
						<Paperclip className="size-4" aria-hidden /> Drop to attach to{" "}
						{task.key}
					</p>
				</div>
			)}

			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${task.key}?`}
				description="Its subtasks, comments and attachments go too. This can't be undone; archive keeps everything."
				confirmLabel="Delete task"
				pending={del.isPending}
				onConfirm={() =>
					del.mutate(task.id, {
						onSuccess: () => {
							toast.success(`${task.key} deleted`);
							setDeleting(false);
							onClose();
						},
						onError: (e) =>
							toast.error(`${task.key} wasn't deleted`, {
								description: e instanceof Error ? e.message : undefined,
							}),
					})
				}
			/>
		</div>
	);
}
