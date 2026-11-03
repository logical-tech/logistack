import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import { Segmented } from "@/components/segmented";
import { LogViewer } from "@/components/service/log-viewer";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { overviewQuery, useLogStream } from "@/lib/api/service-ops";

const SINCE = { "5m": 300, "1h": 3_600, "24h": 86_400, all: null } as const;
type Since = keyof typeof SINCE;
const TAILS = ["100", "500", "2000", "all"] as const;

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/logs",
)({
	validateSearch: z.object({
		replica: z.string().optional().catch(undefined),
		since: z.enum(["5m", "1h", "24h", "all"]).optional().catch(undefined),
		tail: z.enum(TAILS).optional().catch(undefined),
	}),
	component: LogsTab,
});

function LogsTab() {
	const { serviceId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: service } = useQuery(overviewQuery(serviceId));
	const since: Since = search.since ?? "1h";
	const tail = search.tail ?? "500";
	const tasks = (service?.status.tasks ?? []).filter(
		(t) => t.state === "running",
	);
	const replica = tasks.some((t) => t.id === search.replica)
		? search.replica
		: undefined;

	// Fixed when the filter changes, so a re-render does not restart the stream.
	const options = useMemo(() => {
		const seconds = SINCE[since];
		return {
			tail: tail === "all" ? ("all" as const) : Number(tail),
			...(seconds ? { since: Math.floor(Date.now() / 1000) - seconds } : {}),
			...(replica ? { taskId: replica } : {}),
		};
	}, [since, tail, replica]);
	// A rollout replaces the replicas; follow the new ones.
	const epoch = tasks
		.map((t) => t.id)
		.sort()
		.join();
	const { lines, ended } = useLogStream(
		{ kind: "service", id: serviceId, options },
		epoch,
	);
	const set = (patch: Partial<typeof search>) =>
		navigate({ search: { ...search, ...patch }, replace: true });

	return (
		<LogViewer
			lines={lines}
			live={!ended}
			showSlot={!replica && tasks.length > 1}
			empty={
				ended === "no running replica"
					? "No replica is running, so there is nothing to follow. Start or deploy the service."
					: "No output in this window."
			}
			status={
				ended
					? ended === "no running replica"
						? "No running replica"
						: `Stream ended: ${ended}`
					: `Following ${replica ? "one replica" : `${tasks.length} ${tasks.length === 1 ? "replica" : "replicas"}`}`
			}
			className="h-[min(72vh,46rem)] max-sm:h-[72vh]"
			toolbar={
				<>
					<Select
						value={replica ?? "all"}
						onValueChange={(v) => set({ replica: v === "all" ? undefined : v })}
					>
						<SelectTrigger
							size="sm"
							aria-label="Replica"
							className="w-auto min-w-36"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All replicas</SelectItem>
							{tasks.map((t) => (
								<SelectItem key={t.id} value={t.id}>
									Replica #{t.slot ?? "?"}
									{t.hostname && (
										<span className="text-muted-foreground">
											{" "}
											on {t.hostname}
										</span>
									)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Segmented
						label="Since"
						value={since}
						onChange={(v) => set({ since: v })}
						options={[
							{ value: "5m", label: "5m", ariaLabel: "Last 5 minutes" },
							{ value: "1h", label: "1h", ariaLabel: "Last hour" },
							{ value: "24h", label: "24h", ariaLabel: "Last 24 hours" },
							{
								value: "all",
								label: "All",
								ariaLabel: "Since the replica started",
							},
						]}
					/>
					<Select
						value={tail}
						onValueChange={(v) => set({ tail: v as (typeof TAILS)[number] })}
					>
						<SelectTrigger
							size="sm"
							aria-label="Lines per replica"
							className="w-auto"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{TAILS.map((t) => (
								<SelectItem key={t} value={t}>
									{t === "all" ? "Every line" : `Last ${t}`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</>
			}
		/>
	);
}
