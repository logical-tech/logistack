import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { daysUntil } from "@/lib/format";
import { TONE_TEXT, type Tone } from "@/lib/status";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/** A kind's icon on a neutral tile; the one visual every integration row starts with. */
export function KindTile({
	icon: Icon,
	className,
}: {
	icon: LucideIcon;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground",
				className,
			)}
		>
			<Icon className="size-4" strokeWidth={1.75} aria-hidden />
		</span>
	);
}

/** Days left on a certificate, toned warn inside 14 days and bad inside 3 or once expired. */
export function expiryTone(days: number): Tone | null {
	if (days <= 3) return "bad";
	if (days <= 14) return "warn";
	return null;
}

export function Expiry({
	notAfter,
	className,
}: {
	notAfter: string;
	className?: string;
}) {
	const now = useNow(60_000);
	const days = daysUntil(notAfter, now);
	const tone = expiryTone(days);
	const date = new Date(notAfter).toLocaleDateString("en", {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
	return (
		<span
			className={cn(
				"tabular whitespace-nowrap",
				tone ? TONE_TEXT[tone] : "text-foreground",
				className,
			)}
			title={new Date(notAfter).toISOString()}
		>
			{days < 0 ? "Expired" : days === 0 ? "Today" : `${days} days`}
			<span className="text-muted-foreground"> · {date}</span>
		</span>
	);
}

/** A mono value chip: zones, SANs, record names. */
export function DataChip({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex max-w-full items-center truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
			{children}
		</span>
	);
}

/** Confirms a destructive action; the API's refusal (409 in use) shows in the toast. */
export function ConfirmDelete({
	open,
	onOpenChange,
	title,
	description,
	action = "Delete",
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	action?: string;
	onConfirm: () => Promise<unknown>;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={busy}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await onConfirm();
								onOpenChange(false);
							} catch (err) {
								toast.error(`Couldn't ${action.toLowerCase()}`, {
									description: err instanceof Error ? err.message : String(err),
								});
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy && <Loader2 className="animate-spin" />}
						{action}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
