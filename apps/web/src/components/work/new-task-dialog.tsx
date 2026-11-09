/* "New task" from anywhere (`c` outside a project view, or the command palette). */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	useCreateWorkTask,
	useWorkLists,
	useWorkProjects,
} from "@/lib/api/work-queries";
import { useOpenTask } from "./task-sheet/open-task";

export function NewTaskDialog({
	open,
	onOpenChange,
	projectId: initialProject,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	projectId?: string;
}) {
	const { data: projects = [] } = useWorkProjects();
	const live = projects.filter((p) => !p.archived);
	const [projectId, setProjectId] = useState(initialProject ?? "");
	const pid = projectId || live[0]?.id || "";
	const { data: lists = [] } = useWorkLists(pid);
	const [listId, setListId] = useState("");
	const lid = lists.some((l) => l.id === listId)
		? listId
		: (lists[0]?.id ?? "");
	const [title, setTitle] = useState("");
	const create = useCreateWorkTask();
	const openTask = useOpenTask();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form
					className="grid gap-4"
					onSubmit={async (e) => {
						e.preventDefault();
						if (!title.trim() || !lid) return;
						try {
							const t = await create.mutateAsync({
								listId: lid,
								title: title.trim(),
							});
							toast.success(`${t.key} created`);
							setTitle("");
							onOpenChange(false);
							openTask(t.id);
						} catch (err) {
							toast.error("The task wasn't created", {
								description: err instanceof Error ? err.message : undefined,
							});
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>New task</DialogTitle>
						<DialogDescription>
							It opens right away so you can add details.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-1.5">
						<Label htmlFor="new-task-title">Title</Label>
						<Input
							id="new-task-title"
							autoFocus
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="What needs doing?"
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="grid gap-1.5">
							<Label>Project</Label>
							<Select value={pid} onValueChange={setProjectId}>
								<SelectTrigger aria-label="Project" className="w-full">
									<SelectValue placeholder="Project" />
								</SelectTrigger>
								<SelectContent>
									{live.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-1.5">
							<Label>List</Label>
							<Select value={lid} onValueChange={setListId}>
								<SelectTrigger aria-label="List" className="w-full">
									<SelectValue placeholder="List" />
								</SelectTrigger>
								<SelectContent>
									{lists
										.filter((l) => !l.archivedAt)
										.map((l) => (
											<SelectItem key={l.id} value={l.id}>
												{l.name}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!title.trim() || !lid || create.isPending}
						>
							Create task
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
