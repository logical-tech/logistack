import type { NetworkDevice } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { HomeDnsPage } from "@/components/network/home-dns";
import { BlockingCell, DeviceDialog } from "@/components/network/people";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	devicesQuery,
	effectiveBlocking,
	hasBlocking,
	networkPeopleApi,
	peopleQuery,
	useNetworkPeopleMutation,
} from "@/lib/api/network-people";

export const Route = createFileRoute("/_app/network_/devices")({
	staticData: { crumb: "Devices" },
	validateSearch: z.object({
		person: z.string().max(64).optional().catch(undefined),
	}),
	component: DevicesPage,
});

/** null closed, "new" adding, a device editing. */
type Editing = null | "new" | NetworkDevice;

function DevicesPage() {
	const [editing, setEditing] = useState<Editing>(null);
	return (
		<HomeDnsPage
			to="/network/devices"
			needsReady={false}
			actions={() => (
				<Button onClick={() => setEditing("new")}>
					<Plus data-icon="inline-start" />
					Add device
				</Button>
			)}
		>
			{() => <Devices editing={editing} setEditing={setEditing} />}
		</HomeDnsPage>
	);
}

function Devices({
	editing,
	setEditing,
}: {
	editing: Editing;
	setEditing: (e: Editing) => void;
}) {
	const { person: personFilter } = Route.useSearch();
	const { data, error } = useQuery(devicesQuery);
	const { data: people = [] } = useQuery(peopleQuery);
	const add = useNetworkPeopleMutation(networkPeopleApi.addDevice);
	const update = useNetworkPeopleMutation(
		(v: { id: string; d: Parameters<typeof networkPeopleApi.addDevice>[0] }) =>
			networkPeopleApi.updateDevice(v.id, v.d),
	);
	const remove = useNetworkPeopleMutation(networkPeopleApi.deleteDevice);
	const [deleting, setDeleting] = useState<NetworkDevice | null>(null);
	const device = editing && editing !== "new" ? editing : null;
	const filterName = people.find((p) => p.id === personFilter)?.name;
	const rows = personFilter
		? data?.filter((d) => d.personId === personFilter)
		: data;

	return (
		<div className="grid gap-4">
			{personFilter && filterName && (
				<div className="flex items-center gap-2 text-sm">
					<span className="text-muted-foreground">Showing</span>
					<span className="flex items-center gap-0.5 rounded-md bg-muted py-0.5 pr-0.5 pl-2">
						{filterName}
						<Button
							asChild
							variant="ghost"
							size="icon-xs"
							className="size-6"
							aria-label="Show every device"
						>
							<Link to="/network/devices" search={{}}>
								<X />
							</Link>
						</Button>
					</span>
				</div>
			)}
			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				{error ? (
					<p className="px-4 py-10 text-center text-sm text-bad-text">
						{error.message}
					</p>
				) : !rows ? (
					<SkeletonRows rows={5} />
				) : rows.length === 0 ? (
					<div className="flex flex-col items-center gap-4 px-4 py-14 text-center">
						<p className="max-w-[50ch] text-sm text-pretty text-muted-foreground">
							Name the addresses that ask the home DNS, so stats and the query
							log say "Luca's iPad" instead of 192.168.1.52. You can also name
							one straight from the query log.
						</p>
						<Button variant="outline" onClick={() => setEditing("new")}>
							<Plus data-icon="inline-start" />
							Add device
						</Button>
					</div>
				) : (
					<div className="relative overflow-x-auto">
						<table
							className="w-full min-w-[42rem] text-sm"
							aria-label="Devices"
						>
							<thead>
								<tr className="border-b text-left text-xs text-muted-foreground">
									<th scope="col" className="h-9 px-4 font-medium">
										Name
									</th>
									<th scope="col" className="h-9 w-36 px-4 font-medium">
										Address
									</th>
									<th scope="col" className="h-9 w-36 px-4 font-medium">
										Person
									</th>
									<th scope="col" className="h-9 px-4 font-medium">
										Also blocks
									</th>
									<th scope="col" className="h-9 w-24 px-2">
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((d) => {
									const owner = people.find((p) => p.id === d.personId);
									const inherits = owner && hasBlocking(owner.blocking);
									return (
										<tr
											key={d.id}
											className="border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50"
										>
											<td className="h-12 max-w-0 px-4">
												<span className="block truncate font-medium">
													{d.name}
												</span>
											</td>
											<td className="h-12 px-4 font-mono text-xs tabular">
												<Link
													to="/network/dns/logs"
													search={{ client: d.address }}
													className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
													title="Show this device's queries"
												>
													{d.address}
												</Link>
											</td>
											<td className="h-12 max-w-0 px-4">
												<span
													className={
														d.personName
															? "block truncate text-xs"
															: "text-xs text-muted-foreground"
													}
												>
													{d.personName ?? "No one"}
												</span>
											</td>
											<td className="h-12 max-w-0 px-4">
												<BlockingCell
													b={effectiveBlocking(d.blocking, owner?.blocking)}
												/>
												{inherits && (
													<span className="block truncate text-2xs text-muted-foreground">
														Includes {owner.name}'s
													</span>
												)}
											</td>
											<td className="h-12 px-2 text-right whitespace-nowrap">
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label={`Edit ${d.name}`}
													onClick={() => setEditing(d)}
												>
													<Pencil />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label={`Delete ${d.name}`}
													onClick={() => setDeleting(d)}
												>
													<Trash2 />
												</Button>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
			<DeviceDialog
				open={editing !== null}
				onOpenChange={(o) => !o && setEditing(null)}
				device={device}
				people={people}
				onSave={(d) =>
					(device
						? update.mutateAsync({ id: device.id, d })
						: add.mutateAsync(d)
					).then((saved) =>
						toast.success(
							device ? `Saved ${saved.name}` : `Added ${saved.name}`,
						),
					)
				}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "device"}?`}
				description={`${deleting?.address ?? "Its address"} shows as a bare address again and loses its extra blocking. The house's lists still apply.`}
				confirmLabel="Delete device"
				pending={remove.isPending}
				onConfirm={() =>
					deleting &&
					remove.mutate(deleting.id, {
						onSuccess: () => setDeleting(null),
						onError: (e) =>
							toast.error(`Couldn't delete ${deleting.name}`, {
								description: e.message,
							}),
					})
				}
			/>
		</div>
	);
}
