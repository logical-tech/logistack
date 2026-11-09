import type { ReactNode } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";

/** A wide dialog that hosts a step wizard (the rail sits beside the steps from `lg`). */
export function WizardDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 sm:max-w-4xl">
				<div>
					<DialogTitle className="text-base font-semibold">{title}</DialogTitle>
					<DialogDescription className="mt-1">{description}</DialogDescription>
				</div>
				{open && children}
			</DialogContent>
		</Dialog>
	);
}
