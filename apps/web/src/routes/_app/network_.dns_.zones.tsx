import type { HomeDnsZone } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Loader2, Plus, Signpost, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { HomeDnsPage } from "@/components/network/home-dns";
import { Panel, SkeletonRows } from "@/components/panel";
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
import {
	homeDnsApi,
	homeDnsZonesQuery,
	useHomeDnsMutation,
} from "@/lib/api/home-dns";

export const Route = createFileRoute("/_app/network_/dns_/zones")({
	staticData: { crumb: "Zones" },
	component: ZonesPage,
});

const ZONE =
	/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function ZonesPage() {
	const [creating, setCreating] = useState(false);
	return (
		<HomeDnsPage
			to="/network/dns/zones"
			actions={() => (
				<Button onClick={() => setCreating(true)}>
					<Plus data-icon="inline-start" />
					New zone
				</Button>
			)}
		>
			{(dns) => (
				<>
					<ZoneList
						localZone={dns.settings?.localZone ?? null}
						onCreate={() => setCreating(true)}
					/>
					<NewZone open={creating} onOpenChange={setCreating} />
				</>
			)}
		</HomeDnsPage>
	);
}

function ZoneList({
	localZone,
	onCreate,
}: {
	localZone: string | null;
	onCreate: () => void;
}) {
	const { data } = useQuery(homeDnsZonesQuery);
	const remove = useHomeDnsMutation((z: string) => homeDnsApi.deleteZone(z));
	const [deleting, setDeleting] = useState<HomeDnsZone | null>(null);
	if (data && data.length === 0)
		return (
			<EmptyState
				icon={Signpost}
				title="No local zones"
				description="A zone like home.lan gives devices in the house names: nas.home.lan instead of 192.168.1.80."
			>
				<Button onClick={onCreate}>New zone</Button>
			</EmptyState>
		);
	return (
		<Panel title="Zones" id="zones">
			{!data ? (
				<SkeletonRows rows={2} />
			) : (
				<ul className="divide-y">
					{data.map((z) => {
						const local = z.name === localZone;
						return (
							<li
								key={z.name}
								className="group relative flex items-center gap-3 px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-muted/50"
							>
								<div className="min-w-0 flex-1">
									<Link
										to="/network/dns/zones/$zone"
										params={{ zone: z.name }}
										className="rounded-sm font-mono text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring"
									>
										{z.name}
									</Link>
									<p className="text-xs text-muted-foreground">
										{z.type}
										{local && " · local zone from settings"}
										{z.disabled && " · disabled"}
									</p>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									className="relative z-10"
									aria-label={`Delete ${z.name}`}
									disabled={local}
									title={
										local
											? "Clear the local zone in Settings before deleting it"
											: undefined
									}
									onClick={() => setDeleting(z)}
								>
									<Trash2 />
								</Button>
								<ChevronRight
									aria-hidden
									className="size-4 text-muted-foreground"
								/>
							</li>
						);
					})}
				</ul>
			)}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name}?`}
				description="Every record in it goes too. Devices stop resolving its names once their cache expires."
				confirmLabel="Delete zone"
				pending={remove.isPending}
				onConfirm={() =>
					deleting &&
					remove.mutate(deleting.name, {
						onSuccess: () => {
							toast.success(`Deleted ${deleting.name}`);
							setDeleting(null);
						},
						onError: (e) =>
							toast.error("Couldn't delete the zone", {
								description: e.message,
							}),
					})
				}
			/>
		</Panel>
	);
}

function NewZone({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const create = useHomeDnsMutation((n: string) => homeDnsApi.createZone(n));
	const navigate = Route.useNavigate();
	const [name, setName] = useState("");
	const [error, setError] = useState<string>();
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const n = name.trim().toLowerCase().replace(/\.$/, "");
		if (!ZONE.test(n)) {
			setError("Enter a zone name like home.lan");
			return;
		}
		create.mutate(n, {
			onSuccess: () => {
				onOpenChange(false);
				setName("");
				navigate({ to: "/network/dns/zones/$zone", params: { zone: n } });
			},
			onError: (err) => setError(err.message),
		});
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !create.isPending && onOpenChange(o)}
		>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>New zone</DialogTitle>
						<DialogDescription>
							A primary zone the home DNS answers for. Use a name you own, or a
							made-up one like home.lan; made-up names get no public
							certificate.
						</DialogDescription>
					</DialogHeader>
					<Field id="zone-name" label="Zone name" error={error}>
						<Input
							id="zone-name"
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setError(undefined);
							}}
							placeholder="home.lan"
							autoFocus
							spellCheck={false}
							autoCapitalize="none"
							className="font-mono"
							aria-invalid={error ? true : undefined}
							aria-describedby="zone-name-msg"
						/>
					</Field>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={create.isPending}>
							{create.isPending && <Loader2 className="animate-spin" />}
							Create zone
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
