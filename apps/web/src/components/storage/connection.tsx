import { BucketName } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
	ArchiveRestore,
	ArrowUpRight,
	Eye,
	EyeOff,
	Loader2,
	Lock,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CopyButton, CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Panel, SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import {
	bucketsQuery,
	credentialsQuery,
	type StorageConnection,
	storageApi,
	useStorageMutation,
} from "@/lib/api/storage";
import { STORAGE_ENGINES } from "@/lib/storage-engines";
import { errorText } from "./object-actions";

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid gap-1.5 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center sm:gap-4">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-sm">{children}</dd>
		</div>
	);
}

/** Root credentials, or a locked state for people without read:secrets. */
function RootCredentials({ serviceId }: { serviceId: string }) {
	const creds = useQuery(credentialsQuery(serviceId));
	const [shown, setShown] = useState(false);
	if (creds.isPending) return <SkeletonRows rows={2} />;
	if (creds.isError)
		return creds.error instanceof ApiError && creds.error.status === 403 ? (
			<div className="flex items-start gap-3 px-4 py-4">
				<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
					<Lock className="size-4" strokeWidth={1.75} aria-hidden />
				</span>
				<p className="text-sm">
					<span className="block font-medium">Hidden for your role</span>
					<span className="text-muted-foreground">
						Root credentials need the read:secrets permission on this service.
						Ask an admin, or use a scoped key from Access keys.
					</span>
				</p>
			</div>
		) : (
			<p role="alert" className="px-4 py-4 text-sm text-bad-text">
				{errorText(creds.error)}
			</p>
		);
	return (
		<dl className="divide-y">
			<Row label="Access key ID">
				<CopyField value={creds.data.accessKeyId} label="Copy access key ID" />
			</Row>
			<Row label="Secret access key">
				<div className="flex min-w-0 items-center gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3 dark:bg-muted/40">
					<code className="min-w-0 flex-1 truncate py-1 font-mono text-xs leading-5">
						{shown
							? creds.data.secretAccessKey
							: "•".repeat(Math.min(40, creds.data.secretAccessKey.length))}
					</code>
					<Button
						variant="ghost"
						size="icon-sm"
						className="text-muted-foreground"
						aria-label={shown ? "Hide secret" : "Show secret"}
						aria-pressed={shown}
						onClick={() => setShown((s) => !s)}
					>
						{shown ? <EyeOff /> : <Eye />}
					</Button>
					<CopyButton
						value={creds.data.secretAccessKey}
						label="Copy secret access key"
					/>
				</div>
			</Row>
		</dl>
	);
}

function EnvSnippet({
	serviceId,
	connection,
}: {
	serviceId: string;
	connection: StorageConnection;
}) {
	const buckets = useQuery(bucketsQuery(serviceId));
	const creds = useQuery(credentialsQuery(serviceId));
	const [where, setWhere] = useState<"internal" | "public">("internal");
	const [bucket, setBucket] = useState<string>();
	const chosen = bucket ?? buckets.data?.[0]?.name ?? "my-bucket";
	const endpoint =
		where === "public" && connection.publicEndpoint
			? connection.publicEndpoint
			: connection.internalEndpoint;
	const secret = creds.data?.secretAccessKey;
	const lines = (s: string) =>
		[
			`S3_ENDPOINT=${endpoint}`,
			`S3_REGION=${connection.region}`,
			`S3_BUCKET=${chosen}`,
			`AWS_ACCESS_KEY_ID=${creds.data?.accessKeyId ?? "<access key ID of a scoped key>"}`,
			`AWS_SECRET_ACCESS_KEY=${s}`,
			"S3_FORCE_PATH_STYLE=true",
		].join("\n");
	// The copy carries the secret; the screen shows it masked, like the field above.
	const env = lines(secret ?? "<secret of a scoped key>");
	const shown = lines(secret ? "•".repeat(12) : "<secret of a scoped key>");
	return (
		<Panel
			title="Environment variables"
			id="storage-env"
			actions={<CopyButton value={env} label="Copy environment variables" />}
		>
			<div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
				{connection.publicEndpoint && (
					<Segmented
						label="Endpoint"
						value={where}
						onChange={setWhere}
						options={[
							{ value: "internal", label: "Same environment" },
							{ value: "public", label: "Internet" },
						]}
					/>
				)}
				{!!buckets.data?.length && (
					<Select value={chosen} onValueChange={setBucket}>
						<SelectTrigger
							size="sm"
							className="font-mono text-xs"
							aria-label="Bucket"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{buckets.data.map((b) => (
								<SelectItem key={b.name} value={b.name} className="font-mono">
									{b.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			</div>
			<pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-6">
				{shown}
			</pre>
			<p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
				{secret
					? "These use the root key. For an app, create a scoped key in Access keys and paste its pair instead."
					: "Create a scoped key in Access keys and paste its pair here."}
			</p>
		</Panel>
	);
}

function BackupDestination({ serviceId }: { serviceId: string }) {
	const [open, setOpen] = useState(false);
	const [bucket, setBucket] = useState("logistack-backups");
	const [error, setError] = useState<string>();
	const navigate = useNavigate();
	const make = useStorageMutation(serviceId, (b: string) =>
		storageApi.backupDestination(serviceId, { bucket: b }),
	);
	const submit = () => {
		const parsed = BucketName.safeParse(bucket.trim());
		if (!parsed.success)
			return setError(parsed.error.issues[0]?.message ?? "Invalid name.");
		make.mutate(parsed.data, {
			onSuccess: () => {
				setOpen(false);
				toast.success("Backup destination added", {
					description: `Backups can now go to ${parsed.data}. Pick it when you set up a backup policy.`,
					action: {
						label: "S3 destinations",
						onClick: () => navigate({ to: "/integrations/s3" }),
					},
				});
			},
			onError: (e) =>
				e instanceof ApiError && e.status === 403
					? setError("Only organization admins can add backup destinations.")
					: setError(errorText(e)),
		});
	};
	return (
		<section
			aria-labelledby="storage-backups"
			className="flex flex-col gap-4 rounded-xl bg-muted/60 p-4 sm:flex-row sm:items-center dark:bg-muted/40"
		>
			<div className="min-w-0 flex-1">
				<h2
					id="storage-backups"
					className="text-sm font-semibold [font-stretch:100%]"
				>
					Use as backup destination
				</h2>
				<p className="mt-0.5 text-sm text-muted-foreground">
					Database and volume backups land in a bucket here, through a key
					scoped to it. Backups of this same server don't protect against losing
					it; keep an off-site copy too.
				</p>
			</div>
			<Button
				variant="outline"
				onClick={() => {
					setError(undefined);
					setOpen(true);
				}}
			>
				<ArchiveRestore data-icon="inline-start" />
				Use for backups
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-md">
					<form
						className="grid gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<DialogHeader>
							<DialogTitle>Use as backup destination</DialogTitle>
							<DialogDescription>
								LogiStack creates the bucket if it is missing, a read and write
								key for it, and an S3 destination every backup policy can pick.
							</DialogDescription>
						</DialogHeader>
						<Field id="backup-bucket" label="Bucket" error={error}>
							<Input
								id="backup-bucket"
								value={bucket}
								onChange={(e) => {
									setBucket(e.target.value.toLowerCase());
									setError(undefined);
								}}
								aria-invalid={error ? true : undefined}
								aria-describedby="backup-bucket-msg"
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
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={make.isPending}>
								{make.isPending && <Loader2 className="animate-spin" />}
								Add destination
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</section>
	);
}

/** Endpoints, region and credentials an S3 client needs, plus the backups shortcut. */
export function Connection({
	serviceId,
	connection: c,
}: {
	serviceId: string;
	connection: StorageConnection | undefined;
}) {
	const params = useParams({
		from: "/_app/projects/$projectId/services/$serviceId",
	});
	if (!c)
		return (
			<Panel title="Endpoints" id="storage-endpoints">
				<SkeletonRows rows={5} />
			</Panel>
		);
	const engine = STORAGE_ENGINES[c.engine];
	return (
		<div className="grid gap-6">
			<Panel title="Endpoints" id="storage-endpoints">
				<dl className="divide-y">
					<Row label="Internal">
						<CopyField
							value={c.internalEndpoint}
							label="Copy internal endpoint"
						/>
						<p className="mt-1 text-xs text-muted-foreground">
							For services in the same environment.
						</p>
					</Row>
					<Row label="Public">
						{c.publicEndpoint ? (
							<CopyField
								value={c.publicEndpoint}
								label="Copy public endpoint"
							/>
						) : (
							<span className="text-muted-foreground">
								Off. Add a domain on port{" "}
								<span className="tabular">{engine.s3Port}</span> in{" "}
								<Link
									to="/projects/$projectId/services/$serviceId/domains"
									params={params}
									className="text-foreground underline decoration-muted-foreground/50 hover:decoration-foreground"
								>
									Domains
								</Link>{" "}
								to reach it from the internet.
							</span>
						)}
					</Row>
					<Row label="Console">
						{c.consoleUrl ? (
							<a
								href={c.consoleUrl}
								target="_blank"
								rel="noreferrer"
								className="group inline-flex max-w-full items-center gap-1 font-mono text-[13px] hover:underline"
							>
								<span className="truncate">{c.consoleUrl}</span>
								<ArrowUpRight
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
							</a>
						) : (
							<span className="text-muted-foreground">
								{c.capabilities.console
									? `Off. Add a domain on port ${engine.consolePort} to open the ${engine.label} console.`
									: `${engine.label} has no web console.`}
							</span>
						)}
					</Row>
					<Row label="Region">
						<span className="font-mono text-[13px]">{c.region}</span>
					</Row>
					<Row label="Addressing">
						Path-style{" "}
						<span className="text-muted-foreground">
							(endpoint/bucket/key). Set{" "}
							<code className="font-mono text-xs text-foreground">
								forcePathStyle
							</code>{" "}
							in your SDK.
						</span>
					</Row>
				</dl>
			</Panel>
			<Panel title="Root credentials" id="storage-root">
				<RootCredentials serviceId={serviceId} />
			</Panel>
			<EnvSnippet serviceId={serviceId} connection={c} />
			<BackupDestination serviceId={serviceId} />
		</div>
	);
}
