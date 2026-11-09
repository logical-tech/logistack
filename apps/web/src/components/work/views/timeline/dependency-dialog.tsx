import type { WorkTaskListItem } from "@logistack/contracts";
import { type DepEdge, wouldCycle } from "@logistack/core/work";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	useAddWorkDependency,
	useRemoveWorkDependency,
} from "@/lib/api/work-queries";

/** ⌘D on a bar: pick what blocks it, or remove an existing blocker. Keyboard twin of connector drags. */
export function DependencyDialog({
	task,
	tasks,
	edges,
	onClose,
}: {
	task: WorkTaskListItem | null;
	tasks: readonly WorkTaskListItem[];
	edges: readonly DepEdge[];
	onClose: () => void;
}) {
	const add = useAddWorkDependency();
	const remove = useRemoveWorkDependency();
	const blockers = task
		? edges
				.filter((e) => e.taskId === task.id)
				.map((e) => tasks.find((t) => t.id === e.blockedById))
				.filter((t): t is WorkTaskListItem => !!t)
		: [];
	const candidates = task
		? tasks.filter(
				(t) =>
					t.id !== task.id &&
					!blockers.some((b) => b.id === t.id) &&
					!wouldCycle(edges, task.id, t.id),
			)
		: [];
	return (
		<CommandDialog
			open={!!task}
			onOpenChange={(o) => !o && onClose()}
			title={task ? `What blocks ${task.key}?` : "Dependencies"}
			description="Pick a task that has to finish first."
		>
			<Command>
				<CommandInput placeholder={task ? `${task.key} is blocked by…` : ""} />
				<CommandList>
					<CommandEmpty>No task matches.</CommandEmpty>
					{blockers.length > 0 && (
						<CommandGroup heading="Blocked by (Enter removes)">
							{blockers.map((b) => (
								<CommandItem
									key={b.id}
									value={`remove ${b.key} ${b.title}`}
									onSelect={() =>
										task &&
										remove.mutate(
											{ id: task.id, blockedById: b.id },
											{
												onSuccess: () =>
													toast.success(
														`${b.key} no longer blocks ${task.key}`,
													),
												onError: (e) =>
													toast.error("Couldn't remove it", {
														description: e.message,
													}),
											},
										)
									}
								>
									<span className="font-mono text-xs text-muted-foreground tabular">
										{b.key}
									</span>
									<span className="truncate">{b.title}</span>
									<X
										className="ml-auto text-muted-foreground"
										aria-label="Remove"
									/>
								</CommandItem>
							))}
						</CommandGroup>
					)}
					<CommandGroup heading="Add a blocker">
						{candidates.map((c) => (
							<CommandItem
								key={c.id}
								value={`${c.key} ${c.title}`}
								onSelect={() => {
									if (!task) return;
									add.mutate(
										{ id: task.id, input: { blockedById: c.id } },
										{
											onSuccess: () =>
												toast.success(`${c.key} now blocks ${task.key}`),
											onError: (e) =>
												toast.error("Couldn't add it", {
													description: e.message,
												}),
										},
									);
									onClose();
								}}
							>
								<span className="font-mono text-xs text-muted-foreground tabular">
									{c.key}
								</span>
								<span className="truncate">{c.title}</span>
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
		</CommandDialog>
	);
}
