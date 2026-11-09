import type { WorkShare } from "@logistack/contracts";
import { Link2, Lock, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	useRevokeWorkShare,
	useWorkLists,
	useWorkProject,
	useWorkShares,
	useWorkViews,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { ShareLinkDialog } from "./share-link-wizard";

/** Settings → Work → Share links: every link of the project with its views, last access and revoke. */
export function ShareLinksList({ projectId }: { projectId: string }) {
	const shares = useWorkShares(projectId);
	const project = useWorkProject(projectId).data;
	const lists = useWorkLists(projectId).data ?? [];
	const views = useWorkViews(projectId).data ?? [];
	const revoke = useRevokeWorkShare();
	const [creating, setCreating] = useState(false);
	const [revoking, setRevoking] = useState<WorkShare | null>(null);
	const allowed = project?.allowShareLinks ?? false;
	const target = (s: WorkShare) =>
		s.listId
			? (lists.find((l) => l.id === s.listId)?.name ?? "List")
			: (views.find((v) => v.id === s.viewId)?.name ?? "View");

	return (
		<Panel
			title="Share links"
			actions={
				<Button
					size="sm"
					variant="outline"
					onClick={() => setCreating(true)}
					disabled={!allowed}
				>
					<Plus data-icon="inline-start" />
					New link
				</Button>
			}
		>
			{!allowed && (
				<p className="mb-3 text-sm text-muted-foreground">
					Share links are off for this project. Turn on “Share links” above to
					create one; existing links stop working while it's off.
				</p>
			)}
			{shares.isPending ? (
				<SkeletonRows rows={3} />
			) : !shares.data?.length ? (
				<EmptyState
					icon={Link2}
					title="No share links"
					description="Show a list or a view to a client without giving them an account. They see it read-only."
				/>
			) : (
				<div className="overflow-x-auto rounded-lg ring-1 ring-border">
					<table className="w-full text-sm">
						<thead className="text-left text-xs text-muted-foreground">
							<tr className="border-b">
								<th className="px-3 py-2 font-medium">Name</th>
								<th className="px-3 py-2 font-medium">Shows</th>
								<th className="px-3 py-2 text-right font-medium">Views</th>
								<th className="px-3 py-2 font-medium">Last opened</th>
								<th className="px-3 py-2 font-medium">Status</th>
								<th className="px-3 py-2">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody className="divide-y">
							{shares.data.map((s) => {
								const state = stateOf(s);
								return (
									<tr
										key={s.id}
										className={cn(
											state !== "Active" && "text-muted-foreground",
										)}
									>
										<td className="px-3 py-2.5">
											<span className="flex items-center gap-1.5 font-medium">
												{s.name}
												{s.hasPassword && (
													<Lock
														className="size-3 text-muted-foreground"
														aria-label="Password"
													/>
												)}
											</span>
										</td>
										<td className="px-3 py-2.5">{target(s)}</td>
										<td className="px-3 py-2.5 text-right tabular-nums">
											{s.viewCount}
										</td>
										<td className="px-3 py-2.5">
											{s.lastViewedAt ? ago(s.lastViewedAt) : "Never"}
										</td>
										<td className="px-3 py-2.5">
											<span className="flex items-center gap-1.5">
												<span
													className={cn(
														"size-1.5 rounded-full",
														state === "Active" ? "bg-ok" : "bg-idle",
													)}
												/>
												{state}
											</span>
										</td>
										<td className="px-3 py-2.5 text-right">
											{state === "Active" && (
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setRevoking(s)}
												>
													Revoke
												</Button>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			<ShareLinkDialog
				projectId={projectId}
				open={creating}
				onOpenChange={setCreating}
			/>
			<ConfirmDialog
				open={revoking !== null}
				onOpenChange={(o) => !o && setRevoking(null)}
				title={`Revoke “${revoking?.name ?? ""}”?`}
				description="The link stops working at once. Anyone who has it sees a “no longer available” page."
				confirmLabel="Revoke link"
				pending={revoke.isPending}
				onConfirm={() =>
					revoking &&
					revoke.mutate(
						{ projectId, id: revoking.id },
						{
							onSuccess: () => {
								toast.success("Link revoked");
								setRevoking(null);
							},
							onError: (e) => toast.error(e.message),
						},
					)
				}
			/>
		</Panel>
	);
}

function stateOf(s: WorkShare) {
	if (s.revokedAt) return "Revoked";
	if (s.expiresAt && new Date(s.expiresAt) <= new Date()) return "Expired";
	return "Active";
}

function ago(iso: string) {
	const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
	if (min < 1) return "Just now";
	if (min < 60) return `${min} min ago`;
	if (min < 1440) return `${Math.round(min / 60)} h ago`;
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});
}
