import { formatDuration, parseDuration } from "@logistack/core/work";
import { Play, Plus, Square } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
	useCreateWorkTimeEntry,
	useStartWorkTimer,
	useStopWorkTimer,
	useWorkTimeEntries,
	useWorkTimer,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { clock, localDay, morningOf, useElapsed } from "./clock";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Task sheet "Time" row: timer, tracked vs estimate, and a manual entry popover. */
export function TaskTimeRow({
	taskId,
	estimateMinutes,
}: {
	taskId: string;
	estimateMinutes?: number | null;
}) {
	const { data: entries = [] } = useWorkTimeEntries(taskId);
	const { data: timer } = useWorkTimer();
	const start = useStartWorkTimer();
	const stop = useStopWorkTimer();
	const running = timer?.running?.taskId === taskId ? timer.running : null;
	const elapsed = useElapsed(running?.startedAt);
	const tracked =
		entries.reduce((s, e) => s + (e.endedAt ? (e.durationSec ?? 0) : 0), 0) +
		elapsed;
	const estimate = estimateMinutes ? estimateMinutes * 60 : 0;
	const ratio = estimate ? tracked / estimate : 0;

	return (
		<div className="flex min-w-0 items-center gap-2">
			<Button
				type="button"
				size="icon-sm"
				variant={running ? "default" : "outline"}
				aria-label={running ? "Stop timer" : "Start timer"}
				aria-keyshortcuts="t"
				disabled={start.isPending || stop.isPending}
				onClick={() =>
					running
						? stop.mutate(undefined)
						: start.mutate(taskId, {
								onError: (e) => toast.error(errorText(e)),
							})
				}
			>
				{running ? (
					<Square className="fill-current" />
				) : (
					<Play className="fill-current" />
				)}
			</Button>
			<div className="grid min-w-0 flex-1 gap-1">
				<p className="text-sm tabular">
					{running && (
						<span className="mr-2 font-medium">{clock(elapsed)}</span>
					)}
					<span className={running ? "text-muted-foreground" : undefined}>
						{formatDuration(tracked)}
					</span>
					{estimate > 0 && (
						<span className="text-muted-foreground">
							{" "}
							of {formatDuration(estimate)}
						</span>
					)}
				</p>
				{estimate > 0 && (
					<Progress
						aria-label="Tracked against estimate"
						value={Math.min(100, ratio * 100)}
						className={cn(
							ratio > 1 ? "[&>*]:bg-warn" : "[&>*]:bg-foreground/70",
						)}
					/>
				)}
			</div>
			<AddTimePopover taskId={taskId} />
		</div>
	);
}

function AddTimePopover({ taskId }: { taskId: string }) {
	const id = useId();
	const create = useCreateWorkTimeEntry();
	const [open, setOpen] = useState(false);
	const [duration, setDuration] = useState("");
	const [day, setDay] = useState(() => localDay(new Date()));
	const [note, setNote] = useState("");
	const [billable, setBillable] = useState(true);
	const [tried, setTried] = useState(false);
	const seconds = parseDuration(duration);
	const invalid = seconds === null || seconds < 60 || seconds > 24 * 3600;

	const submit = () => {
		setTried(true);
		if (invalid || seconds === null) return;
		create.mutate(
			{
				taskId,
				input: {
					startedAt: morningOf(day),
					durationSec: seconds,
					note: note.trim() || null,
					billable,
				},
			},
			{
				onSuccess: () => {
					setOpen(false);
					setDuration("");
					setNote("");
					setTried(false);
				},
				onError: (e) => toast.error(errorText(e)),
			},
		);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" size="sm" variant="ghost">
					<Plus data-icon="inline-start" />
					Add time
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72">
				<form
					className="grid gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<Field
						id={`${id}-d`}
						label="Duration"
						hint={seconds ? formatDuration(seconds) : "1h30, 90m, 1.5h or 1:30"}
						error={
							tried && invalid ? "Between 1 minute and 24 hours" : undefined
						}
					>
						<Input
							id={`${id}-d`}
							value={duration}
							onChange={(e) => setDuration(e.target.value)}
							placeholder="1h30"
							autoFocus
							aria-invalid={(tried && invalid) || undefined}
							aria-describedby={`${id}-d-msg`}
						/>
					</Field>
					<Field id={`${id}-day`} label="Date">
						<Input
							id={`${id}-day`}
							type="date"
							value={day}
							onChange={(e) => setDay(e.target.value)}
						/>
					</Field>
					<Field id={`${id}-n`} label="Note" optional>
						<Input
							id={`${id}-n`}
							value={note}
							maxLength={500}
							onChange={(e) => setNote(e.target.value)}
						/>
					</Field>
					<label
						htmlFor={`${id}-b`}
						className="flex items-center gap-2 text-sm"
					>
						<Checkbox
							id={`${id}-b`}
							checked={billable}
							onCheckedChange={(v) => setBillable(v === true)}
						/>
						Billable
					</label>
					<Button type="submit" disabled={create.isPending}>
						Add time
					</Button>
				</form>
			</PopoverContent>
		</Popover>
	);
}
