import { BucketName } from "@logistack/contracts";
import { Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
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
import { Switch } from "@/components/ui/switch";
import {
	type Bucket,
	type BucketPatch,
	type StorageCapabilities,
	storageApi,
	useStorageMutation,
} from "@/lib/api/storage";
import { formatBytes } from "@/lib/metrics";
import { errorText } from "./object-actions";

export function CreateBucketDialog({
	serviceId,
	open,
	onOpenChange,
	onCreated,
}: {
	serviceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (name: string) => void;
}) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (open) {
			setName("");
			setError(undefined);
		}
	}, [open]);
	const create = useStorageMutation(serviceId, (n: string) =>
		storageApi.buckets.create(serviceId, n),
	);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const parsed = BucketName.safeParse(name.trim());
		if (!parsed.success)
			return setError(parsed.error.issues[0]?.message ?? "Invalid name.");
		create.mutate(parsed.data, {
			onSuccess: () => {
				toast.success(`Created ${parsed.data}`);
				onCreated(parsed.data);
				onOpenChange(false);
			},
			onError: (err) => setError(errorText(err)),
		});
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>New bucket</DialogTitle>
						<DialogDescription>
							Buckets start private. Names are permanent and part of every
							object's URL.
						</DialogDescription>
					</DialogHeader>
					<Field
						id="bucket-name"
						label="Name"
						error={error}
						hint="3 to 63 lowercase letters, digits, dots and dashes."
					>
						<Input
							id="bucket-name"
							value={name}
							onChange={(e) => {
								setName(e.target.value.toLowerCase());
								setError(undefined);
							}}
							placeholder="product-images"
							aria-invalid={error ? true : undefined}
							aria-describedby="bucket-name-msg"
							autoCapitalize="none"
							spellCheck={false}
							className="font-mono"
							autoFocus
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
							Create bucket
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function Setting({
	id,
	title,
	description,
	checked,
	disabled,
	unsupported,
	onChange,
}: {
	id: string;
	title: string;
	description: ReactNode;
	checked: boolean;
	disabled: boolean;
	unsupported: string | null;
	onChange: (v: boolean) => void;
}) {
	return (
		<label
			htmlFor={id}
			className="flex items-start justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40"
		>
			<span>
				<span className="block font-medium">{title}</span>
				<span className="text-muted-foreground">
					{unsupported ?? description}
				</span>
			</span>
			<Switch
				id={id}
				checked={checked}
				disabled={disabled || unsupported !== null}
				onCheckedChange={onChange}
				className="mt-0.5"
			/>
		</label>
	);
}

/** Versioning, public read and deletion of one bucket, each honest about engine support. */
export function BucketSettingsDialog({
	serviceId,
	bucket,
	capabilities,
	engineLabel,
	hasPublicEndpoint,
	onClose,
	onDeleted,
}: {
	serviceId: string;
	bucket: Bucket | null;
	capabilities: StorageCapabilities | undefined;
	engineLabel: string;
	hasPublicEndpoint: boolean;
	onClose: () => void;
	onDeleted: (name: string) => void;
}) {
	const [confirm, setConfirm] = useState("");
	useEffect(() => {
		if (bucket) setConfirm("");
	}, [bucket]);
	const update = useStorageMutation(serviceId, (p: BucketPatch) =>
		storageApi.buckets.update(serviceId, bucket?.name ?? "", p),
	);
	const remove = useStorageMutation(serviceId, (name: string) =>
		storageApi.buckets.remove(serviceId, name),
	);
	const patch = (p: BucketPatch, done: string) =>
		update.mutate(p, {
			onSuccess: () => toast.success(done),
			onError: (e) =>
				toast.error("Couldn't change the bucket", {
					description: errorText(e),
				}),
		});
	const notHere = (supported: boolean | undefined, value: unknown) =>
		supported === false || value === null
			? `Not supported by ${engineLabel}.`
			: null;
	const b = bucket;
	return (
		<Dialog open={!!b} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-lg">
				{b && (
					<>
						<DialogHeader>
							<DialogTitle className="font-mono text-base">
								{b.name}
							</DialogTitle>
							<DialogDescription>
								{b.size === null
									? `Created ${new Date(b.createdAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}. ${engineLabel} reports no usage figures.`
									: `${formatBytes(b.size)} in ${b.objects?.toLocaleString("en") ?? 0} objects. Created ${new Date(b.createdAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}.`}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-2">
							<Setting
								id="bucket-versioning"
								title="Versioning"
								description="Keep every version of an object, so overwrites and deletes can be undone from an S3 client."
								checked={b.versioning === true}
								disabled={update.isPending}
								unsupported={notHere(capabilities?.versioning, b.versioning)}
								onChange={(v) =>
									patch(
										{ versioning: v },
										v ? "Versioning on" : "Versioning suspended",
									)
								}
							/>
							<Setting
								id="bucket-public"
								title="Public read"
								description={
									hasPublicEndpoint
										? "Anyone can download any object by its URL. Listing stays private."
										: "Anyone could download objects by URL, once the S3 endpoint has a public domain."
								}
								checked={b.access === "public-read"}
								disabled={update.isPending}
								unsupported={notHere(capabilities?.bucketPolicy, b.access)}
								onChange={(v) =>
									patch(
										{ access: v ? "public-read" : "private" },
										v ? `${b.name} is public` : `${b.name} is private`,
									)
								}
							/>
						</div>
						<section
							aria-labelledby="bucket-delete"
							className="grid gap-3 rounded-lg p-4 ring-1 ring-bad/30"
						>
							<div>
								<h3 id="bucket-delete" className="text-sm font-medium">
									Delete bucket
								</h3>
								<p className="mt-0.5 text-sm text-muted-foreground">
									Deletes every object in it first. This can't be undone.
								</p>
							</div>
							<Field id="bucket-confirm" label={`Type ${b.name} to confirm`}>
								<Input
									id="bucket-confirm"
									value={confirm}
									onChange={(e) => setConfirm(e.target.value)}
									placeholder={b.name}
									autoCapitalize="none"
									spellCheck={false}
									autoComplete="off"
									className="font-mono"
								/>
							</Field>
							<Button
								variant="destructive"
								className="justify-self-start"
								disabled={confirm !== b.name || remove.isPending}
								onClick={() =>
									remove.mutate(b.name, {
										onSuccess: () => {
											toast.success(`Deleted ${b.name}`);
											onDeleted(b.name);
										},
										onError: (e) =>
											toast.error("Couldn't delete the bucket", {
												description: errorText(e),
											}),
									})
								}
							>
								{remove.isPending && <Loader2 className="animate-spin" />}
								Delete bucket and objects
							</Button>
						</section>
						<DialogFooter>
							<Button variant="ghost" onClick={onClose}>
								Done
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
