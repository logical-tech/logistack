import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/** Confirmation for an irreversible action; Cancel is the default focus. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	confirmLabel: string;
	/** Resolve to close; throw to keep the dialog open (the caller toasts the error). */
	onConfirm: () => Promise<unknown>;
}) {
	const [pending, setPending] = useState(false);
	async function confirm() {
		setPending(true);
		try {
			await onConfirm();
			onOpenChange(false);
		} catch {
			// The caller reported it; stay open so the person can retry or cancel.
		} finally {
			setPending(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)} autoFocus>
						Cancel
					</Button>
					<Button variant="destructive" onClick={confirm} disabled={pending}>
						{pending && <Loader2 className="animate-spin" />}
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
