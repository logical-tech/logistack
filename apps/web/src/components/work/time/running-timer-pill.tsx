import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStopWorkTimer, useWorkTimer } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { clock, useElapsed } from "./clock";

/** Header pill for the signed-in person's running timer; renders nothing when none runs. */
export function RunningTimerPill({ className }: { className?: string }) {
	const { data } = useWorkTimer();
	const stop = useStopWorkTimer();
	const running = data?.running ?? null;
	const elapsed = useElapsed(running?.startedAt);
	if (!running) return null;
	return (
		<div
			className={cn(
				"t-reveal inline-flex h-8 items-center gap-2 rounded-full bg-card pr-1 pl-3 text-xs shadow-card ring-1 ring-border",
				className,
			)}
		>
			<span aria-hidden className="size-1.5 rounded-full bg-ok" />
			<span
				className="max-w-40 truncate font-mono text-muted-foreground"
				title={running.taskTitle}
			>
				{running.taskKey}
			</span>
			<span className="tabular font-medium">{clock(elapsed)}</span>
			<Button
				type="button"
				size="icon-xs"
				variant="ghost"
				className="rounded-full"
				aria-label={`Stop timer on ${running.taskKey}`}
				disabled={stop.isPending}
				onClick={() => stop.mutate(undefined)}
			>
				<Square className="fill-current" />
			</Button>
		</div>
	);
}
