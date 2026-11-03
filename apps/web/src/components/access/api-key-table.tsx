import { createColumnHelper } from "@tanstack/react-table";
import { Bot, Loader2, MoreHorizontal, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SecretReveal } from "@/components/access/api-key-secret";
import { ConfirmDialog } from "@/components/access/confirm-dialog";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRevokeApiKey, useRotateApiKey } from "@/lib/api/access";
import type { ApiKey, CreatedApiKey } from "@/lib/api/access-types";
import { relativeTime } from "@/lib/format";
import type { StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Developer on Clients", "Viewer on Storefront +1", or the owner's whole access. */
export function scopeSummary(k: Pick<ApiKey, "scopes">) {
	const [first, ...rest] = k.scopes ?? [];
	if (!first) return "All of the owner's access";
	return `${capitalize(first.role)} on ${first.scopeLabel}${rest.length ? ` +${rest.length}` : ""}`;
}

export function keyStatus(k: ApiKey, now = Date.now()): StatusMeta {
	if (!k.enabled) return { label: "Revoked", tone: "idle" };
	if (k.expiresAt && Date.parse(k.expiresAt) < now)
		return { label: "Expired", tone: "warn" };
	return { label: "Active", tone: "ok" };
}

const usable = (k: ApiKey) => keyStatus(k).label === "Active";

function KeyActions({
	k,
	onRotate,
	onRevoke,
}: {
	k: ApiKey;
	onRotate: () => void;
	onRevoke: () => void;
}) {
	if (!usable(k)) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Actions for ${k.name ?? "key"}`}
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={onRotate}>
					<RotateCw /> Rotate
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onSelect={onRevoke}>
					<Trash2 /> Revoke
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const col = createColumnHelper<BaseFeatures, ApiKey>();

export function ApiKeyTable({ keys }: { keys: ApiKey[] }) {
	const [rotating, setRotating] = useState<ApiKey | null>(null);
	const [revoking, setRevoking] = useState<ApiKey | null>(null);
	const [created, setCreated] = useState<CreatedApiKey | null>(null);
	const rotate = useRotateApiKey();
	const revoke = useRevokeApiKey();

	const columns = col.columns([
		col.display({
			id: "name",
			header: "Name",
			meta: { className: "w-[24%] max-sm:w-auto" },
			cell: ({ row: { original: k } }) => (
				<div className={cn("min-w-0", !usable(k) && "opacity-60")}>
					<span className="block truncate font-medium">{k.name}</span>
					<span className="block truncate font-mono text-xs text-muted-foreground">
						{k.start}…
					</span>
					{/* Owner and access have their own columns from lg; below, they ride under the name. */}
					<span className="block truncate text-xs text-muted-foreground lg:hidden">
						{k.owner.name} · {scopeSummary(k)}
					</span>
				</div>
			),
		}),
		col.display({
			id: "owner",
			header: "Owner",
			meta: { className: "w-[16%] max-md:hidden" },
			cell: ({ row: { original: k } }) => (
				<span className="flex min-w-0 items-center gap-1.5">
					{k.owner.kind === "machine" && (
						<Bot
							className="size-3.5 shrink-0 text-muted-foreground"
							aria-label="Service account"
						/>
					)}
					<span className="truncate">{k.owner.name}</span>
				</span>
			),
		}),
		col.display({
			id: "access",
			header: "Access",
			meta: { className: "max-lg:hidden" },
			cell: ({ row: { original: k } }) => (
				<span
					className={cn("block truncate", !k.scopes && "text-muted-foreground")}
					title={k.scopes
						?.map((s) => `${capitalize(s.role)} on ${s.scopeLabel}`)
						.join("\n")}
				>
					{scopeSummary(k)}
				</span>
			),
		}),
		col.display({
			id: "lastUsed",
			header: "Last used",
			meta: { className: "w-[17%] max-sm:hidden" },
			cell: ({ row: { original: k } }) =>
				k.lastUsedAt ? (
					<div className="min-w-0">
						<time
							dateTime={k.lastUsedAt}
							title={new Date(k.lastUsedAt).toLocaleString()}
							className="block whitespace-nowrap"
						>
							{relativeTime(k.lastUsedAt)}
						</time>
						{k.lastIp && (
							<span className="block truncate font-mono text-xs text-muted-foreground">
								{k.lastIp}
							</span>
						)}
					</div>
				) : (
					<span className="text-muted-foreground">Never</span>
				),
		}),
		col.display({
			id: "expires",
			header: "Expires",
			meta: { className: "w-28 max-md:hidden" },
			cell: ({ row: { original: k } }) =>
				!k.enabled ? (
					<span className="text-muted-foreground">
						<span aria-hidden>–</span>
						<span className="sr-only">Not applicable</span>
					</span>
				) : k.expiresAt ? (
					<time
						dateTime={k.expiresAt}
						title={new Date(k.expiresAt).toLocaleString()}
						className="whitespace-nowrap text-muted-foreground"
					>
						{relativeTime(k.expiresAt)}
					</time>
				) : (
					<span className="text-muted-foreground">Never</span>
				),
		}),
		col.display({
			id: "status",
			header: "Status",
			meta: { className: "w-28" },
			cell: ({ row: { original: k } }) => {
				const meta = keyStatus(k);
				return (
					<span className="inline-flex items-center gap-2 whitespace-nowrap">
						<StatusDot meta={meta} />
						{meta.label}
					</span>
				);
			},
		}),
		col.display({
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			meta: { className: "w-14 text-right" },
			cell: ({ row: { original: k } }) => (
				<KeyActions
					k={k}
					onRotate={() => setRotating(k)}
					onRevoke={() => setRevoking(k)}
				/>
			),
		}),
	]);

	return (
		<>
			<DataTable
				label="API keys"
				columns={columns}
				data={keys}
				getRowId={(k) => k.id}
			/>

			<Dialog
				open={rotating !== null}
				onOpenChange={(o) => !o && setRotating(null)}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Rotate {rotating?.name}?</DialogTitle>
						<DialogDescription>
							A new secret replaces this one with the same owner, access and
							lifetime. The current secret stops working at once, so update
							every place that uses it.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setRotating(null)} autoFocus>
							Cancel
						</Button>
						<Button
							disabled={rotate.isPending}
							onClick={() => {
								if (!rotating) return;
								rotate.mutate(rotating.id, {
									onSuccess: (k) => {
										setRotating(null);
										setCreated(k);
									},
									onError: (err) =>
										toast.error("Couldn't rotate the key", {
											description: err.message,
										}),
								});
							}}
						>
							{rotate.isPending && <Loader2 className="animate-spin" />}
							Rotate key
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={created !== null}
				onOpenChange={(o) => !o && setCreated(null)}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>New secret for {created?.name}</DialogTitle>
						<DialogDescription>
							The old secret no longer works.
						</DialogDescription>
					</DialogHeader>
					{created && <SecretReveal created={created} />}
					<DialogFooter>
						<Button onClick={() => setCreated(null)}>Done</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={revoking !== null}
				onOpenChange={(o) => !o && setRevoking(null)}
				title={`Revoke ${revoking?.name}?`}
				description="Requests with this key fail from now on. It stays in the list as revoked for the record."
				confirmLabel="Revoke key"
				onConfirm={() =>
					revoke.mutateAsync(revoking?.id ?? "").then(
						() => toast.success(`${revoking?.name} revoked`),
						(err: Error) => {
							toast.error("Couldn't revoke the key", {
								description: err.message,
							});
							throw err;
						},
					)
				}
			/>
		</>
	);
}
