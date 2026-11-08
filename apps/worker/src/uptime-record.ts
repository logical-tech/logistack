import type {
	EventEnvelope,
	EventType,
	MonitorEventPayload,
	MonitorStatus,
} from "@logistack/contracts";
import {
	certWarning,
	confirm,
	inMaintenance,
	nextDelaySec,
	shouldResend,
} from "@logistack/core";
import {
	type Db,
	incident,
	incidentUpdate,
	maintenanceWindow,
	monitor,
	monitorCheck,
} from "@logistack/db";
import { and, eq, isNull, sql } from "drizzle-orm";

// Folds one check result into a monitor: stores it, increments the rollups, moves the
// confirmed status, opens or resolves its incident and publishes events. Shared by the worker's
// checks and the api's push endpoint, so both follow the same rules.

export type Publish = (
	type: EventType,
	organizationId: string,
	resource: EventEnvelope["resource"],
	payload: EventEnvelope["payload"],
) => Promise<void>;

export type CheckResult = {
	ok: boolean;
	latencyMs?: number;
	error?: string;
	/** TLS checks: the leaf certificate's notAfter. */
	certExpiresAt?: Date;
};

type MonitorRow = typeof monitor.$inferSelect;

/** What the monitor checks, in a line, for notifications. */
export function monitorTarget(m: Pick<MonitorRow, "config">): string {
	const c = m.config;
	switch (c.kind) {
		case "http":
			return c.http.url;
		case "tcp":
			return `${c.tcp.host}:${c.tcp.port}`;
		case "dns":
			return `${c.dns.recordType} ${c.dns.hostname}`;
		case "tls":
			return `${c.tls.host}:${c.tls.port}`;
		case "push":
			return "push";
	}
}

function payload(
	m: MonitorRow,
	state: MonitorEventPayload["state"],
	error?: string,
): MonitorEventPayload {
	return {
		monitorId: m.id,
		name: m.name,
		kind: m.kind,
		target: monitorTarget(m),
		state,
		...(error && { error }),
		...(m.projectId && { projectId: m.projectId }),
		...(m.serviceId && { serviceId: m.serviceId }),
	};
}

export async function activeWindows(db: Db, organizationId: string) {
	return db
		.select({
			monitorIds: maintenanceWindow.monitorIds,
			startsAt: maintenanceWindow.startsAt,
			endsAt: maintenanceWindow.endsAt,
			repeat: maintenanceWindow.repeat,
		})
		.from(maintenanceWindow)
		.where(eq(maintenanceWindow.organizationId, organizationId));
}

export async function recordResult(
	db: Db,
	publish: Publish,
	monitorId: string,
	result: CheckResult,
	now = new Date(),
): Promise<{ status: MonitorStatus; emitted: EventType[] } | undefined> {
	const events: [EventType, EventEnvelope["payload"], string][] = [];
	let org = "";
	const out = await db.transaction(async (tx) => {
		const [m] = await tx
			.select()
			.from(monitor)
			.where(eq(monitor.id, monitorId))
			.for("update");
		if (!m?.enabled) return undefined;
		org = m.organizationId;
		const maint = inMaintenance(
			await activeWindows(tx as unknown as Db, m.organizationId),
			m.id,
			now,
		);
		const next = confirm(
			{ status: m.status, streak: m.streak },
			result.ok,
			{ downAfter: m.downAfter, upAfter: m.upAfter },
			maint,
		);
		await tx.insert(monitorCheck).values({
			monitorId: m.id,
			at: now,
			ok: result.ok,
			maintenance: maint,
			latencyMs: result.latencyMs ?? null,
			error: result.ok ? null : (result.error ?? "failed"),
		});
		const latency = result.latencyMs ?? 0;
		const fail = result.ok ? 0 : 1;
		const inMaint = maint ? 1 : 0;
		for (const [table, key, bucket] of [
			[
				"monitor_hourly",
				"hour",
				sql`date_trunc('hour', ${now.toISOString()}::timestamptz)`,
			],
			[
				"monitor_daily",
				"day",
				sql`(${now.toISOString()}::timestamptz at time zone 'UTC')::date`,
			],
		] as const)
			await tx.execute(sql`
				insert into ${sql.identifier(table)}
					(monitor_id, ${sql.identifier(key)}, checks, failures, maintenance, latency_sum, latency_max)
				values (${m.id}, ${bucket}, 1, ${fail}, ${inMaint}, ${latency}, ${latency})
				on conflict (monitor_id, ${sql.identifier(key)}) do update set
					checks = ${sql.identifier(table)}.checks + 1,
					failures = ${sql.identifier(table)}.failures + ${fail},
					maintenance = ${sql.identifier(table)}.maintenance + ${inMaint},
					latency_sum = ${sql.identifier(table)}.latency_sum + ${latency},
					latency_max = greatest(${sql.identifier(table)}.latency_max, ${latency})`);

		let lastNotifiedAt = m.lastNotifiedAt;
		if (next.emit === "down") {
			events.push(["monitor.down", payload(m, "firing", result.error), m.id]);
			lastNotifiedAt = now;
			if (m.autoIncident) {
				// The partial unique index keeps one open auto incident per monitor.
				const [inc] = await tx
					.insert(incident)
					.values({
						organizationId: m.organizationId,
						title: `${m.name} is down`,
						status: "investigating",
						impact: "major",
						monitorIds: [m.id],
						openedByMonitorId: m.id,
						startedAt: now,
					})
					.onConflictDoNothing()
					.returning({ id: incident.id });
				if (inc)
					await tx.insert(incidentUpdate).values({
						incidentId: inc.id,
						status: "investigating",
						message: `Automatic check failed: ${result.error ?? "no answer"}.`,
						createdAt: now,
					});
			}
		} else if (next.emit === "up") {
			events.push(["monitor.up", payload(m, "resolved"), m.id]);
			lastNotifiedAt = null;
			const open = await tx
				.update(incident)
				.set({ status: "resolved", resolvedAt: now })
				.where(
					and(
						eq(incident.openedByMonitorId, m.id),
						isNull(incident.resolvedAt),
					),
				)
				.returning({ id: incident.id });
			for (const inc of open)
				await tx.insert(incidentUpdate).values({
					incidentId: inc.id,
					status: "resolved",
					message: "Automatic check passing again.",
					createdAt: now,
				});
		} else if (
			shouldResend(next.status, m.resendMinutes, m.lastNotifiedAt, now)
		) {
			events.push(["monitor.down", payload(m, "firing", result.error), m.id]);
			lastNotifiedAt = now;
		}

		let certWarnedDays = m.certWarnedDays;
		if (result.certExpiresAt && m.config.kind === "tls") {
			const daysLeft = Math.floor(
				(result.certExpiresAt.getTime() - now.getTime()) / 86_400_000,
			);
			const w = certWarning(daysLeft, m.config.tls.warnDays, m.certWarnedDays);
			certWarnedDays = w.warned;
			if (w.announce !== undefined && !maint)
				events.push([
					"certificate.expiring",
					{
						monitorId: m.id,
						name: m.name,
						hostname: m.config.tls.host,
						expiresAt: result.certExpiresAt.toISOString(),
						daysLeft,
						message: `Certificate expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
						...(m.projectId && { projectId: m.projectId }),
						...(m.serviceId && { serviceId: m.serviceId }),
					},
					m.id,
				]);
		}

		const delay =
			m.config.kind === "push"
				? m.intervalSec + m.config.push.graceSec
				: nextDelaySec(next, m);
		await tx
			.update(monitor)
			.set({
				status: next.status,
				streak: next.streak,
				lastCheckAt: now,
				lastLatencyMs: result.latencyMs ?? null,
				lastError: result.ok ? null : (result.error ?? "failed"),
				lastNotifiedAt,
				...(next.status !== m.status && { statusChangedAt: now }),
				...(result.certExpiresAt && { certExpiresAt: result.certExpiresAt }),
				certWarnedDays,
				// Push monitors are judged on silence; their next deadline moves with each ping.
				nextCheckAt: new Date(now.getTime() + delay * 1000),
			})
			.where(eq(monitor.id, m.id));
		return { status: next.status, emitted: events.map((e) => e[0]) };
	});
	// After commit: a listener reading the monitor sees the new status.
	for (const [type, p, id] of events)
		await publish(type, org, { type: "monitor", id }, p);
	return out;
}
