import type { ColumnKey, WorkTaskListItem } from "@logistack/contracts";
import { formatFieldValue } from "@logistack/core/work";
import { Ban, CalendarDays, Flag, MessageSquare, Repeat } from "lucide-react";
import { useWorkTask } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { WORK_DOT } from "../common/colors";
import {
	isClosedTask,
	type ProjectMeta,
	shortDate,
	taskProgress,
} from "../common/data";
import { AvatarStack } from "../common/people";
import { PRIORITY_LABEL } from "./groups";

const PRIORITY_TONE = {
	urgent: "text-bad-text",
	high: "text-warn-text",
	normal: "text-info-text",
	low: "text-idle-text",
	none: "",
} as const;

/** Card fields already on every card. */
const BUILT_IN = new Set<ColumnKey>([
	"key",
	"title",
	"assignees",
	"dueDate",
	"priority",
]);

export function TaskCard({
	task: t,
	meta,
	cardFields,
	today,
	dragging,
}: {
	task: WorkTaskListItem;
	meta: ProjectMeta;
	cardFields: readonly ColumnKey[];
	today: string;
	dragging?: boolean;
}) {
	const closed = isClosedTask(meta, t);
	const overdue = !!t.dueDate && t.dueDate < today && !closed;
	const progress = taskProgress(t);
	const c = t.counts;
	const extra = cardFields.filter((k) => !BUILT_IN.has(k));
	return (
		<div
			className={cn(
				"group/card relative overflow-hidden rounded-lg bg-card text-left ring-1 ring-border transition-[box-shadow,opacity] duration-(--duration-quick)",
				"shadow-card hover:ring-foreground/15",
				dragging && "shadow-float ring-foreground/20",
				closed && "opacity-70",
			)}
		>
			{!!c?.attachments && <CardCover taskId={t.id} />}
			<div className="flex flex-col gap-2 p-3">
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<span className="font-mono tabular">{t.key}</span>
					{t.blocked && (
						<span
							className="inline-flex items-center gap-0.5 text-bad-text"
							title="Blocked by an open task"
						>
							<Ban className="size-3" aria-hidden />
							<span className="sr-only">Blocked</span>
						</span>
					)}
					{t.recurring && (
						<Repeat
							className="size-3"
							aria-label="Repeats"
							strokeWidth={1.75}
						/>
					)}
					{t.priority !== "none" && (
						<span
							className={cn(
								"ml-auto inline-flex items-center",
								PRIORITY_TONE[t.priority],
							)}
							title={`${PRIORITY_LABEL[t.priority]} priority`}
						>
							<Flag
								className="size-3"
								strokeWidth={2}
								fill={t.priority === "urgent" ? "currentColor" : "none"}
								aria-hidden
							/>
							<span className="sr-only">{PRIORITY_LABEL[t.priority]}</span>
						</span>
					)}
				</div>
				<p
					className={cn(
						"line-clamp-3 text-sm leading-snug font-medium text-pretty",
						closed && "text-muted-foreground line-through decoration-1",
					)}
				>
					{t.title}
				</p>
				{extra.length > 0 && (
					<div className="flex flex-wrap gap-1">
						{extra.map((k) => (
							<CardField key={k} field={k} task={t} meta={meta} />
						))}
					</div>
				)}
				{(t.dueDate ||
					progress !== null ||
					!!c?.comments ||
					!!t.assigneeIds?.length) && (
					<div className="flex min-h-5 items-center gap-3 text-xs text-muted-foreground">
						{t.dueDate && (
							<span
								className={cn(
									"inline-flex items-center gap-1 tabular",
									overdue && "font-medium text-bad-text",
								)}
							>
								<CalendarDays
									className="size-3"
									strokeWidth={1.75}
									aria-hidden
								/>
								<span className="sr-only">
									{overdue ? "Overdue, due" : "Due"}
								</span>
								{shortDate(t.dueDate)}
								{t.dueTime && ` ${t.dueTime}`}
							</span>
						)}
						{progress !== null && c && (
							<span
								className="inline-flex items-center gap-1.5 tabular"
								title="Subtasks and checklist done"
							>
								<span className="relative h-1 w-8 overflow-hidden rounded-full bg-muted">
									<span
										className="absolute inset-y-0 left-0 rounded-full bg-ok"
										style={{ width: `${Math.round(progress * 100)}%` }}
									/>
								</span>
								{c.subtasksDone + c.checklistDone}/{c.subtasks + c.checklist}
							</span>
						)}
						{!!c?.comments && (
							<span className="inline-flex items-center gap-1 tabular">
								<MessageSquare
									className="size-3"
									strokeWidth={1.75}
									aria-hidden
								/>
								{c.comments}
								<span className="sr-only">comments</span>
							</span>
						)}
						<AvatarStack
							ids={t.assigneeIds ?? []}
							people={meta.personById}
							className="ml-auto"
						/>
					</div>
				)}
			</div>
		</div>
	);
}

/** First image attachment, read from the task detail (list rows carry only counts). */
function CardCover({ taskId }: { taskId: string }) {
	const img = useWorkTask(taskId).data?.attachments.find((a) =>
		a.contentType.startsWith("image/"),
	);
	if (!img) return null;
	return (
		<img
			src={img.thumbUrl ?? img.url}
			alt=""
			loading="lazy"
			className="aspect-[16/8] w-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
			onError={(e) => {
				e.currentTarget.style.display = "none";
			}}
		/>
	);
}

const chip =
	"inline-flex max-w-full items-center gap-1 truncate rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground";

function CardField({
	field,
	task: t,
	meta,
}: {
	field: ColumnKey;
	task: WorkTaskListItem;
	meta: ProjectMeta;
}) {
	switch (field) {
		case "status": {
			const s = meta.statusById.get(t.statusId);
			return s ? (
				<span className={chip}>
					<span className={cn("size-1.5 rounded-full", WORK_DOT[s.color])} />
					{s.name}
				</span>
			) : null;
		}
		case "tags":
			return (
				<>
					{(t.tagIds ?? []).map((id) => {
						const tag = meta.tags.find((x) => x.id === id);
						return tag ? (
							<span key={id} className={chip}>
								<span
									className={cn("size-1.5 rounded-full", WORK_DOT[tag.color])}
								/>
								{tag.name}
							</span>
						) : null;
					})}
				</>
			);
		case "list": {
			const l = meta.lists.find((x) => x.id === t.listId);
			return l ? <span className={chip}>{l.name}</span> : null;
		}
		case "startDate":
			return t.startDate ? (
				<span className={cn(chip, "tabular")}>
					Starts {shortDate(t.startDate)}
				</span>
			) : null;
		case "estimate":
			return t.estimateMinutes ? (
				<span className={cn(chip, "tabular")}>
					{formatMinutes(t.estimateMinutes)} est.
				</span>
			) : null;
		case "tracked":
			return t.trackedSec ? (
				<span className={cn(chip, "tabular")}>
					{formatMinutes(Math.round(t.trackedSec / 60))} tracked
				</span>
			) : null;
		case "createdAt":
		case "updatedAt":
			return (
				<span className={cn(chip, "tabular")}>
					{field === "createdAt" ? "Created" : "Updated"}{" "}
					{shortDate(t[field].slice(0, 10))}
				</span>
			);
		default: {
			if (!field.startsWith("field:")) return null;
			const def = meta.fields.find((f) => f.id === field.slice(6));
			const raw = t.fields?.[field.slice(6)];
			if (!def || raw === null || raw === undefined) return null;
			const names = Object.fromEntries(
				meta.people.map((p) => [p.userId, p.name]),
			);
			const text = formatFieldValue(def, raw, "en", names);
			return text ? (
				<span className={chip} title={def.name}>
					<span className="text-muted-foreground/70">{def.name}</span>
					<span className="truncate text-foreground/80">{text}</span>
				</span>
			) : null;
		}
	}
}

export function formatMinutes(m: number) {
	const h = Math.floor(m / 60);
	const r = m % 60;
	return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}
