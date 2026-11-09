import { Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	useStartWorkTimer,
	useStopWorkTimer,
	useWorkTimer,
} from "@/lib/api/work-queries";
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

/**
 * `work:timer-toggle` (the task sheet's `t`): stops the timer when it runs on that task, else
 * starts it there (the server stops any other running timer). Mounted once with the Work layer.
 */
export function useTimerToggle() {
	const { data } = useWorkTimer();
	const start = useStartWorkTimer();
	const stop = useStopWorkTimer();
	const live = useRef({ data, start, stop });
	live.current = { data, start, stop };
	useEffect(() => {
		const onToggle = (e: Event) => {
			const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
			const { data, start, stop } = live.current;
			if (!taskId || start.isPending || stop.isPending) return;
			const onError = (err: unknown) =>
				toast.error(err instanceof Error ? err.message : String(err));
			if (data?.running?.taskId === taskId) stop.mutate(undefined, { onError });
			else start.mutate(taskId, { onError });
		};
		window.addEventListener("work:timer-toggle", onToggle);
		return () => window.removeEventListener("work:timer-toggle", onToggle);
	}, []);
}
