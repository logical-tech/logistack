import { createFileRoute } from "@tanstack/react-router";
import { Plus, ServerCog, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/access/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMe } from "@/lib/api/access";
import {
	type InstanceAdmin,
	useAddInstanceAdmin,
	useInstanceAdmins,
	useRemoveInstanceAdmin,
} from "@/lib/api/instance-admins";

export const Route = createFileRoute("/_app/settings/instance-admins")({
	staticData: { crumb: "Instance admins" },
	component: InstanceAdminsPage,
});

function AddAdminForm() {
	const add = useAddInstanceAdmin();
	const [email, setEmail] = useState("");
	const [error, setError] = useState<string>();

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!email.trim()) return;
		setError(undefined);
		add.mutate(email.trim(), {
			onSuccess: () => {
				toast.success(`${email.trim()} is now an instance admin`);
				setEmail("");
			},
			onError: (err) =>
				setError(
					err.message === "user not found"
						? "No account uses this email. They need to sign up or accept an invitation first."
						: err.message,
				),
		});
	};

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-3 sm:flex-row sm:items-start"
		>
			<Field
				id="instance-admin-email"
				label="Email"
				hint="Someone who already has an account on this instance."
				error={error}
				className="flex-1"
			>
				<Input
					id="instance-admin-email"
					type="email"
					autoComplete="off"
					placeholder="name@company.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					aria-invalid={!!error}
					aria-describedby="instance-admin-email-msg"
				/>
			</Field>
			<Button
				type="submit"
				className="sm:mt-7"
				disabled={!email.trim() || add.isPending}
			>
				<Plus data-icon="inline-start" />
				Add admin
			</Button>
		</form>
	);
}

function AdminRow({
	admin,
	you,
	last,
	onRemove,
}: {
	admin: InstanceAdmin;
	you: boolean;
	last: boolean;
	onRemove: () => void;
}) {
	return (
		<li className="flex items-center gap-4 px-4 py-3.5">
			<div className="min-w-0 flex-1">
				<span className="flex items-center gap-2 font-medium">
					<span className="truncate">{admin.name}</span>
					{you && <Badge variant="secondary">You</Badge>}
				</span>
				<span className="block truncate text-xs text-muted-foreground">
					{admin.email}
				</span>
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`Remove ${admin.name}`}
				title={last ? "The instance needs at least one admin" : undefined}
				disabled={last}
				onClick={onRemove}
			>
				<Trash2 />
			</Button>
		</li>
	);
}

function InstanceAdminsPage() {
	const { data: me } = useMe();
	const allowed = me?.instanceAdmin === true;
	const { data: admins } = useInstanceAdmins(allowed);
	const remove = useRemoveInstanceAdmin();
	const [removing, setRemoving] = useState<InstanceAdmin | null>(null);

	return (
		<Page>
			<PageHeader
				title="Instance admins"
				description="Instance admins update LogiStack, add and remove servers, and change settings every organization shares. Organization roles don't grant this."
			/>
			{me && !allowed ? (
				<EmptyState
					icon={ServerCog}
					title="Only instance admins manage this server"
					description="Ask an instance admin to add you. You keep your role in your organization either way."
				/>
			) : (
				<>
					<Panel title="Add an admin" id="add-instance-admin">
						<div className="p-4">
							<AddAdminForm />
						</div>
					</Panel>
					<Panel title="Admins" id="instance-admins">
						{admins ? (
							<ul className="divide-y">
								{admins.map((a) => (
									<AdminRow
										key={a.id}
										admin={a}
										you={a.id === me?.userId}
										last={admins.length === 1}
										onRemove={() => setRemoving(a)}
									/>
								))}
							</ul>
						) : (
							<SkeletonRows rows={2} />
						)}
					</Panel>
				</>
			)}
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={`Remove ${removing?.name} as instance admin?`}
				description={
					removing?.id === me?.userId
						? "You lose access to updates, servers and instance settings right away. Another admin can add you back."
						: "They keep their organization role but can no longer update the instance, manage servers or change instance settings."
				}
				confirmLabel="Remove admin"
				onConfirm={() =>
					remove.mutateAsync(removing?.id ?? "").then(
						() => toast.success(`${removing?.name} removed`),
						(err: Error) => {
							toast.error("Couldn't remove the admin", {
								description: err.message,
							});
							throw err;
						},
					)
				}
			/>
		</Page>
	);
}
