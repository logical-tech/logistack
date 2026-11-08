import type { UptimeDay } from "@logistack/contracts";
import { totalUptime, uptimeBars } from "@logistack/core";
import {
	type Db,
	incident,
	incidentUpdate,
	monitorCheck,
	monitorDaily,
	monitorHourly,
} from "@logistack/db";
import { and, asc, desc, gte, inArray, sql } from "drizzle-orm";

// Reads behind the monitors list, the monitor page and the public status pages.

export type MonitorStats = {
	uptime24h: number | null;
	uptime30d: number | null;
	/** Newest last, at most 40. */
	recent: { at: Date; ok: boolean; latencyMs: number | null }[];
};

export async function monitorStats(
	db: Db,
	ids: string[],
	now = new Date(),
): Promise<Map<string, MonitorStats>> {
	const out = new Map<string, MonitorStats>(
		ids.map((id) => [id, { uptime24h: null, uptime30d: null, recent: [] }]),
	);
	if (ids.length === 0) return out;
	const day = 86_400_000;
	const [hours, days, recent] = await Promise.all([
		db
			.select()
			.from(monitorHourly)
			.where(
				and(
					inArray(monitorHourly.monitorId, ids),
					gte(monitorHourly.hour, new Date(now.getTime() - day)),
				),
			),
		db
			.select()
			.from(monitorDaily)
			.where(
				and(
					inArray(monitorDaily.monitorId, ids),
					gte(
						monitorDaily.day,
						new Date(now.getTime() - 30 * day).toISOString().slice(0, 10),
					),
				),
			),
		db.execute<{
			monitor_id: string;
			at: Date;
			ok: boolean;
			latency_ms: number | null;
		}>(sql`
			select monitor_id, at, ok, latency_ms from (
				select *, row_number() over (partition by monitor_id order by at desc) as n
				from monitor_check where monitor_id in (${sql.join(
					ids.map((i) => sql`${i}`),
					sql`, `,
				)})
					and at > ${new Date(now.getTime() - day).toISOString()}::timestamptz
			) r where n <= 40 order by at`),
	]);
	for (const id of ids) {
		const s = out.get(id) as MonitorStats;
		s.uptime24h = totalUptime(hours.filter((h) => h.monitorId === id));
		s.uptime30d = totalUptime(days.filter((d) => d.monitorId === id));
	}
	for (const r of recent)
		out.get(r.monitor_id)?.recent.push({
			at: new Date(r.at),
			ok: r.ok,
			latencyMs: r.latency_ms,
		});
	return out;
}

export async function dailyBars(
	db: Db,
	ids: string[],
	days: number,
	now = new Date(),
): Promise<Map<string, UptimeDay[]>> {
	const rows = ids.length
		? await db
				.select()
				.from(monitorDaily)
				.where(
					and(
						inArray(monitorDaily.monitorId, ids),
						gte(
							monitorDaily.day,
							new Date(now.getTime() - days * 86_400_000)
								.toISOString()
								.slice(0, 10),
						),
					),
				)
		: [];
	return new Map(
		ids.map((id) => [
			id,
			uptimeBars(
				rows.filter((r) => r.monitorId === id),
				days,
				now,
			),
		]),
	);
}

/** Latency per hour for the monitor page chart, oldest first. */
export async function hourlyLatency(db: Db, id: string, hours: number) {
	const rows = await db
		.select()
		.from(monitorHourly)
		.where(
			and(
				inArray(monitorHourly.monitorId, [id]),
				gte(monitorHourly.hour, new Date(Date.now() - hours * 3_600_000)),
			),
		)
		.orderBy(asc(monitorHourly.hour));
	return rows.map((r) => ({
		hour: r.hour,
		avgMs: r.checks ? Math.round(r.latencySum / r.checks) : null,
		maxMs: r.latencyMax,
		checks: r.checks,
		failures: r.failures,
	}));
}

export async function recentChecks(db: Db, id: string, limit = 50) {
	return db
		.select({
			at: monitorCheck.at,
			ok: monitorCheck.ok,
			maintenance: monitorCheck.maintenance,
			latencyMs: monitorCheck.latencyMs,
			error: monitorCheck.error,
			region: monitorCheck.region,
		})
		.from(monitorCheck)
		.where(inArray(monitorCheck.monitorId, [id]))
		.orderBy(desc(monitorCheck.at))
		.limit(limit);
}

/** Incidents touching any of `monitorIds` (or all of the org's when null), newest first, with updates. */
export async function incidentsWithUpdates(
	db: Db,
	organizationId: string,
	opts: { monitorIds?: string[]; since?: Date; limit?: number } = {},
) {
	const conds = [sql`${incident.organizationId} = ${organizationId}`];
	if (opts.monitorIds)
		conds.push(
			opts.monitorIds.length
				? sql`${incident.monitorIds} ?| array[${sql.join(
						opts.monitorIds.map((m) => sql`${m}`),
						sql`, `,
					)}]::text[]`
				: sql`false`,
		);
	if (opts.since)
		conds.push(
			sql`(${incident.resolvedAt} is null or ${incident.resolvedAt} >= ${opts.since.toISOString()})`,
		);
	const rows = await db
		.select()
		.from(incident)
		.where(and(...conds))
		.orderBy(desc(incident.startedAt))
		.limit(opts.limit ?? 50);
	const updates = rows.length
		? await db
				.select()
				.from(incidentUpdate)
				.where(
					inArray(
						incidentUpdate.incidentId,
						rows.map((r) => r.id),
					),
				)
				.orderBy(desc(incidentUpdate.createdAt))
		: [];
	return rows.map((r) => ({
		...r,
		updates: updates.filter((u) => u.incidentId === r.id),
	}));
}
