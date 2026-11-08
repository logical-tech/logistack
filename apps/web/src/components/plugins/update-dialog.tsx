import type { PermissionAction } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Minus, Plus, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ACTION_LABELS } from "@/lib/api/access";
import { useInvalidating } from "@/lib/api/networking";
import {
	type PluginInstall,
	type PluginUpdate,
	pluginsApi,
	pluginUpdatesQuery,
} from "@/lib/api/plugins";
import { relativeTime } from "@/lib/format";

const actionLabel = (a: string) =>
	ACTION_LABELS[a as PermissionAction]?.label ?? a;

function DiffList({
	title,
	added,
	removed,
	label = (x: string) => x,
}: {
	title: string;
	added: string[];
	removed: string[];
	label?: (x: string) => string;
}) {
	if (!added.length && !removed.length)
		return (
			<p className="text-sm text-muted-foreground">
				<span className="font-medium text-foreground">{title}:</span> no change
			</p>
		);
	return (
		<div className="grid gap-1.5">
			<p className="text-sm font-medium">{title}</p>
			<ul className="grid gap-1 text-sm">
				{added.map((x) => (
					<li key={`+${x}`} className="flex items-center gap-2">
						<Plus className="size-3.5 text-warn-text" aria-label="Added" />
						{label(x)}
					</li>
				))}
				{removed.map((x) => (
					<li
						key={`-${x}`}
						className="flex items-center gap-2 text-muted-foreground"
					>
						<Minus className="size-3.5" aria-label="Removed" />
						{label(x)}
					</li>
				))}
			</ul>
		</div>
	);
}

function VersionDetail({ u }: { u: PluginUpdate }) {
	return (
		<div className="grid gap-4">
			<div className="max-h-48 overflow-y-auto rounded-lg bg-muted/60 px-3.5 py-3 text-sm whitespace-pre-wrap text-pretty dark:bg-muted/40">
				{u.changelog?.trim() || (
					<span className="text-muted-foreground">No changelog.</span>
				)}
			</div>
			<DiffList
				title="Permissions"
				added={u.permissions.added}
				removed={u.permissions.removed}
				label={actionLabel}
			/>
			<DiffList
				title="Declared egress"
				added={u.egress.added}
				removed={u.egress.removed}
			/>
		</div>
	);
}

/** Explicit updates from the plugin's index: changelog, permission and egress diff, consent. */
export function UpdateDialog({
	p,
	open,
	onOpenChange,
}: {
	p: PluginInstall;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { data, isPending, error } = useQuery({
		...pluginUpdatesQuery(p.id),
		enabled: open,
	});
	const [picked, setPicked] = useState<string | null>(null);
	const [consent, setConsent] = useState(false);
	const update = useInvalidating(
		(v: { version: string; acceptPermissions: boolean }) =>
			pluginsApi.updateVersion(p.id, v),
		[["plugins"]],
	);
	const versions = data?.versions ?? [];
	const u = versions.find((x) => x.version === picked) ?? versions[0];
	const needsConsent = !!u?.permissions.added.length;
	const why = !u
		? null
		: !u.compatible
			? "This version needs a newer LogiStack."
			: u.missingPermissions.length
				? `It asks for ${u.missingPermissions.map(actionLabel).join(", ")}, which you don't hold.`
				: null;

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (o) {
					setPicked(null);
					setConsent(false);
				}
				onOpenChange(o);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Update {p.name}</DialogTitle>
					<DialogDescription>
						Installed: {p.version}. The plugin restarts on the new image with a
						new API token; you can roll back to {p.version} afterwards.
					</DialogDescription>
				</DialogHeader>
				{isPending ? (
					<p className="text-sm text-muted-foreground">Loading versions…</p>
				) : error ? (
					<p className="text-sm text-bad-text">
						{error instanceof Error ? error.message : String(error)}
					</p>
				) : !u ? (
					<p className="text-sm text-muted-foreground">
						{p.name} is up to date with its index's cache. Refresh the index in
						the Marketplace tab to look for new releases.
					</p>
				) : (
					<div className="grid gap-5">
						<div className="flex items-center justify-between gap-3">
							<Select
								value={u.version}
								onValueChange={(v) => {
									setPicked(v);
									setConsent(false);
								}}
							>
								<SelectTrigger className="w-44" aria-label="Version">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{versions.map((v) => (
										<SelectItem key={v.version} value={v.version}>
											{v.version}
											{v.verified ? "" : " (unverified)"}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<span className="text-xs text-muted-foreground">
								Published {relativeTime(u.publishedAt)}
							</span>
						</div>
						<VersionDetail u={u} />
						{needsConsent && !why && (
							<label
								htmlFor="update-consent"
								className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm"
							>
								<Checkbox
									id="update-consent"
									checked={consent}
									onCheckedChange={(c) => setConsent(c === true)}
									className="mt-0.5"
								/>
								<span>
									<span className="font-medium">
										Grant {u.permissions.added.map(actionLabel).join(", ")}.
									</span>{" "}
									<span className="text-muted-foreground">
										The plugin's API token gets these on the whole organization.
									</span>
								</span>
							</label>
						)}
						{why && (
							<p
								role="alert"
								className="flex items-start gap-2 text-sm text-bad-text"
							>
								<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								{why}
							</p>
						)}
					</div>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={
							!u || !!why || (needsConsent && !consent) || update.isPending
						}
						onClick={async () => {
							if (!u) return;
							try {
								await update.mutateAsync({
									version: u.version,
									acceptPermissions: needsConsent && consent,
								});
								toast.success(`${p.name} updated to ${u.version}`);
								onOpenChange(false);
							} catch (err) {
								toast.error(`Couldn't update ${p.name}`, {
									description: err instanceof Error ? err.message : String(err),
								});
							}
						}}
					>
						{update.isPending && <Loader2 className="animate-spin" />}
						{u ? `Update to ${u.version}` : "Update"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
