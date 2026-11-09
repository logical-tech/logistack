/*
 * Statuses: drag to reorder, rename in place, colour token, category, WIP limit, and delete with
 * a move-to target (the last backlog and the last done status are protected, as in core).
 */
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
	WorkColor,
	WorkStatus,
	WorkStatusCategory,
} from "@logistack/contracts";
import { canDeleteStatus } from "@logistack/core/work";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	useCreateWorkStatus,
	useDeleteWorkStatus,
	useReorderWorkStatuses,
	useUpdateWorkStatus,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { WORK_COLORS, wc } from "../lib";
import { StatusIcon } from "../parts";

const CATEGORY: { id: WorkStatusCategory; label: string }[] = [
	{ id: "backlog", label: "Not started" },
	{ id: "active", label: "Active" },
	{ id: "done", label: "Done" },
	{ id: "cancelled", label: "Cancelled" },
];

const errorToast = (what: string) => (e: unknown) =>
	toast.error(what, {
		description: e instanceof Error ? e.message : undefined,
	});

export function ColorPicker({
	value,
	onChange,
	label,
}: {
	value: WorkColor;
	onChange: (c: WorkColor) => void;
	label: string;
}) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`${label}: ${value}. Change colour`}
					style={wc(value)}
					className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-muted"
				>
					<span className="size-3 rounded-full bg-(--wc)" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-auto p-1.5">
				<div
					role="radiogroup"
					aria-label="Colour"
					className="grid grid-cols-4 gap-1"
				>
					{WORK_COLORS.map((c) => (
						// biome-ignore lint/a11y/useSemanticElements: swatches, a native radio can't draw them.
						<button
							key={c}
							type="button"
							role="radio"
							aria-checked={c === value}
							aria-label={c}
							style={wc(c)}
							onClick={() => onChange(c)}
							className={cn(
								"grid size-8 place-items-center rounded-md hover:bg-muted",
								c === value && "ring-2 ring-ring",
							)}
						>
							<span className="size-4 rounded-full bg-(--wc)" />
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function StatusRow({
	status,
	statuses,
	projectId,
	onDelete,
}: {
	status: WorkStatus;
	statuses: WorkStatus[];
	projectId: string;
	onDelete: () => void;
}) {
	const update = useUpdateWorkStatus();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: status.id });
	const [name, setName] = useState(status.name);
	const set = (patch: Parameters<typeof update.mutate>[0]["patch"]) =>
		update.mutate(
			{ projectId, id: status.id, patch },
			{ onError: errorToast("The status wasn't saved") },
		);
	const deletable = canDeleteStatus(statuses, status.id);
	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className={cn(
				"flex flex-wrap items-center gap-2 px-3 py-2",
				isDragging && "relative z-10 rounded-md bg-card shadow-float",
			)}
		>
			<button
				type="button"
				aria-label={`Reorder ${status.name}`}
				className="grid size-6 cursor-grab place-items-center rounded-sm text-muted-foreground/60 hover:text-foreground"
				{...attributes}
				{...listeners}
			>
				<GripVertical className="size-4" />
			</button>
			<StatusIcon status={status} />
			<ColorPicker
				value={status.color}
				onChange={(color) => set({ color })}
				label={status.name}
			/>
			<Input
				aria-label="Status name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				onBlur={() => {
					const n = name.trim();
					if (!n) setName(status.name);
					else if (n !== status.name) set({ name: n });
				}}
				onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
				className="h-8 w-44"
			/>
			<Select
				value={status.category}
				onValueChange={(v) => set({ category: v as WorkStatusCategory })}
			>
				<SelectTrigger size="sm" aria-label="Category" className="w-32">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{CATEGORY.map((c) => (
						<SelectItem key={c.id} value={c.id}>
							{c.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Input
				type="number"
				min={1}
				aria-label="Work-in-progress limit"
				placeholder="No limit"
				defaultValue={status.wipLimit ?? ""}
				onBlur={(e) => {
					const v = e.target.value ? Number(e.target.value) : null;
					if (v !== status.wipLimit) set({ wipLimit: v });
				}}
				className="h-8 w-24"
			/>
			<Button
				variant="ghost"
				size="icon-sm"
				className="ml-auto text-muted-foreground"
				aria-label={`Delete ${status.name}`}
				title={deletable.ok ? undefined : `Can't delete: ${deletable.reason}`}
				disabled={!deletable.ok}
				onClick={onDelete}
			>
				<Trash2 />
			</Button>
		</li>
	);
}

export function StatusEditor({
	projectId,
	statuses,
}: {
	projectId: string;
	statuses: WorkStatus[];
}) {
	const reorder = useReorderWorkStatuses();
	const create = useCreateWorkStatus();
	const remove = useDeleteWorkStatus();
	const [deleting, setDeleting] = useState<WorkStatus | null>(null);
	const [moveTo, setMoveTo] = useState<string>("");
	const [order, setOrder] = useState<string[] | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
	const ordered = order
		? order.flatMap((id) => statuses.filter((s) => s.id === id))
		: statuses;
	const onDragEnd = (e: DragEndEvent) => {
		if (!e.over || e.active.id === e.over.id) return;
		const ids = ordered.map((s) => s.id);
		const next = arrayMove(
			ids,
			ids.indexOf(String(e.active.id)),
			ids.indexOf(String(e.over.id)),
		);
		setOrder(next);
		reorder.mutate(
			{ projectId, ids: next },
			{
				onSettled: () => setOrder(null),
				onError: errorToast("The order wasn't saved"),
			},
		);
	};
	return (
		<>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={onDragEnd}
			>
				<SortableContext
					items={ordered.map((s) => s.id)}
					strategy={verticalListSortingStrategy}
				>
					<ul className="divide-y">
						{ordered.map((s) => (
							<StatusRow
								key={s.id}
								status={s}
								statuses={statuses}
								projectId={projectId}
								onDelete={() => {
									setDeleting(s);
									setMoveTo(
										statuses.find(
											(x) => x.id !== s.id && x.category === s.category,
										)?.id ??
											statuses.find((x) => x.id !== s.id)?.id ??
											"",
									);
								}}
							/>
						))}
					</ul>
				</SortableContext>
			</DndContext>
			<div className="border-t px-3 py-2">
				<Button
					variant="ghost"
					size="sm"
					disabled={statuses.length >= 30 || create.isPending}
					onClick={() =>
						create.mutate(
							{
								projectId,
								input: {
									name: `New status ${statuses.length + 1}`,
									color: WORK_COLORS[
										statuses.length % WORK_COLORS.length
									] as WorkColor,
									category: "active",
								},
							},
							{ onError: errorToast("The status wasn't added") },
						)
					}
				>
					<Plus data-icon="inline-start" /> Add status
				</Button>
			</div>
			<ConfirmDialog
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete “${deleting?.name}”?`}
				description="Its tasks move to the status you pick. Nothing else changes."
				confirmLabel="Delete status"
				confirmDisabled={!moveTo}
				pending={remove.isPending}
				onConfirm={() =>
					deleting &&
					remove.mutate(
						{ projectId, id: deleting.id, moveTo },
						{
							onSuccess: () => setDeleting(null),
							onError: errorToast("The status wasn't deleted"),
						},
					)
				}
			>
				<div className="grid gap-1.5">
					<span className="text-sm text-muted-foreground">
						Move its tasks to
					</span>
					<Select value={moveTo} onValueChange={setMoveTo}>
						<SelectTrigger aria-label="Move tasks to" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{statuses
								.filter((s) => s.id !== deleting?.id)
								.map((s) => (
									<SelectItem key={s.id} value={s.id}>
										<StatusIcon status={s} /> {s.name}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
			</ConfirmDialog>
		</>
	);
}
