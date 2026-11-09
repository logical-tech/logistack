import type { PmDoc } from "@logistack/contracts";
import { formatDuration } from "@logistack/core/work";
import { ListTree, MessageSquareText, PenLine, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Me } from "@/lib/api";
import { useMe } from "@/lib/api/access";
import {
	useWorkAiDescription,
	useWorkAiSubtasks,
	useWorkAiSummarise,
} from "@/lib/api/work-queries";

export type AiSubtaskDraft = { title: string; estimateMinutes: number | null };

const BUILTIN_WITHOUT_AI = new Set([
	"developer",
	"viewer",
	"manager",
	"guest",
	"member",
]);
/**
 * Owners and admins hold `ai`; a custom role might. `/api/me` names roles, not actions, so
 * shortcut: custom roles see the buttons and a 403 shows as a toast; expose actions on /me to tighten this.
 */
const mayUseAi = (me: Me | undefined) =>
	!!me &&
	(me.keyScopes ?? me.grants).some(
		(g) => g.scope.kind === "organization" && !BUILTIN_WITHOUT_AI.has(g.role),
	);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The task sheet's three AI buttons. Each produces a draft; nothing is saved without the caller. */
export function TaskAiActions({
	taskId,
	onDraftComment,
	onDescription,
	onCreateSubtasks,
}: {
	taskId: string;
	/** Put the summary in the comment composer for the user to edit and send. */
	onDraftComment: (doc: PmDoc) => void;
	/** Insert a draft description into the editor. */
	onDescription: (doc: PmDoc) => void;
	/** Create the ticked subtasks, in order. */
	onCreateSubtasks: (items: AiSubtaskDraft[]) => void | Promise<void>;
}) {
	const { data: me } = useMe();
	const summarise = useWorkAiSummarise();
	const subtasks = useWorkAiSubtasks();
	const describe = useWorkAiDescription();
	const [review, setReview] = useState<
		(AiSubtaskDraft & { on: boolean; key: number })[] | null
	>(null);
	const [creating, setCreating] = useState(false);
	if (!mayUseAi(me)) return null;
	const onError = (e: unknown) => toast.error(errorText(e));

	return (
		<div className="flex flex-wrap items-center gap-1">
			<Sparkles className="mr-1 size-3.5 text-muted-foreground" aria-hidden />
			<Button
				type="button"
				size="sm"
				variant="ghost"
				disabled={summarise.isPending}
				onClick={() =>
					summarise.mutate(taskId, {
						onSuccess: (r) => onDraftComment(r.draft),
						onError,
					})
				}
			>
				<MessageSquareText data-icon="inline-start" />
				{summarise.isPending ? "Summarising…" : "Summarise thread"}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				disabled={subtasks.isPending}
				onClick={() =>
					subtasks.mutate(taskId, {
						onSuccess: (r) =>
							setReview(r.subtasks.map((s, key) => ({ ...s, on: true, key }))),
						onError,
					})
				}
			>
				<ListTree data-icon="inline-start" />
				{subtasks.isPending ? "Thinking…" : "Break into subtasks"}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				disabled={describe.isPending}
				onClick={() =>
					describe.mutate(taskId, {
						onSuccess: (r) => onDescription(r.description),
						onError,
					})
				}
			>
				<PenLine data-icon="inline-start" />
				{describe.isPending ? "Writing…" : "Write description"}
			</Button>

			<Dialog
				open={review !== null}
				onOpenChange={(o) => !o && setReview(null)}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Proposed subtasks</DialogTitle>
						<DialogDescription>
							Untick what you don't need and edit titles before creating them.
						</DialogDescription>
					</DialogHeader>
					<ul className="grid gap-1.5">
						{review?.map((s, i) => (
							<li key={s.key} className="flex items-center gap-2">
								<Checkbox
									checked={s.on}
									aria-label={`Include ${s.title}`}
									onCheckedChange={(v) =>
										setReview((r) =>
											r
												? r.map((x, j) =>
														j === i ? { ...x, on: v === true } : x,
													)
												: r,
										)
									}
								/>
								<Input
									value={s.title}
									aria-label={`Subtask ${i + 1} title`}
									maxLength={500}
									disabled={!s.on}
									onChange={(e) =>
										setReview((r) =>
											r
												? r.map((x, j) =>
														j === i ? { ...x, title: e.target.value } : x,
													)
												: r,
										)
									}
								/>
								<span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular">
									{s.estimateMinutes
										? formatDuration(s.estimateMinutes * 60)
										: ""}
								</span>
							</li>
						))}
					</ul>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setReview(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							disabled={
								creating || !review?.some((s) => s.on && s.title.trim())
							}
							onClick={async () => {
								const picked = (review ?? [])
									.filter((s) => s.on && s.title.trim())
									.map(({ title, estimateMinutes }) => ({
										title: title.trim(),
										estimateMinutes,
									}));
								setCreating(true);
								try {
									await onCreateSubtasks(picked);
									setReview(null);
								} catch (e) {
									onError(e);
								} finally {
									setCreating(false);
								}
							}}
						>
							Create {review?.filter((s) => s.on).length ?? 0} subtasks
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
