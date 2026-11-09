import type { WorkTaskListItem } from "@logistack/contracts";
import type { DepEdge } from "@logistack/core/work";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { type ProjectMeta, shortDate } from "../common/data";
import type { TimelineRow } from "./layout";

/** The timeline's rows as a plain table, for screen readers and for reading exact dates. */
export function ListEquivalentDialog({
	open,
	onOpenChange,
	rows,
	unscheduled,
	edges,
	meta,
	onOpenTask,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	rows: readonly TimelineRow[];
	unscheduled: readonly WorkTaskListItem[];
	edges: readonly DepEdge[];
	meta: ProjectMeta;
	onOpenTask: (id: string) => void;
}) {
	const keyOf = new Map(
		rows.flatMap((r) => (r.kind === "task" ? [[r.task.id, r.task.key]] : [])),
	);
	const tasks = [
		...rows.flatMap((r) => (r.kind === "task" ? [r] : [])),
		...unscheduled.map((task) => ({ task, depth: 0 })),
	];
	const seen = new Set<string>();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-4xl">
				<DialogHeader>
					<DialogTitle>Timeline as a list</DialogTitle>
					<DialogDescription>
						The same tasks, with their dates and what blocks them.
					</DialogDescription>
				</DialogHeader>
				<div className="-mx-6 max-h-[65vh] overflow-auto px-6">
					<table className="w-full text-sm">
						<thead className="sticky top-0 bg-popover text-left text-xs text-muted-foreground">
							<tr>
								<th className="py-2 pr-3 font-medium">Task</th>
								<th className="py-2 pr-3 font-medium">Status</th>
								<th className="py-2 pr-3 font-medium">Start</th>
								<th className="py-2 pr-3 font-medium">Due</th>
								<th className="py-2 font-medium">Blocked by</th>
							</tr>
						</thead>
						<tbody>
							{tasks.map(({ task: t, depth }) => {
								if (seen.has(t.id)) return null;
								seen.add(t.id);
								const blockers = edges
									.filter((e) => e.taskId === t.id)
									.map((e) => keyOf.get(e.blockedById) ?? "another task");
								return (
									<tr key={t.id} className="border-t border-border/70">
										<td
											className="py-2 pr-3"
											style={{ paddingLeft: depth * 16 }}
										>
											<button
												type="button"
												onClick={() => onOpenTask(t.id)}
												className="text-left hover:underline focus-visible:underline focus-visible:outline-none"
											>
												<span className="mr-2 font-mono text-xs text-muted-foreground tabular">
													{t.key}
												</span>
												{t.title}
												{t.isMilestone && (
													<span className="ml-1.5 text-xs text-muted-foreground">
														(milestone)
													</span>
												)}
											</button>
										</td>
										<td className="py-2 pr-3 whitespace-nowrap">
											{meta.statusById.get(t.statusId)?.name}
										</td>
										<td className="py-2 pr-3 whitespace-nowrap tabular">
											{t.startDate ? shortDate(t.startDate) : "–"}
										</td>
										<td className="py-2 pr-3 whitespace-nowrap tabular">
											{t.dueDate ? shortDate(t.dueDate) : "–"}
										</td>
										<td className="py-2 text-muted-foreground">
											{blockers.join(", ") || "–"}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</DialogContent>
		</Dialog>
	);
}
