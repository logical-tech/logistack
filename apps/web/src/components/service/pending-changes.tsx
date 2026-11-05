import { LockKeyhole, Minus, PenLine, Plus } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
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
import type { PendingChange, PendingDiff } from "@/lib/api/service-ops";
import { cn } from "@/lib/utils";

type Kind = "added" | "removed" | "changed";

function kindOf(c: PendingChange): Kind {
	if ("op" in c) return c.op;
	if (c.area === "healthcheck")
		return c.before === null
			? "added"
			: c.after === null
				? "removed"
				: "changed";
	return "changed";
}

const KIND = {
	added: { Icon: Plus, label: "Added", tone: "text-ok-text" },
	removed: { Icon: Minus, label: "Removed", tone: "text-bad-text" },
	changed: { Icon: PenLine, label: "Changed", tone: "text-muted-foreground" },
} as const;

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** The values behind a summary line, when there are any worth reading. */
function Values({ change: c }: { change: PendingChange }) {
	if (c.area === "env" && c.secret)
		return (
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<LockKeyhole className="size-3" aria-hidden />
				Secret: the value is not shown
			</p>
		);
	const pair =
		c.area === "env" || c.area === "other"
			? [c.before, c.after]
			: c.area === "mount"
				? [c.before?.source, c.after?.source]
				: null;
	if (!pair || pair.every((v) => v === undefined || v === null)) return null;
	const [before, after] = pair;
	return (
		<p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-mono text-xs text-muted-foreground">
			{before !== undefined && before !== null && (
				<span className="max-w-full truncate line-through decoration-muted-foreground/50">
					{show(before)}
				</span>
			)}
			{before != null && after != null && <span aria-hidden>→</span>}
			{after !== undefined && after !== null && (
				<span className="max-w-full truncate text-foreground">
					{show(after)}
				</span>
			)}
		</p>
	);
}

/** "3 changes" in words a button and a title can share. */
export const changeCount = (n: number) =>
	`${n} pending ${n === 1 ? "change" : "changes"}`;

export function PendingChangesDialog({
	diff,
	open,
	onOpenChange,
	onDeploy,
	deploying,
}: {
	diff: PendingDiff;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeploy: () => void;
	deploying: boolean;
}) {
	const [view, setView] = useState<"summary" | "json">("summary");
	const json = JSON.stringify(
		diff.changes.map((c) => c.change),
		null,
		2,
	);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-0 p-0 sm:max-w-xl">
				<DialogHeader className="gap-1.5 px-5 pt-5 pb-4">
					<DialogTitle>Review changes</DialogTitle>
					<DialogDescription className="text-pretty">
						What the next deploy applies, compared with deployment{" "}
						<span className="font-mono">{diff.baseline?.deploymentId}</span>,
						the newest healthy one.
					</DialogDescription>
				</DialogHeader>
				<div className="flex items-center justify-between gap-3 border-y px-5 py-2">
					<span className="text-xs text-muted-foreground tabular">
						{changeCount(diff.changes.length)}
					</span>
					<div className="flex items-center gap-1">
						{view === "json" && (
							<CopyButton value={json} label="Copy the JSON diff" />
						)}
						<Segmented
							label="Diff view"
							value={view}
							onChange={setView}
							options={[
								{ value: "summary", label: "Summary" },
								{ value: "json", label: "JSON" },
							]}
						/>
					</div>
				</div>
				<div className="max-h-[min(60vh,32rem)] overflow-y-auto">
					{view === "json" ? (
						<pre className="px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-break-word">
							{json}
						</pre>
					) : (
						<ul className="divide-y">
							{diff.changes.map(({ summary, change }, i) => {
								const k = KIND[kindOf(change)];
								return (
									// biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole, never reordered
									<li key={i} className="flex gap-3 px-5 py-3">
										<k.Icon
											className={cn("mt-0.5 size-3.5 shrink-0", k.tone)}
											aria-label={k.label}
										/>
										<div className="flex min-w-0 flex-col gap-1">
											<p className="text-sm text-pretty first-letter:uppercase">
												{summary}
											</p>
											<Values change={change} />
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
				<DialogFooter className="mx-0 mb-0">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button disabled={deploying} onClick={onDeploy}>
						Deploy changes
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
