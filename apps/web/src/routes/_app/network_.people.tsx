import type { NetworkPerson } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { HomeDnsPage } from "@/components/network/home-dns";
import { BlockingCell, PersonDialog } from "@/components/network/people";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	networkPeopleApi,
	peopleQuery,
	useNetworkPeopleMutation,
} from "@/lib/api/network-people";

export const Route = createFileRoute("/_app/network_/people")({
	staticData: { crumb: "People" },
	component: PeoplePage,
});

/** null closed, "new" adding, a person editing. */
type Editing = null | "new" | NetworkPerson;

function PeoplePage() {
	const [editing, setEditing] = useState<Editing>(null);
	return (
		<HomeDnsPage
			to="/network/people"
			needsReady={false}
			className="max-w-4xl"
			actions={() => (
				<Button onClick={() => setEditing("new")}>
					<Plus data-icon="inline-start" />
					Add person
				</Button>
			)}
		>
			{() => <People editing={editing} setEditing={setEditing} />}
		</HomeDnsPage>
	);
}

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

function People({
	editing,
	setEditing,
}: {
	editing: Editing;
	setEditing: (e: Editing) => void;
}) {
	const { data, error } = useQuery(peopleQuery);
	const add = useNetworkPeopleMutation(networkPeopleApi.addPerson);
	const update = useNetworkPeopleMutation(
		(v: { id: string; p: Parameters<typeof networkPeopleApi.addPerson>[0] }) =>
			networkPeopleApi.updatePerson(v.id, v.p),
	);
	const remove = useNetworkPeopleMutation(networkPeopleApi.deletePerson);
	const [deleting, setDeleting] = useState<NetworkPerson | null>(null);
	const person = editing && editing !== "new" ? editing : null;

	return (
		<>
			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				{error ? (
					<p className="px-4 py-10 text-center text-sm text-bad-text">
						{error.message}
					</p>
				) : !data ? (
					<SkeletonRows rows={3} />
				) : data.length === 0 ? (
					<div className="flex flex-col items-center gap-4 px-4 py-14 text-center">
						<p className="max-w-[48ch] text-sm text-pretty text-muted-foreground">
							Add the people in the house to group their devices, and to block
							more for some of them, like a stricter list for the kids.
						</p>
						<Button variant="outline" onClick={() => setEditing("new")}>
							<Plus data-icon="inline-start" />
							Add person
						</Button>
					</div>
				) : (
					<div className="relative overflow-x-auto">
						<table className="w-full min-w-[32rem] text-sm" aria-label="People">
							<thead>
								<tr className="border-b text-left text-xs text-muted-foreground">
									<th scope="col" className="h-9 px-4 font-medium">
										Name
									</th>
									<th scope="col" className="h-9 w-28 px-4 font-medium">
										Devices
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
								{data.map((p) => (
									<tr
										key={p.id}
										className="border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50"
									>
										<td className="h-12 max-w-0 px-4">
											<span className="block truncate font-medium">
												{p.name}
											</span>
										</td>
										<td className="h-12 px-4 text-xs tabular">
											{p.devices ? (
												<Link
													to="/network/devices"
													search={{ person: p.id }}
													className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
												>
													{plural(p.devices, "device", "devices")}
												</Link>
											) : (
												<span className="text-muted-foreground">None yet</span>
											)}
										</td>
										<td className="h-12 max-w-0 px-4">
											<BlockingCell b={p.blocking} />
										</td>
										<td className="h-12 px-2 text-right whitespace-nowrap">
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`Edit ${p.name}`}
												onClick={() => setEditing(p)}
											>
												<Pencil />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`Delete ${p.name}`}
												onClick={() => setDeleting(p)}
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
			<PersonDialog
				open={editing !== null}
				onOpenChange={(o) => !o && setEditing(null)}
				person={person}
				onSave={(p) =>
					(person
						? update.mutateAsync({ id: person.id, p })
						: add.mutateAsync(p)
					).then((saved) =>
						toast.success(
							person ? `Saved ${saved.name}` : `Added ${saved.name}`,
						),
					)
				}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "person"}?`}
				description={
					deleting?.devices
						? `${deleting.devices === 1 ? "Their device stays" : `Their ${deleting.devices} devices stay`}, with no one assigned and only their own extra blocking. The house's lists still apply.`
						: "Their extra blocking goes with them. The house's lists still apply."
				}
				confirmLabel="Delete person"
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
		</>
	);
}
