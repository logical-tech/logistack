import type { ServiceSignal } from "@/lib/api/types";
import { SERVICE_STATUS, severityRank, TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * Service health as a strip of cells, one per service, worst first. The shape
 * of a project's health reads at a glance before any label does.
 */
export function SignalStrip({
	services,
	size = "md",
	className,
}: {
	services: ServiceSignal[];
	size?: "sm" | "md";
	className?: string;
}) {
	const sorted = [...services].sort(
		(a, b) => severityRank(a.status) - severityRank(b.status),
	);
	const counts = new Map<string, number>();
	for (const s of services) {
		const label = SERVICE_STATUS[s.status].label.toLowerCase();
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const summary = [...counts].map(([label, n]) => `${n} ${label}`).join(", ");

	return (
		<div
			role="img"
			aria-label={
				services.length
					? `${services.length} services: ${summary}`
					: "No services yet"
			}
			className={cn("flex flex-wrap items-center gap-[3px]", className)}
		>
			{sorted.length === 0 && (
				<span
					className={cn(
						"rounded-[2px] bg-muted-foreground/15",
						size === "sm" ? "h-3 w-1.5" : "h-4 w-2",
					)}
				/>
			)}
			{sorted.map((s) => (
				<span
					key={s.id}
					title={`${s.name} · ${SERVICE_STATUS[s.status].label}`}
					className={cn(
						"rounded-[2px] transition-colors duration-(--duration-slow)",
						size === "sm" ? "h-3 w-1.5" : "h-4 w-2",
						TONE_DOT[SERVICE_STATUS[s.status].tone],
						s.status === "stopped" && "opacity-45",
					)}
				/>
			))}
		</div>
	);
}
