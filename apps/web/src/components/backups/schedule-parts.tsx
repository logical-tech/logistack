import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Box, Container, Loader2, Play, Server } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	type RunStatus,
	type Schedule,
	type ScheduleTarget,
	useRunSchedule,
} from "@/lib/api/backups";
import { nodesQuery } from "@/lib/api/monitoring";
import { projectsQuery } from "@/lib/api/projects";
import { formatBytes } from "@/lib/metrics";
import { RUN_STATUS } from "@/lib/status";
import { cn } from "@/lib/utils";

export const RunStatusLabel = ({
	status,
	className,
}: {
	status: RunStatus;
	className?: string;
}) => <StatusLabel meta={RUN_STATUS[status]} className={className} />;

/** "postgres · Storefront", "fra-1 host", "alpine:3.22", resolved from the lists already cached. */
export function TargetLabel({
	target,
	className,
}: {
	target: ScheduleTarget;
	className?: string;
}) {
	const { data: projects } = useQuery({
		...projectsQuery,
		enabled: target.kind === "service",
	});
	const { data: nodes } = useQuery({
		...nodesQuery,
		enabled: target.kind === "host",
	});
	const Icon =
		target.kind === "service"
			? Container
			: target.kind === "host"
				? Server
				: Box;
	let text: React.ReactNode;
	if (target.kind === "ephemeral")
		text = <span className="font-mono text-xs">{target.image}</span>;
	else if (target.kind === "host") {
		const n = nodes?.find((x) => x.id === target.nodeId);
		text = (
			<>
				<span className="font-mono text-xs">
					{n?.hostname ?? target.nodeId}
				</span>{" "}
				<span className="text-muted-foreground">host</span>
			</>
		);
	} else {
		const p = projects?.find((x) =>
			x.services.some((s) => s.id === target.serviceId),
		);
		const s = p?.services.find((x) => x.id === target.serviceId);
		text = (
			<>
				{s?.name ?? "Service"}
				{p && <span className="text-muted-foreground"> · {p.name}</span>}
			</>
		);
	}
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
			<Icon
				className="size-3.5 shrink-0 text-muted-foreground"
				strokeWidth={1.75}
				aria-hidden
			/>
			<span className="truncate">{text}</span>
		</span>
	);
}

/** A terminal-like pane that follows new output while the reader is at the bottom. */
export function OutputPane({
	text,
	running,
	empty,
	className,
}: {
	text: string;
	running: boolean;
	empty: string;
	className?: string;
}) {
	const ref = useRef<HTMLPreElement>(null);
	const pinned = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows each new chunk of text.
	useEffect(() => {
		const el = ref.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [text]);
	return (
		<pre
			ref={ref}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log must be reachable by keyboard to scroll it.
			tabIndex={0}
			role="log"
			aria-label="Run output"
			aria-live={running ? "polite" : undefined}
			aria-busy={running || undefined}
			onScroll={(e) => {
				const el = e.currentTarget;
				pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			}}
			className={cn(
				"max-h-[28rem] min-h-40 overflow-auto bg-muted/50 px-4 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words dark:bg-black/25",
				className,
			)}
		>
			{text || <span className="text-muted-foreground">{empty}</span>}
			{running && (
				<span
					aria-hidden
					className="ml-0.5 inline-block h-[1.1em] w-[0.55ch] translate-y-[0.2em] animate-pulse bg-foreground/60"
				/>
			)}
		</pre>
	);
}

/** Shown under a run whose output went past the stored cap. */
export function TruncatedNote({
	outputBytes,
	limit,
}: {
	outputBytes: number | null;
	limit: number;
}) {
	if (outputBytes === null || outputBytes <= limit) return null;
	return (
		<p className="text-xs text-muted-foreground">
			Truncated at {formatBytes(limit, true)}. The run printed{" "}
			{formatBytes(outputBytes, true)}; the rest was counted but not kept.
		</p>
	);
}

/** Queues a manual run; a skip under `forbid` is reported, not hidden. */
export function RunNowButton({
	s,
	variant = "ghost",
	label = false,
}: {
	s: Pick<Schedule, "id" | "name">;
	variant?: "ghost" | "outline";
	label?: boolean;
}) {
	const run = useRunSchedule();
	const navigate = useNavigate();
	return (
		<Button
			type="button"
			variant={variant}
			size={label ? "default" : "icon-sm"}
			aria-label={label ? undefined : `Run ${s.name} now`}
			disabled={run.isPending}
			onClick={() =>
				run.mutate(s.id, {
					onSuccess: (r) => {
						const open = () =>
							navigate({
								to: "/schedules/$scheduleId",
								params: { scheduleId: s.id },
								search: { run: r.id },
							});
						if (r.status === "skipped")
							toast(`${s.name} was skipped`, {
								description: r.error ?? "The previous run is still going.",
							});
						else
							toast.success(`${s.name} started`, {
								action: { label: "Watch", onClick: open },
							});
					},
					onError: (e) =>
						toast.error(`Couldn't run ${s.name}`, { description: e.message }),
				})
			}
		>
			{run.isPending ? (
				<Loader2 className="animate-spin" />
			) : (
				<Play data-icon={label ? "inline-start" : undefined} />
			)}
			{label && "Run now"}
		</Button>
	);
}
