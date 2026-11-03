import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { KeyRound, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton, CopyField } from "@/components/copy-button";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { Panel, SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
	type AccessKey,
	accessKeysQuery,
	bucketsQuery,
	type CreatedAccessKey,
	connectionQuery,
	storageApi,
	useStorageMutation,
} from "@/lib/api/storage";
import { relativeTime } from "@/lib/format";
import { errorText } from "./object-actions";

const ACCESS = {
	read: "Read only",
	readwrite: "Read and write",
} as const;

const col = createColumnHelper<BaseFeatures, AccessKey>();

function columns(onRevoke: (k: AccessKey) => void) {
	return col.columns([
		col.display({
			id: "name",
			header: "Key",
			meta: { className: "w-[34%] max-md:w-[58%]" },
			cell: ({ row: { original: k } }) => (
				<div className="min-w-0">
					<span className="block truncate font-medium">{k.name}</span>
					<span className="block truncate font-mono text-xs text-muted-foreground">
						{k.accessKeyId}
					</span>
				</div>
			),
		}),
		col.display({
			id: "buckets",
			header: "Buckets",
			meta: { className: "max-md:hidden" },
			cell: ({ row: { original: k } }) => (
				<div className="flex min-w-0 flex-wrap gap-1">
					{k.buckets.map((b) => (
						<span
							key={b}
							className="max-w-full truncate rounded-sm bg-muted px-1.5 py-px font-mono text-xs"
						>
							{b}
						</span>
					))}
				</div>
			),
		}),
		col.display({
			id: "access",
			header: "Access",
			meta: { className: "w-[16%] max-md:w-auto" },
			cell: ({ row: { original: k } }) => (
				<span
					className={
						k.access === "readwrite"
							? "text-foreground"
							: "text-muted-foreground"
					}
				>
					{ACCESS[k.access]}
				</span>
			),
		}),
		col.display({
			id: "created",
			header: "Created",
			meta: { className: "w-[14%] max-lg:hidden" },
			cell: ({ row: { original: k } }) => (
				<time dateTime={k.createdAt} className="text-muted-foreground">
					{relativeTime(k.createdAt)}
				</time>
			),
		}),
		col.display({
			id: "revoke",
			header: () => <span className="sr-only">Revoke</span>,
			meta: { className: "w-14 text-right" },
			cell: ({ row: { original: k } }) => (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Revoke ${k.name}`}
					className="text-muted-foreground hover:text-bad-text"
					onClick={() => onRevoke(k)}
				>
					<Trash2 />
				</Button>
			),
		}),
	]);
}

/** Shown once, right after creation; the API never returns the secret again. */
function SecretOnce({
	created,
	endpoint,
	region,
}: {
	created: CreatedAccessKey;
	endpoint: string | undefined;
	region: string | undefined;
}) {
	const env = [
		endpoint && `S3_ENDPOINT=${endpoint}`,
		region && `S3_REGION=${region}`,
		created.buckets.length === 1 && `S3_BUCKET=${created.buckets[0]}`,
		`AWS_ACCESS_KEY_ID=${created.accessKeyId}`,
		`AWS_SECRET_ACCESS_KEY=${created.secretAccessKey}`,
		"S3_FORCE_PATH_STYLE=true",
	]
		.filter(Boolean)
		.join("\n");
	return (
		<div className="t-reveal grid gap-4">
			<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
				<TriangleAlert
					className="mt-0.5 size-4 shrink-0 text-warn-text"
					aria-hidden
				/>
				<p>
					<span className="font-medium">Copy the secret now.</span>{" "}
					<span className="text-muted-foreground">
						The engine keeps it and LogiStack doesn't, so it is not shown again.
						Lost it? Revoke the key and create a new one.
					</span>
				</p>
			</div>
			<div className="grid gap-1.5">
				<span className="text-sm font-medium">Access key ID</span>
				<CopyField value={created.accessKeyId} label="Copy access key ID" />
			</div>
			<div className="grid gap-1.5">
				<span className="text-sm font-medium">Secret access key</span>
				<CopyField
					value={created.secretAccessKey}
					label="Copy secret access key"
					wrap
				/>
			</div>
			<div className="grid gap-1.5">
				<span className="text-sm font-medium">As environment variables</span>
				<div className="flex items-start gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3 dark:bg-muted/40">
					<pre className="min-w-0 flex-1 py-1 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
						{env}
					</pre>
					<CopyButton value={env} label="Copy environment variables" />
				</div>
			</div>
		</div>
	);
}

function CreateKeyDialog({
	serviceId,
	open,
	onOpenChange,
}: {
	serviceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const buckets = useQuery({ ...bucketsQuery(serviceId), enabled: open });
	const connection = useQuery(connectionQuery(serviceId));
	const [name, setName] = useState("");
	const [chosen, setChosen] = useState<string[]>([]);
	const [access, setAccess] = useState<keyof typeof ACCESS>("readwrite");
	const [errors, setErrors] = useState<{ name?: string; buckets?: string }>({});
	const [created, setCreated] = useState<CreatedAccessKey | null>(null);
	const create = useStorageMutation(
		serviceId,
		(input: { name: string; buckets: string[]; access: keyof typeof ACCESS }) =>
			storageApi.keys.create(serviceId, input),
	);

	const reset = (o: boolean) => {
		onOpenChange(o);
		if (!o) {
			// The secret leaves memory with the dialog.
			setCreated(null);
			setName("");
			setChosen([]);
			setAccess("readwrite");
			setErrors({});
		}
	};
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const next = {
			name: name.trim() ? undefined : "Name the key after what uses it.",
			buckets: chosen.length ? undefined : "Choose at least one bucket.",
		};
		setErrors(next);
		if (next.name || next.buckets) return;
		create.mutate(
			{ name: name.trim(), buckets: chosen, access },
			{
				onSuccess: setCreated,
				onError: (err) =>
					toast.error("Couldn't create the key", {
						description: errorText(err),
					}),
			},
		);
	};

	return (
		<Dialog open={open} onOpenChange={reset}>
			<DialogContent className="sm:max-w-lg">
				{created ? (
					<>
						<DialogHeader>
							<DialogTitle>{created.name}</DialogTitle>
							<DialogDescription>
								{ACCESS[created.access]} on {created.buckets.join(", ")}.
							</DialogDescription>
						</DialogHeader>
						<SecretOnce
							created={created}
							endpoint={connection.data?.internalEndpoint}
							region={connection.data?.region}
						/>
						<DialogFooter>
							<Button onClick={() => reset(false)}>I've saved it</Button>
						</DialogFooter>
					</>
				) : (
					<form onSubmit={submit} className="grid gap-5">
						<DialogHeader>
							<DialogTitle>New access key</DialogTitle>
							<DialogDescription>
								A key limited to some buckets, for one app or one person. Apps
								should never hold the root key.
							</DialogDescription>
						</DialogHeader>
						<Field id="key-name" label="Name" error={errors.name}>
							<Input
								id="key-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="storefront web"
								aria-invalid={errors.name ? true : undefined}
								aria-describedby="key-name-msg"
								autoFocus
							/>
						</Field>
						<fieldset className="grid gap-2">
							<legend className="mb-2 text-sm font-medium">Buckets</legend>
							{buckets.isPending ? (
								<SkeletonRows rows={2} />
							) : !buckets.data?.length ? (
								<p className="text-sm text-muted-foreground">
									Create a bucket first; keys are scoped to buckets.
								</p>
							) : (
								<div className="grid max-h-52 gap-px overflow-y-auto rounded-lg ring-1 ring-border">
									{buckets.data.map((b) => (
										<label
											key={b.name}
											htmlFor={`key-bucket-${b.name}`}
											className="flex items-center gap-3 px-3 py-2 text-sm transition-colors duration-(--duration-quick) hover:bg-muted/50"
										>
											<Checkbox
												id={`key-bucket-${b.name}`}
												checked={chosen.includes(b.name)}
												onCheckedChange={(c) =>
													setChosen((s) =>
														c === true
															? [...s, b.name]
															: s.filter((x) => x !== b.name),
													)
												}
											/>
											<span className="truncate font-mono text-[13px]">
												{b.name}
											</span>
										</label>
									))}
								</div>
							)}
							{errors.buckets && (
								<p className="text-xs text-bad-text" aria-live="polite">
									{errors.buckets}
								</p>
							)}
						</fieldset>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<span className="text-sm font-medium">Access</span>
							<Segmented
								label="Access"
								value={access}
								onChange={setAccess}
								options={[
									{ value: "read", label: ACCESS.read },
									{ value: "readwrite", label: ACCESS.readwrite },
								]}
							/>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => reset(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={create.isPending}>
								{create.isPending && <Loader2 className="animate-spin" />}
								Create key
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function AccessKeys({ serviceId }: { serviceId: string }) {
	const keys = useQuery(accessKeysQuery(serviceId));
	const [creating, setCreating] = useState(false);
	const [revoking, setRevoking] = useState<AccessKey | null>(null);
	const revoke = useStorageMutation(serviceId, (k: AccessKey) =>
		storageApi.keys.revoke(serviceId, k.id),
	);
	const add = (
		<Button onClick={() => setCreating(true)}>
			<Plus data-icon="inline-start" />
			New access key
		</Button>
	);
	return (
		<>
			{keys.isPending ? (
				<Panel title="Access keys" id="storage-keys">
					<SkeletonRows rows={3} />
				</Panel>
			) : keys.isError ? (
				<EmptyState
					icon={KeyRound}
					title="Couldn't list access keys"
					description={errorText(keys.error)}
				/>
			) : !keys.data.length ? (
				<EmptyState
					icon={KeyRound}
					title="No scoped keys yet"
					description="Give each app its own key, limited to the buckets it needs and to read or read and write. Revoking one never touches the others."
				>
					{add}
				</EmptyState>
			) : (
				<Panel
					title="Access keys"
					id="storage-keys"
					actions={
						<Button size="sm" onClick={() => setCreating(true)}>
							<Plus data-icon="inline-start" />
							New access key
						</Button>
					}
				>
					<DataTable
						label="Access keys"
						columns={columns(setRevoking)}
						data={keys.data}
						getRowId={(k) => k.id}
					/>
					<p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
						Each key works only on its own buckets. The root key lives under
						Connection and is never listed here.
					</p>
				</Panel>
			)}
			<CreateKeyDialog
				serviceId={serviceId}
				open={creating}
				onOpenChange={setCreating}
			/>
			<ConfirmDialog
				open={!!revoking}
				onOpenChange={(o) => !o && setRevoking(null)}
				title={`Revoke ${revoking?.name ?? "key"}?`}
				description="Apps using it get access denied on their next request. The key is removed from the engine and can't be restored."
				confirmLabel="Revoke key"
				pending={revoke.isPending}
				onConfirm={() =>
					revoking &&
					revoke.mutate(revoking, {
						onSuccess: () => {
							toast.success(`Revoked ${revoking.name}`);
							setRevoking(null);
						},
						onError: (e) =>
							toast.error("Couldn't revoke", { description: errorText(e) }),
					})
				}
			/>
		</>
	);
}
