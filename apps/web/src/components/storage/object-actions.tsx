import { ObjectKey } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import {
	Download,
	FileQuestion,
	Link2,
	Loader2,
	Pencil,
	Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
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
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	objectMetaQuery,
	type ShareLink,
	storageApi,
	useStorageMutation,
} from "@/lib/api/storage";
import { relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { baseName, previewKind } from "./objects";

export const errorText = (e: unknown) =>
	e instanceof Error ? e.message : String(e);

/** Downloads are attachments, so a plain link click saves the file without leaving the page. */
export function download(serviceId: string, bucket: string, key: string) {
	const a = document.createElement("a");
	a.href = storageApi.objects.downloadUrl(serviceId, bucket, key);
	a.download = baseName(key);
	a.click();
}

/** Previews read the whole object, so they stop at a size a browser tab handles comfortably. */
const PREVIEW_LIMIT = { image: 20 * 1024 ** 2, text: 2 * 1024 ** 2 } as const;

type Target = { bucket: string; key: string };

function Preview({
	serviceId,
	bucket,
	objectKey,
	contentType,
	size,
}: {
	serviceId: string;
	bucket: string;
	objectKey: string;
	contentType: string | null;
	size: number;
}) {
	const kind = previewKind(objectKey, contentType);
	const tooBig = kind !== null && size > PREVIEW_LIMIT[kind];
	const blob = useQuery({
		queryKey: ["storage", serviceId, "preview", bucket, objectKey],
		queryFn: () => storageApi.objects.fetch(serviceId, bucket, objectKey),
		enabled: kind !== null && !tooBig,
		staleTime: 60_000,
	});
	const [url, setUrl] = useState<string | null>(null);
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		const b = blob.data;
		if (!b) return;
		if (kind === "image") {
			const u = URL.createObjectURL(b);
			setUrl(u);
			return () => URL.revokeObjectURL(u);
		}
		b.text().then((t) => {
			if (objectKey.endsWith(".json"))
				try {
					setText(JSON.stringify(JSON.parse(t), null, 2));
					return;
				} catch {}
			setText(t);
		});
	}, [blob.data, kind, objectKey]);

	const frame =
		"grid min-h-48 place-items-center overflow-hidden rounded-lg bg-muted/60 dark:bg-muted/40";
	if (kind === null || tooBig)
		return (
			<div className={frame}>
				<p className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
					<FileQuestion className="size-5" strokeWidth={1.75} aria-hidden />
					{tooBig
						? `Too large to preview here (${formatBytes(size)}). Download it instead.`
						: "No preview for this type. Images, text and JSON open here."}
				</p>
			</div>
		);
	if (blob.isError)
		return (
			<div className={frame}>
				<p className="px-6 py-10 text-sm text-bad-text">
					{errorText(blob.error)}
				</p>
			</div>
		);
	if (kind === "image")
		return (
			<div className={frame}>
				{url ? (
					<img
						src={url}
						alt={baseName(objectKey)}
						className="t-reveal max-h-[50vh] w-full object-contain outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
					/>
				) : (
					<span className="t-skel h-48 w-full bg-muted-foreground/10" />
				)}
			</div>
		);
	return text === null ? (
		<div className={frame}>
			<Loader2 className="size-4 animate-spin text-muted-foreground" />
		</div>
	) : (
		<pre className="t-reveal max-h-[50vh] overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-5 dark:bg-muted/40">
			{text}
		</pre>
	);
}

/** The side pane for one object: preview, metadata and every action on it. */
export function ObjectSheet({
	serviceId,
	target,
	onClose,
	onShare,
	onRename,
	onDelete,
}: {
	serviceId: string;
	target: Target | null;
	onClose: () => void;
	onShare: (t: Target) => void;
	onRename: (t: Target) => void;
	onDelete: (t: Target) => void;
}) {
	const meta = useQuery({
		...objectMetaQuery(serviceId, target?.bucket ?? "", target?.key ?? ""),
		enabled: !!target,
	});
	const m = meta.data;
	const s3Url = target ? `s3://${target.bucket}/${target.key}` : "";
	return (
		<Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
			<SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
				{target && (
					<>
						<SheetHeader className="pr-12">
							<SheetTitle className="truncate" title={target.key}>
								{baseName(target.key)}
							</SheetTitle>
							<SheetDescription className="truncate font-mono text-xs">
								{target.bucket}/{target.key}
							</SheetDescription>
						</SheetHeader>
						<div className="grid gap-5 px-4 pb-6">
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									onClick={() => download(serviceId, target.bucket, target.key)}
								>
									<Download data-icon="inline-start" />
									Download
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => onShare(target)}
								>
									<Link2 data-icon="inline-start" />
									Share link
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => onRename(target)}
								>
									<Pencil data-icon="inline-start" />
									Rename
								</Button>
								<Button
									size="sm"
									variant="ghost"
									className="text-bad-text"
									onClick={() => onDelete(target)}
								>
									<Trash2 data-icon="inline-start" />
									Delete
								</Button>
							</div>
							{m ? (
								<Preview
									serviceId={serviceId}
									bucket={target.bucket}
									objectKey={target.key}
									contentType={m.contentType}
									size={m.size}
								/>
							) : (
								<div className="t-skel h-48 rounded-lg bg-muted-foreground/10" />
							)}
							<dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
								<dt className="text-muted-foreground">Size</dt>
								<dd className="tabular">
									{m
										? `${formatBytes(m.size)} (${m.size.toLocaleString("en")} bytes)`
										: "…"}
								</dd>
								<dt className="text-muted-foreground">Type</dt>
								<dd className="truncate font-mono text-xs leading-5">
									{m ? (m.contentType ?? "Unknown") : "…"}
								</dd>
								<dt className="text-muted-foreground">Modified</dt>
								<dd>
									{m?.lastModified
										? `${new Date(m.lastModified).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}, ${relativeTime(m.lastModified)}`
										: "…"}
								</dd>
								<dt className="text-muted-foreground">ETag</dt>
								<dd className="truncate font-mono text-xs leading-5">
									{m?.etag?.replaceAll('"', "") ?? "…"}
								</dd>
								{m &&
									Object.entries(m.metadata).map(([k, v]) => (
										<div key={k} className="contents">
											<dt className="truncate text-muted-foreground">{k}</dt>
											<dd className="truncate font-mono text-xs leading-5">
												{v}
											</dd>
										</div>
									))}
							</dl>
							<div className="grid gap-1.5">
								<span className="text-sm font-medium">S3 URL</span>
								<CopyField value={s3Url} label="Copy S3 URL" />
							</div>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

const EXPIRIES = [
	{ value: "3600", label: "1 hour" },
	{ value: "86400", label: "1 day" },
	{ value: "604800", label: "7 days" },
] as const;

export function ShareDialog({
	serviceId,
	target,
	onClose,
}: {
	serviceId: string;
	target: Target | null;
	onClose: () => void;
}) {
	const [expiry, setExpiry] =
		useState<(typeof EXPIRIES)[number]["value"]>("86400");
	const [link, setLink] = useState<ShareLink | null>(null);
	const [busy, setBusy] = useState(false);
	// A fresh dialog per object: no link from the previous one survives.
	useEffect(() => {
		if (target) setLink(null);
	}, [target]);
	const create = async () => {
		if (!target) return;
		setBusy(true);
		try {
			setLink(
				await storageApi.objects.share(
					serviceId,
					target.bucket,
					target.key,
					Number(expiry),
				),
			);
		} catch (e) {
			toast.error("Couldn't create the link", { description: errorText(e) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Share link</DialogTitle>
					<DialogDescription>
						Anyone with the link can download{" "}
						<span className="font-mono text-xs text-foreground">
							{target ? baseName(target.key) : ""}
						</span>{" "}
						until it expires. The bucket stays private.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span className="text-sm font-medium">Expires after</span>
						<Segmented
							label="Expires after"
							value={expiry}
							onChange={(v) => {
								setExpiry(v);
								setLink(null);
							}}
							options={[...EXPIRIES]}
						/>
					</div>
					{link && (
						<div className="t-reveal grid gap-1.5" aria-live="polite">
							<CopyField value={link.url} label="Copy share link" />
							<p className="text-xs text-muted-foreground">
								Expires{" "}
								{new Date(link.expiresAt).toLocaleString("en-GB", {
									dateStyle: "medium",
									timeStyle: "short",
								})}
								.{" "}
								{link.via === "s3"
									? "Signed for the public S3 endpoint; it stops working when it expires."
									: "Served through LogiStack, since the S3 endpoint has no public domain."}
							</p>
						</div>
					)}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						{link ? "Done" : "Cancel"}
					</Button>
					{!link && (
						<Button onClick={create} disabled={busy}>
							{busy && <Loader2 className="animate-spin" />}
							Create link
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Renames within the bucket; a slash in the new name moves it into that folder. */
export function RenameDialog({
	serviceId,
	target,
	onClose,
	onRenamed,
}: {
	serviceId: string;
	target: Target | null;
	onClose: () => void;
	onRenamed: (t: Target) => void;
}) {
	const dir = target
		? target.key.slice(0, target.key.length - baseName(target.key).length)
		: "";
	const [name, setName] = useState("");
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (target) {
			setName(baseName(target.key));
			setError(undefined);
		}
	}, [target]);
	const move = useStorageMutation(serviceId, (t: Target & { to: string }) =>
		storageApi.objects.move(serviceId, t.bucket, t.key, t.to),
	);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!target) return;
		const to = dir + name.trim().replace(/^\/+/, "");
		const parsed = ObjectKey.safeParse(to);
		if (!name.trim() || name.endsWith("/"))
			return setError("Enter a file name.");
		if (!parsed.success)
			return setError(parsed.error.issues[0]?.message ?? "Invalid name.");
		if (to === target.key) return onClose();
		move.mutate(
			{ ...target, to },
			{
				onSuccess: () => {
					toast.success(`Renamed to ${baseName(to)}`);
					onRenamed({ bucket: target.bucket, key: to });
				},
				onError: (err) => setError(errorText(err)),
			},
		);
	};
	return (
		<Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>Rename</DialogTitle>
						<DialogDescription>
							S3 has no rename: LogiStack copies the object to the new name,
							then deletes the old one.
						</DialogDescription>
					</DialogHeader>
					<Field
						id="rename-name"
						label="New name"
						error={error}
						hint={
							dir
								? `In ${dir}. Use a slash to move it into a folder.`
								: "Use a slash to move it into a folder."
						}
					>
						<Input
							id="rename-name"
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setError(undefined);
							}}
							aria-invalid={error ? true : undefined}
							aria-describedby="rename-name-msg"
							spellCheck={false}
							autoCapitalize="none"
							className="font-mono"
							autoFocus
							onFocus={(e) => {
								const dot = e.target.value.lastIndexOf(".");
								e.target.setSelectionRange(
									0,
									dot > 0 ? dot : e.target.value.length,
								);
							}}
						/>
					</Field>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={move.isPending}>
							{move.isPending && <Loader2 className="animate-spin" />}
							Rename
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
