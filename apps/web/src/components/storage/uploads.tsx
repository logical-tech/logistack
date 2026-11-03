import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { storageApi, type UploadHandle } from "@/lib/api/storage";
import { formatBytes } from "@/lib/metrics";
import { cn } from "@/lib/utils";

export type UploadState =
	| "queued"
	| "uploading"
	| "done"
	| "failed"
	| "cancelled";

export type Upload = {
	id: string;
	bucket: string;
	key: string;
	name: string;
	size: number;
	loaded: number;
	state: UploadState;
	error?: string;
};

/** Parallel uploads per browser tab; the rest wait their turn. */
const PARALLEL = 3;
let seq = 0;

/** Upload queue for one storage service: per-file progress, cancel, and a refresh as each lands. */
export function useUploads(serviceId: string) {
	const qc = useQueryClient();
	const [uploads, setUploads] = useState<Upload[]>([]);
	const files = useRef(new Map<string, File>());
	const handles = useRef(new Map<string, UploadHandle>());

	const patch = useCallback(
		(id: string, p: Partial<Upload>) =>
			setUploads((all) => all.map((u) => (u.id === id ? { ...u, ...p } : u))),
		[],
	);

	const add = useCallback((bucket: string, prefix: string, list: File[]) => {
		const next = list.map((file): Upload => {
			seq += 1;
			const id = `up${seq}`;
			files.current.set(id, file);
			return {
				id,
				bucket,
				key: prefix + file.name,
				name: file.name,
				size: file.size,
				loaded: 0,
				state: "queued",
			};
		});
		setUploads((all) => [...all, ...next]);
	}, []);

	useEffect(() => {
		const active = uploads.filter((u) => u.state === "uploading").length;
		const waiting = uploads
			.filter((u) => u.state === "queued")
			.slice(0, PARALLEL - active);
		for (const u of waiting) {
			const file = files.current.get(u.id);
			if (!file) continue;
			patch(u.id, { state: "uploading" });
			const handle = storageApi.objects.upload(
				serviceId,
				u.bucket,
				u.key,
				file,
				(loaded) => patch(u.id, { loaded }),
			);
			handles.current.set(u.id, handle);
			handle.done
				.then(
					() => {
						patch(u.id, { state: "done", loaded: u.size });
						qc.invalidateQueries({ queryKey: ["storage", serviceId] });
					},
					(e: unknown) =>
						patch(
							u.id,
							e instanceof DOMException && e.name === "AbortError"
								? { state: "cancelled" }
								: {
										state: "failed",
										error: e instanceof Error ? e.message : String(e),
									},
						),
				)
				.finally(() => {
					handles.current.delete(u.id);
					files.current.delete(u.id);
				});
		}
	}, [uploads, serviceId, patch, qc]);

	const cancel = useCallback(
		(id: string) => {
			const h = handles.current.get(id);
			if (h) h.abort();
			else patch(id, { state: "cancelled" });
		},
		[patch],
	);

	const clear = useCallback(() => {
		for (const h of handles.current.values()) h.abort();
		setUploads([]);
	}, []);

	return { uploads, add, cancel, clear };
}

const settled = (u: Upload) =>
	u.state === "done" || u.state === "failed" || u.state === "cancelled";

function Title({ uploads }: { uploads: Upload[] }) {
	const open = uploads.filter((u) => !settled(u)).length;
	const failed = uploads.filter((u) => u.state === "failed").length;
	if (open)
		return (
			<>
				Uploading {open} {open === 1 ? "file" : "files"}
			</>
		);
	if (failed)
		return (
			<>
				{failed} {failed === 1 ? "upload" : "uploads"} failed
			</>
		);
	return <>Uploads complete</>;
}

/** Floating tray at the bottom of the browser; stays until dismissed so a failure is not missed. */
export function UploadTray({
	uploads,
	onCancel,
	onClear,
}: {
	uploads: Upload[];
	onCancel: (id: string) => void;
	onClear: () => void;
}) {
	if (!uploads.length) return null;
	const busy = uploads.some((u) => !settled(u));
	const total = uploads.reduce((a, u) => a + u.size, 0);
	const loaded = uploads.reduce((a, u) => a + u.loaded, 0);
	return (
		<section
			aria-label="Uploads"
			className="t-reveal fixed inset-x-3 bottom-3 z-40 overflow-hidden rounded-xl bg-popover shadow-float ring-1 ring-foreground/10 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
		>
			<header className="flex items-center gap-3 border-b px-4 py-2.5">
				<div className="min-w-0 flex-1" aria-live="polite">
					<h2 className="text-sm font-medium [font-stretch:100%]">
						<Title uploads={uploads} />
					</h2>
					<p className="text-xs text-muted-foreground tabular">
						{formatBytes(loaded)} of {formatBytes(total)}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onClear}
					aria-label={busy ? "Cancel all uploads" : "Dismiss uploads"}
				>
					<X />
				</Button>
			</header>
			<ul className="max-h-72 divide-y overflow-y-auto">
				{uploads.map((u) => {
					const pct = u.size ? Math.round((u.loaded / u.size) * 100) : 100;
					return (
						<li key={u.id} className="flex items-center gap-3 px-4 py-2.5">
							<span className="grid size-4 shrink-0 place-items-center">
								{u.state === "done" ? (
									<CircleCheck
										className="t-reveal size-4 text-ok-text"
										aria-label="Uploaded"
									/>
								) : u.state === "failed" ? (
									<CircleAlert
										className="size-4 text-bad-text"
										aria-label="Failed"
									/>
								) : u.state === "uploading" ? (
									<Loader2
										className="size-4 animate-spin text-muted-foreground"
										aria-hidden
									/>
								) : (
									<span className="size-1.5 rounded-full bg-idle" aria-hidden />
								)}
							</span>
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline gap-2">
									<span
										className="min-w-0 flex-1 truncate text-sm"
										title={u.key}
									>
										{u.name}
									</span>
									<span
										className={cn(
											"shrink-0 text-xs tabular",
											u.state === "failed"
												? "text-bad-text"
												: "text-muted-foreground",
										)}
									>
										{u.state === "uploading"
											? `${pct}%`
											: u.state === "queued"
												? "Waiting"
												: u.state === "cancelled"
													? "Cancelled"
													: u.state === "failed"
														? "Failed"
														: formatBytes(u.size)}
									</span>
								</div>
								{u.state === "failed" && u.error ? (
									<p
										className="mt-0.5 truncate text-xs text-bad-text"
										title={u.error}
									>
										{u.error}
									</p>
								) : (
									<div
										role="progressbar"
										aria-label={`${u.name} upload`}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={pct}
										className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
									>
										<div
											className={cn(
												"h-full rounded-full transition-[width] duration-(--duration-fast) ease-linear",
												u.state === "done" ? "bg-ok" : "bg-foreground",
												u.state === "cancelled" && "bg-idle",
											)}
											style={{ width: `${pct}%` }}
										/>
									</div>
								)}
							</div>
							{!settled(u) && (
								<Button
									variant="ghost"
									size="icon-xs"
									onClick={() => onCancel(u.id)}
									aria-label={`Cancel ${u.name}`}
									className="text-muted-foreground"
								>
									<X />
								</Button>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
