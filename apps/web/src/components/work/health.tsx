/* Plain-language service health for people who don't run the servers (section 6.4). */
import type { WorkHealth, WorkServiceHealth } from "@logistack/contracts";
import { ArrowUpRight } from "lucide-react";
import { BrandIcon } from "@/components/brand-icon";
import { UptimeBars } from "@/components/uptime/parts";
import type { UptimeDay } from "@/lib/api/uptime";
import { HEALTH } from "./lib";
import { HealthPill } from "./parts";

const DAY_STATUS: Record<WorkHealth, UptimeDay["status"]> = {
	operational: "up",
	degraded: "degraded",
	down: "down",
	maintenance: "maintenance",
	paused: "none",
	unknown: "none",
};

/** The 30 daily bars, reusing the uptime component. */
function HealthDays({
	days,
}: {
	days: NonNullable<WorkServiceHealth["days"]>;
}) {
	return (
		<UptimeBars
			className="mt-3"
			days={days.map(
				(d) =>
					({
						day: d.date,
						status: DAY_STATUS[d.health],
						uptime: d.health === "operational" ? 100 : null,
					}) as UptimeDay,
			)}
		/>
	);
}

export function ServiceHealthList({
	services,
}: {
	services: WorkServiceHealth[];
}) {
	return (
		<ul className="divide-y">
			{services.map((s) => (
				<li key={s.id} className="py-4 first:pt-0 last:pb-0">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted">
							{s.icon ? (
								<BrandIcon slug={s.icon} className="size-4" />
							) : (
								<span className="size-2 rounded-full bg-muted-foreground/40" />
							)}
						</span>
						<span className="min-w-0 font-medium">{s.name}</span>
						<HealthPill health={s.health} since={s.since} className="text-xs" />
						<span className="ml-auto flex items-center gap-3">
							{s.uptime30d !== null && (
								<span className="text-xs text-muted-foreground tabular">
									{s.uptime30d.toFixed(2)}% up, 30 days
								</span>
							)}
							{s.url && (
								<a
									href={s.url}
									target="_blank"
									rel="noreferrer noopener"
									className="inline-flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground"
								>
									Open
									<ArrowUpRight className="size-3.5" aria-hidden />
									<span className="sr-only">{s.name} in a new tab</span>
								</a>
							)}
						</span>
					</div>
					{s.health !== "operational" && s.health !== "unknown" && (
						<p className="mt-1.5 pl-10 text-sm text-pretty text-muted-foreground">
							{HEALTH[s.health].copy}
						</p>
					)}
					{s.days && <HealthDays days={s.days} />}
				</li>
			))}
		</ul>
	);
}
