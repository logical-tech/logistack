import { Bot, Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/access/confirm-dialog";
import { RoleSelect } from "@/components/access/scope-picker";
import { Field } from "@/components/field";
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
	useCreateServiceAccount,
	useRemoveServiceAccount,
	useServiceAccounts,
} from "@/lib/api/access";
import type { ServiceAccount } from "@/lib/api/access-types";

function CreateServiceAccountDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [name, setName] = useState("");
	const [role, setRole] = useState("viewer");
	const [error, setError] = useState<string>();
	const create = useCreateServiceAccount();

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!name.trim()) return setError("Name the service account.");
		create.mutate(
			{ name: name.trim(), role },
			{
				onSuccess: (sa) => {
					toast.success(`${sa.name} created`, {
						description: "Create a key for it to start using it.",
					});
					setName("");
					setRole("viewer");
					setError(undefined);
					onOpenChange(false);
				},
				onError: (err) => setError(err.message),
			},
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>New service account</DialogTitle>
						<DialogDescription>
							A machine identity for CI or an agent. It never signs in; it acts
							only through its API keys.
						</DialogDescription>
					</DialogHeader>
					<Field
						id="sa-name"
						label="Name"
						error={error}
						hint="What uses it, like GitHub Actions or Claude Code."
					>
						<Input
							id="sa-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="GitHub Actions"
							autoComplete="off"
							aria-invalid={error ? true : undefined}
							aria-describedby="sa-name-msg"
						/>
					</Field>
					<Field
						id="sa-role"
						label="Organization role"
						hint="Its access everywhere. Narrow it per folder or project from Members."
					>
						<RoleSelect
							id="sa-role"
							value={role}
							onChange={setRole}
							exclude={["owner"]}
							className="w-full"
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
							Create service account
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function ServiceAccountPanel() {
	const { data: accounts } = useServiceAccounts();
	const remove = useRemoveServiceAccount();
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState<ServiceAccount | null>(null);

	return (
		<Panel
			title="Service accounts"
			id="service-accounts"
			actions={
				<Button variant="outline" size="sm" onClick={() => setCreating(true)}>
					<Plus data-icon="inline-start" />
					New service account
				</Button>
			}
		>
			{!accounts ? (
				<SkeletonRows rows={2} />
			) : accounts.length === 0 ? (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					No service accounts. Create one so CI keys survive people leaving the
					team.
				</p>
			) : (
				<ul className="divide-y">
					{accounts.map((sa) => (
						<li
							key={sa.id}
							className="flex min-h-14 items-center gap-3 px-4 py-2.5"
						>
							<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
								<Bot className="size-4" strokeWidth={1.75} aria-hidden />
							</span>
							<div className="min-w-0 flex-1">
								<span className="block truncate font-medium">{sa.name}</span>
								<span className="block text-xs text-muted-foreground">
									<span className="capitalize">{sa.role}</span> ·{" "}
									<span className="tabular">
										{sa.keyCount} {sa.keyCount === 1 ? "key" : "keys"}
									</span>
								</span>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Delete ${sa.name}`}
								onClick={() => setDeleting(sa)}
							>
								<Trash2 />
							</Button>
						</li>
					))}
				</ul>
			)}

			<CreateServiceAccountDialog open={creating} onOpenChange={setCreating} />
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name}?`}
				description={
					deleting?.keyCount
						? `Its ${deleting.keyCount === 1 ? "key is" : `${deleting.keyCount} keys are`} deleted too, and anything using ${deleting.keyCount === 1 ? "it" : "them"} stops working.`
						: "It has no keys. Its grants are removed with it."
				}
				confirmLabel="Delete service account"
				onConfirm={() =>
					remove.mutateAsync(deleting?.id ?? "").then(
						() => toast.success(`${deleting?.name} deleted`),
						(err: Error) => {
							toast.error("Couldn't delete the service account", {
								description: err.message,
							});
							throw err;
						},
					)
				}
			/>
		</Panel>
	);
}
