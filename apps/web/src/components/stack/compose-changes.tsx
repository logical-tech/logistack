import { Minus, PenLine, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { StackChange } from "@/lib/api/stacks";
import { cn } from "@/lib/utils";

const OP = {
	create: { Icon: Plus, label: "New", tone: "text-ok-text" },
	update: { Icon: PenLine, label: "Changed", tone: "text-muted-foreground" },
	remove: { Icon: Minus, label: "Removed", tone: "text-bad-text" },
} as const;

/** What a compose edit does to each container, confirmed before it is applied. */
export function ComposeChangesDialog({
	changes,
	open,
	onOpenChange,
	onApply,
	applying,
}: {
	changes: StackChange[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onApply: () => void;
	applying: boolean;
}) {
	const redeployed = changes.filter((c) => c.op !== "remove").length;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-0 p-0 sm:max-w-xl">
				<DialogHeader className="gap-1.5 px-5 pt-5 pb-4">
					<DialogTitle>Review compose changes</DialogTitle>
					<DialogDescription className="text-pretty">
						{changes.length
							? `Containers are matched by compose service name. ${redeployed} will deploy when you apply.`
							: "The stack already matches this file. Applying it changes nothing."}
					</DialogDescription>
				</DialogHeader>
				{changes.length > 0 && (
					<ul className="max-h-[min(60vh,32rem)] divide-y overflow-y-auto border-t">
						{changes.map((c) => {
							const op = OP[c.op];
							return (
								<li key={c.service} className="flex gap-3 px-5 py-3">
									<op.Icon
										className={cn("mt-1 size-3.5 shrink-0", op.tone)}
										aria-label={op.label}
									/>
									<div className="flex min-w-0 flex-col gap-1">
										<p className="font-mono text-sm">{c.service}</p>
										<ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
											{c.changes.map((line) => (
												<li
													key={line}
													className="text-pretty first-letter:uppercase"
												>
													{line}
												</li>
											))}
										</ul>
									</div>
								</li>
							);
						})}
					</ul>
				)}
				<DialogFooter className="mx-0 mb-0">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Keep editing
					</Button>
					<Button disabled={applying} onClick={onApply}>
						{changes.length ? "Apply and deploy" : "Save file"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
