import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/** A destructive or consequential action, confirmed with its own named button. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	destructive = true,
	pending,
	confirmDisabled,
	onConfirm,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	confirmLabel: string;
	destructive?: boolean;
	pending: boolean;
	/** Holds the confirm button back, e.g. until the name is typed. */
	confirmDisabled?: boolean;
	onConfirm: () => void;
	children?: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{children}
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
						variant={destructive ? "destructive" : "default"}
						disabled={pending || confirmDisabled}
						onClick={onConfirm}
					>
						{pending && <Loader2 className="animate-spin" />}
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
