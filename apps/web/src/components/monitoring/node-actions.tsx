import { useNavigate } from "@tanstack/react-router";
import { Loader2, Pause, Play, Tags, Trash2 } from "lucide-react";
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
import { useRemoveNode, useUpdateNode } from "@/lib/api/monitoring";
import type { ClusterNode } from "@/lib/api/types";
import { LabelEditor } from "./label-editor";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function LabelsDialog({
	node,
	open,
	onOpenChange,
}: {
	node: ClusterNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [labels, setLabels] = useState(node.labels);
	const update = useUpdateNode(node.id);
	const changed = JSON.stringify(labels) !== JSON.stringify(node.labels);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (o) setLabels(node.labels);
				onOpenChange(o);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Labels on {node.hostname}</DialogTitle>
					<DialogDescription>
						Swarm places services by node labels. Changing them can move running
						tasks to or from this node.
					</DialogDescription>
				</DialogHeader>
				<LabelEditor value={labels} onChange={setLabels} />
				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!changed || update.isPending}
						onClick={() =>
							update.mutate(
								{ labels },
								{
									onSuccess: () => {
										toast.success(`Labels saved on ${node.hostname}`);
										onOpenChange(false);
									},
									onError: (e) =>
										toast.error("Couldn't save labels", {
											description: errorText(e),
										}),
								},
							)
						}
					>
						{update.isPending && <Loader2 className="animate-spin" />}
						Save labels
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RemoveDialog({
	node,
	open,
	onOpenChange,
}: {
	node: ClusterNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const remove = useRemoveNode(node.id);
	const navigate = useNavigate();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Remove {node.hostname}?</DialogTitle>
					<DialogDescription>
						LogiStack takes the node out in three steps, and you can follow them
						on this page.
					</DialogDescription>
				</DialogHeader>
				<ol className="grid list-decimal gap-2 pl-5 text-sm marker:text-muted-foreground">
					<li>
						<span className="font-medium">Drain.</span>{" "}
						<span className="text-muted-foreground">
							Swarm moves every task to the other nodes; a manager is demoted to
							worker first. Services pinned here by a label wait until another
							node carries it.
						</span>
					</li>
					<li>
						<span className="font-medium">Leave.</span>{" "}
						<span className="text-muted-foreground">
							Once its tasks have moved, LogiStack connects over SSH and the
							server leaves the swarm.
						</span>
					</li>
					<li>
						<span className="font-medium">Delete.</span>{" "}
						<span className="text-muted-foreground">
							The node is removed from the swarm and from this list. Docker
							stays installed on the server.
						</span>
					</li>
				</ol>
				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={remove.isPending}
						onClick={() =>
							remove.mutate(undefined, {
								onSuccess: () => {
									toast.success(`Removing ${node.hostname}`, {
										description:
											"Draining first; it disappears from the list when it has left.",
									});
									onOpenChange(false);
									void navigate({ to: "/monitoring/nodes" });
								},
								onError: (e) =>
									toast.error("Couldn't remove the node", {
										description: errorText(e),
									}),
							})
						}
					>
						{remove.isPending && <Loader2 className="animate-spin" />}
						Remove node
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Labels, drain/activate and remove for one node. */
export function NodeActions({ node }: { node: ClusterNode }) {
	const [dialog, setDialog] = useState<"labels" | "remove" | null>(null);
	const update = useUpdateNode(node.id);
	const draining = node.desired === "drain";
	const removing = node.desired === "remove";

	const setAvailability = () =>
		update.mutate(
			{ desired: draining ? "active" : "drain" },
			{
				onSuccess: () =>
					toast.success(
						draining
							? `${node.hostname} takes tasks again`
							: `Draining ${node.hostname}`,
						{
							description: draining
								? "Swarm can schedule new tasks on it."
								: "Its tasks move to other nodes; nothing new is placed here.",
						},
					),
				onError: (e) =>
					toast.error("Couldn't change availability", {
						description: errorText(e),
					}),
			},
		);

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				variant="outline"
				onClick={() => setDialog("labels")}
				disabled={removing}
			>
				<Tags data-icon="inline-start" />
				Labels
			</Button>
			<Button
				variant="outline"
				onClick={setAvailability}
				disabled={removing || update.isPending}
			>
				{update.isPending ? (
					<Loader2 className="animate-spin" />
				) : draining ? (
					<Play data-icon="inline-start" />
				) : (
					<Pause data-icon="inline-start" />
				)}
				{draining ? "Activate" : "Drain"}
			</Button>
			<Button
				variant="destructive"
				onClick={() => setDialog("remove")}
				disabled={removing || node.leader}
				title={
					node.leader
						? "The leader manager runs LogiStack and can't be removed"
						: undefined
				}
			>
				<Trash2 data-icon="inline-start" />
				Remove
			</Button>
			<LabelsDialog
				node={node}
				open={dialog === "labels"}
				onOpenChange={(o) => setDialog(o ? "labels" : null)}
			/>
			<RemoveDialog
				node={node}
				open={dialog === "remove"}
				onOpenChange={(o) => setDialog(o ? "remove" : null)}
			/>
		</div>
	);
}
