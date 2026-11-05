import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import { Segmented } from "@/components/segmented";
import { LogViewer } from "@/components/service/log-viewer";
import { containerColors } from "@/components/stack/stack-observability";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useLogStreams } from "@/lib/api/service-ops";
import { stackQuery } from "@/lib/api/stacks";

const SINCE = { "5m": 300, "1h": 3_600, "24h": 86_400 } as const;
type Since = keyof typeof SINCE;

export const Route = createFileRoute(
	"/_app/projects/$projectId/stacks/$stackId/logs",
)({
	validateSearch: z.object({
		container: z.string().optional().catch(undefined),
		since: z.enum(["5m", "1h", "24h"]).optional().catch(undefined),
	}),
	component: StackLogs,
});

/** Every container's output on one timeline, each line tagged with its container. */
function StackLogs() {
	const { stackId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: stack } = useQuery(stackQuery(stackId));
	const services = stack?.services ?? [];
	const since: Since = search.since ?? "1h";
	const running = services.filter((s) => s.status.replicasRunning > 0);
	const picked = running.filter(
		(s) => !search.container || s.slug === search.container,
	);
	const colors = useMemo(() => containerColors(services), [services]);

	// Fixed when the filter changes, so a refetch of the stack does not restart the streams.
	const key = picked.map((s) => s.id).join();
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the picked ids
	const sources = useMemo(() => {
		const from = Math.floor(Date.now() / 1000) - SINCE[since];
		return picked.map((s) => ({
			tag: s.name,
			source: {
				kind: "service" as const,
				id: s.id,
				options: { tail: 500, since: from },
			},
		}));
	}, [key, since]);
	const { lines, ended } = useLogStreams(sources.length ? sources : null);
	const set = (patch: Partial<typeof search>) =>
		navigate({ search: { ...search, ...patch }, replace: true });

	return (
		<LogViewer
			lines={lines}
			live={sources.length > 0 && !ended}
			tags={search.container ? undefined : colors}
			empty={
				sources.length
					? "No output in this window."
					: "No container is running, so there is nothing to follow. Start or deploy the stack."
			}
			status={
				ended
					? `Streams ended: ${ended}`
					: `Following ${picked.length} of ${services.length} ${services.length === 1 ? "container" : "containers"}`
			}
			className="h-[min(72vh,46rem)] max-sm:h-[72vh]"
			toolbar={
				<>
					<Select
						value={search.container ?? "all"}
						onValueChange={(v) =>
							set({ container: v === "all" ? undefined : v })
						}
					>
						<SelectTrigger
							size="sm"
							aria-label="Container"
							className="w-auto min-w-40"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All containers</SelectItem>
							{services.map((s) => (
								<SelectItem
									key={s.id}
									value={s.slug}
									disabled={s.status.replicasRunning === 0}
								>
									<span
										aria-hidden
										className="size-2 rounded-full"
										style={{ background: colors.get(s.name) }}
									/>
									{s.name}
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
						]}
					/>
				</>
			}
		/>
	);
}
