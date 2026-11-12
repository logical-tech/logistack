import type { HomeDnsRecord } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CircleAlert, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { formatTtl, relativeName } from "@/components/dns/record-editor";
import { EmptyState } from "@/components/empty-state";
import { HomeDnsPage } from "@/components/network/home-dns";
import { RecordDialog } from "@/components/network/record-dialog";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	homeDnsApi,
	homeDnsRecordsQuery,
	useHomeDnsMutation,
} from "@/lib/api/home-dns";

export const Route = createFileRoute("/_app/network_/dns_/zones_/$zone")({
	loader: ({ params }) => ({ crumb: params.zone }),
	component: ZonePage,
});

/** Where to edit: null closed, "new" adding, a record editing. */
type Editing = null | "new" | HomeDnsRecord;

function ZonePage() {
	const { zone } = Route.useParams();
	const [editing, setEditing] = useState<Editing>(null);
	return (
		<HomeDnsPage
			to="/network/dns/zones"
			title={<span className="font-mono">{zone}</span>}
			description="Records the home DNS answers for this zone. Other record types and zone options live in the Technitium console."
			actions={() => (
				<>
					<Button asChild variant="ghost">
						<Link to="/network/dns/zones">
							<ArrowLeft data-icon="inline-start" />
							Zones
						</Link>
					</Button>
					<Button onClick={() => setEditing("new")}>
						<Plus data-icon="inline-start" />
						Add record
					</Button>
				</>
			)}
		>
			{() => <Records zone={zone} editing={editing} setEditing={setEditing} />}
		</HomeDnsPage>
	);
}

function Records({
	zone,
	editing,
	setEditing,
}: {
	zone: string;
	editing: Editing;
	setEditing: (e: Editing) => void;
}) {
	const { data, error } = useQuery(homeDnsRecordsQuery(zone));
	const add = useHomeDnsMutation(
		(r: Parameters<typeof homeDnsApi.addRecord>[1]) =>
			homeDnsApi.addRecord(zone, r),
	);
	const update = useHomeDnsMutation(
		(v: { id: string; r: Parameters<typeof homeDnsApi.addRecord>[1] }) =>
			homeDnsApi.updateRecord(zone, v.id, v.r),
	);
	const remove = useHomeDnsMutation((id: string) =>
		homeDnsApi.deleteRecord(zone, id),
	);
	const [deleting, setDeleting] = useState<HomeDnsRecord | null>(null);
	const record = editing && editing !== "new" ? editing : null;

	return (
		<>
			{error ? (
				<EmptyState
					icon={CircleAlert}
					title="Couldn't read this zone"
					description={error.message}
				>
					<Button asChild variant="outline">
						<Link to="/network/dns/zones">Back to zones</Link>
					</Button>
				</EmptyState>
			) : (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					{!data ? (
						<SkeletonRows rows={4} />
					) : data.length === 0 ? (
						<p className="px-4 py-14 text-center text-sm text-muted-foreground">
							No records yet. Add an A record to give a device a name.
						</p>
					) : (
						<div className="overflow-x-auto">
							<table
								className="w-full min-w-[40rem] text-sm"
								aria-label="Records"
							>
								<thead>
									<tr className="border-b text-left text-xs text-muted-foreground">
										<th scope="col" className="h-9 px-4 font-medium">
											Name
										</th>
										<th scope="col" className="h-9 w-20 px-4 font-medium">
											Type
										</th>
										<th scope="col" className="h-9 px-4 font-medium">
											Value
										</th>
										<th scope="col" className="h-9 w-20 px-4 font-medium">
											TTL
										</th>
										<th scope="col" className="h-9 w-24 px-2">
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{data.map((r) => (
										<tr
											key={r.id}
											className="border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50"
										>
											<td className="h-12 max-w-0 px-4">
												<span className="block truncate font-mono text-xs">
													{relativeName(r.name, zone)}
												</span>
												{r.comment && (
													<span className="block truncate text-xs text-muted-foreground">
														{r.comment}
													</span>
												)}
											</td>
											<td className="h-12 px-4 font-mono text-xs">{r.type}</td>
											<td className="h-12 max-w-0 px-4">
												<span
													className="block truncate font-mono text-xs"
													title={r.content}
												>
													{r.content}
												</span>
											</td>
											<td className="h-12 px-4 text-xs text-muted-foreground tabular">
												{formatTtl(r.ttl)}
											</td>
											<td className="h-12 px-2 text-right whitespace-nowrap">
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label={`Edit ${r.type} ${r.name}`}
													onClick={() => setEditing(r)}
												>
													<Pencil />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label={`Delete ${r.type} ${r.name}`}
													onClick={() => setDeleting(r)}
												>
													<Trash2 />
												</Button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}
			<RecordDialog
				open={editing !== null}
				onOpenChange={(o) => !o && setEditing(null)}
				zone={zone}
				record={record}
				onSave={(r) =>
					record ? update.mutateAsync({ id: record.id, r }) : add.mutateAsync(r)
				}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.type} ${deleting ? relativeName(deleting.name, zone) : ""}?`}
				description="Devices stop getting this answer once their cache expires."
				confirmLabel="Delete record"
				pending={remove.isPending}
				onConfirm={() =>
					deleting &&
					remove.mutate(deleting.id, {
						onSuccess: () => setDeleting(null),
						onError: (e) =>
							toast.error("Couldn't delete the record", {
								description: e.message,
							}),
					})
				}
			/>
		</>
	);
}
