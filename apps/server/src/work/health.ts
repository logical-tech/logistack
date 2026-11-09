import type {
	ProjectHealth,
	WorkHealth,
	WorkServiceHealth,
} from "@logistack/contracts";
import { projectHealth, serviceHealth } from "@logistack/core";
import {
	type Db,
	deployment,
	domain,
	environment,
	monitor,
	monitorDaily,
	service,
	serviceMaintenance,
	serviceStatus,
	serviceThreshold,
	workProject,
} from "@logistack/db";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

/**
 * Section 6: the simplified health of projects. Reads ops tables server-side and returns only the
 * DTO of 6.3; nothing about deployments, replicas or nodes leaves this module.
 */

const IN_PROGRESS = [
	"queued",
	"cloning",
	"building",
	"pushing",
	"releasing",
	"deploying",
] as const;

type ServiceState = {
	projectId: string;
	id: string;
	name: string;
	icon: WorkServiceHealth["icon"];
	health: WorkHealth;
	since: string | null;
	monitorIds: string[];
};

/** Health of every service in the default environment of `projectIds`, hidden ones excluded. */
async function serviceStates(
	db: Db,
	projectIds: string[],
	now: Date,
): Promise<ServiceState[]> {
	if (projectIds.length === 0) return [];
	const hidden = new Set(
		(
			await db
				.select({ ids: workProject.hiddenServiceIds })
				.from(workProject)
				.where(inArray(workProject.projectId, projectIds))
		).flatMap((r) => r.ids),
	);
	const services = (
		await db
			.select({
				projectId: environment.projectId,
				id: service.id,
				name: service.name,
				icon: service.icon,
				desiredState: service.desiredState,
			})
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.where(
				and(
					inArray(environment.projectId, projectIds),
					eq(environment.isDefault, true),
					isNull(environment.preview),
				),
			)
			.orderBy(asc(service.name))
	).filter((s) => !hidden.has(s.id));
	const ids = services.map((s) => s.id);
	if (ids.length === 0) return [];
	const [statuses, maintenance, monitors, thresholds, deploys] =
		await Promise.all([
			db
				.select()
				.from(serviceStatus)
				.where(inArray(serviceStatus.serviceId, ids)),
			db
				.select()
				.from(serviceMaintenance)
				.where(inArray(serviceMaintenance.serviceId, ids)),
			db
				.select({
					id: monitor.id,
					serviceId: monitor.serviceId,
					status: monitor.status,
					changedAt: monitor.statusChangedAt,
				})
				.from(monitor)
				.where(and(inArray(monitor.serviceId, ids), eq(monitor.enabled, true))),
			db
				.select({ serviceId: serviceThreshold.serviceId })
				.from(serviceThreshold)
				.where(
					and(
						inArray(serviceThreshold.serviceId, ids),
						eq(serviceThreshold.enabled, true),
						eq(serviceThreshold.firing, true),
					),
				),
			db
				.select({
					serviceId: deployment.serviceId,
					since: sql<Date>`max(coalesce(${deployment.startedAt}, ${deployment.createdAt}))`,
				})
				.from(deployment)
				.where(
					and(
						inArray(deployment.serviceId, ids),
						inArray(deployment.status, [...IN_PROGRESS]),
					),
				)
				.groupBy(deployment.serviceId),
		]);
	const statusOf = new Map(statuses.map((s) => [s.serviceId, s]));
	const maintOf = new Map(maintenance.map((m) => [m.serviceId, m.settings]));
	const firing = new Set(thresholds.map((t) => t.serviceId));
	const deployingOf = new Map(deploys.map((d) => [d.serviceId, d.since]));
	return services.map((s) => {
		const st = statusOf.get(s.id);
		const mons = monitors.filter((m) => m.serviceId === s.id);
		const health = serviceHealth({
			desiredState: s.desiredState,
			maintenance: maintOf.get(s.id)?.enabled ?? false,
			status: st
				? {
						observed: st.observed,
						replicasRunning: st.replicasRunning,
						replicasDesired: st.replicasDesired,
						crashLoop: st.crashLoop !== null,
						changedAt: st.updatedAt,
					}
				: null,
			monitors: mons
				.filter((m) => m.status !== "paused")
				.map((m) => ({
					status:
						m.status === "up" || m.status === "down" ? m.status : "pending",
					inMaintenance: m.status === "maintenance",
				})),
			thresholdFiring: firing.has(s.id),
			deployingSince: deployingOf.has(s.id)
				? new Date(deployingOf.get(s.id) as Date)
				: null,
			now,
		});
		// shortcut: no health history table, so `since` is the latest monitor transition; add a transitions table if PMs need it for monitor-less services.
		const changed = mons
			.map((m) => m.changedAt.getTime())
			.sort((a, b) => b - a)[0];
		return {
			projectId: s.projectId,
			id: s.id,
			name: s.name,
			icon: s.icon,
			health,
			since: changed ? new Date(changed).toISOString() : null,
			monitorIds: mons.map((m) => m.id),
		};
	});
}

/** Earliest `since` among the services that set the project's state. */
function projectSince(states: ServiceState[], health: WorkHealth) {
	const times = states
		.filter((s) => s.health === health && s.since)
		.map((s) => s.since as string)
		.sort();
	return times[0] ?? null;
}

/** `health` and `since` per project, for the projects grid. */
export async function healthOfProjects(
	db: Db,
	projectIds: string[],
	now = new Date(),
): Promise<Map<string, { health: WorkHealth; since: string | null }>> {
	const states = await serviceStates(db, projectIds, now);
	return new Map(
		projectIds.map((id) => {
			const mine = states.filter((s) => s.projectId === id);
			const health = projectHealth(mine.map((s) => s.health));
			return [id, { health, since: projectSince(mine, health) }];
		}),
	);
}

const dayHealth = (r: {
	checks: number;
	failures: number;
	maintenance: number;
}): WorkHealth =>
	r.checks === 0
		? "unknown"
		: r.maintenance >= r.checks
			? "maintenance"
			: r.failures === 0
				? "operational"
				: r.failures >= r.checks - r.maintenance
					? "down"
					: "degraded";

/** The section 6.3 DTO, exactly. */
export async function healthOfProject(
	db: Db,
	projectId: string,
	now = new Date(),
): Promise<ProjectHealth> {
	const states = await serviceStates(db, [projectId], now);
	const ids = states.map((s) => s.id);
	const monitorIds = states.flatMap((s) => s.monitorIds);
	const from = new Date(now.getTime() - 29 * 86_400_000)
		.toISOString()
		.slice(0, 10);
	const [daily, domains] = await Promise.all([
		monitorIds.length
			? db
					.select()
					.from(monitorDaily)
					.where(
						and(
							inArray(monitorDaily.monitorId, monitorIds),
							gte(monitorDaily.day, from),
						),
					)
			: [],
		ids.length
			? db
					.select({
						serviceId: domain.serviceId,
						hostname: domain.hostname,
						pathPrefix: domain.pathPrefix,
					})
					.from(domain)
					.where(
						and(
							inArray(domain.serviceId, ids),
							eq(domain.https, true),
							isNull(domain.redirectTo),
						),
					)
					.orderBy(asc(domain.isGenerated), asc(domain.createdAt))
			: [],
	]);
	const days = Array.from({ length: 30 }, (_, i) =>
		new Date(now.getTime() - (29 - i) * 86_400_000).toISOString().slice(0, 10),
	);
	const services: WorkServiceHealth[] = states.map((s) => {
		const rows = daily.filter((d) => s.monitorIds.includes(d.monitorId));
		const byDay = new Map<
			string,
			{ checks: number; failures: number; maintenance: number }
		>();
		for (const r of rows) {
			const d = byDay.get(r.day) ?? { checks: 0, failures: 0, maintenance: 0 };
			d.checks += r.checks;
			d.failures += r.failures;
			d.maintenance += r.maintenance;
			byDay.set(r.day, d);
		}
		const checks = rows.reduce((a, r) => a + r.checks - r.maintenance, 0);
		const failures = rows.reduce((a, r) => a + r.failures, 0);
		const d = domains.find((x) => x.serviceId === s.id);
		const hasMonitor = s.monitorIds.length > 0;
		return {
			id: s.id,
			name: s.name,
			icon: s.icon,
			health: s.health,
			since: s.since,
			uptime30d:
				hasMonitor && checks > 0
					? Math.round((1 - failures / checks) * 10_000) / 100
					: null,
			days: hasMonitor
				? days.map((date) => ({
						date,
						health: dayHealth(
							byDay.get(date) ?? { checks: 0, failures: 0, maintenance: 0 },
						),
					}))
				: null,
			url: d ? `https://${d.hostname}${d.pathPrefix ?? ""}` : null,
		};
	});
	const health = projectHealth(states.map((s) => s.health));
	return { health, since: projectSince(states, health), services };
}
