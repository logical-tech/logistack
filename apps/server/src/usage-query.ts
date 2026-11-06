import {
	RANGE_SECONDS,
	type UsageFigures,
	type UsagePoint,
	type UsageRange,
} from "@logistack/contracts";
import { adoptedVolume, type Db, mount } from "@logistack/db";
import type { NodeRunner } from "@logistack/worker/node-runner";
import { eq } from "drizzle-orm";

type Sql = Db["$client"];

const STEP_SEC: Record<UsageRange, number> = { "24h": 300, "7d": 3_600 };

export type UsageWindow = {
	from: Date;
	to: Date;
	stepSec: number;
	spanSec: number;
	/** Rows before it come from the 1-hour rollup, rows from it on from the 1-minute one. */
	cut: Date;
};

/**
 * The window ending now, aligned to whole steps. Finished hours are read from the 1-hour rollup
 * (a 7-day window over 1-minute rows measured ~2 s for 100 containers) and only the tail from the
 * 1-minute one; the 24h trend steps below an hour, so it reads 1-minute rows throughout.
 */
export async function usageWindow(
	sql: Sql,
	range: UsageRange,
	now = Date.now(),
): Promise<UsageWindow> {
	const stepSec = STEP_SEC[range];
	const spanSec = RANGE_SECONDS[range];
	const to = new Date(Math.ceil(now / (stepSec * 1000)) * stepSec * 1000);
	const from = new Date(to.getTime() - spanSec * 1000);
	const [row] = await sql<
		{ through: string }[]
	>`select through::text from metric_rollup_state where name = '1h'`;
	const through = row ? new Date(row.through).getTime() : 0;
	const cut = new Date(
		Math.min(Math.max(through, from.getTime()), to.getTime()),
	);
	return { from, to, stepSec, spanSec, cut };
}

/** Container rows of the services selected by `scope` (a query yielding ids), each with the seconds it stands for. */
const rowsOf = (scope: string, cut: string) => `(
	select service_id, ts, cpu, mem_used, rx, tx, 3600 as sec from metric_container_1h
	where ts >= $2 and ts < ${cut} and service_id in (${scope})
	union all
	select service_id, ts, cpu, mem_used, rx, tx, 60 from metric_container_1m
	where ts >= ${cut} and ts < $3 and service_id in (${scope}))`;

export type ServiceUsageRow = Omit<UsageFigures, "disk"> & {
	projectId: string;
	projectName: string;
	environmentId: string | null;
	environmentName: string | null;
	serviceId: string | null;
	serviceName: string | null;
};

/**
 * One row per service of `projectIds` (and one per empty project or environment), with its
 * consumption over the window. A rollup row stands for `sec` seconds of one container, so
 * sum(x * sec) / span is the window average and replicas add up.
 */
export async function serviceUsage(
	sql: Sql,
	projectIds: string[],
	w: UsageWindow,
): Promise<ServiceUsageRow[]> {
	if (!projectIds.length) return [];
	const rows = await sql.unsafe<Record<string, string | number | null>[]>(
		`with scope as (
			select p.id as project_id, p.name as project_name, e.id as environment_id,
				e.name as environment_name, e.created_at, s.id as service_id, s.name as service_name
			from project p
			left join environment e on e.project_id = p.id
			left join service s on s.environment_id = e.id
			where p.id = any($1::text[])
		), used as (
			select service_id, sum(cpu * sec)::float8 / $5 / 100 as cpu,
				sum(mem_used::float8 * sec) / $5 as mem_used,
				sum(coalesce(rx, 0) * sec)::float8 as rx, sum(coalesce(tx, 0) * sec)::float8 as tx
			from ${rowsOf("select service_id from scope", "$4")} m
			group by service_id
		)
		select scope.*, coalesce(u.cpu, 0) as cpu, coalesce(u.mem_used, 0) as mem_used,
			coalesce(u.rx, 0) as rx, coalesce(u.tx, 0) as tx
		from scope left join used u using (service_id)
		order by project_name, project_id, created_at, environment_id, service_name`,
		[
			projectIds,
			w.from.toISOString(),
			w.to.toISOString(),
			w.cut.toISOString(),
			w.spanSec,
		],
	);
	return rows.map((r) => ({
		projectId: r.project_id as string,
		projectName: r.project_name as string,
		environmentId: r.environment_id as string | null,
		environmentName: r.environment_name as string | null,
		serviceId: r.service_id as string | null,
		serviceName: r.service_name as string | null,
		cpu: Number(r.cpu),
		memUsed: Number(r.mem_used),
		rx: Number(r.rx),
		tx: Number(r.tx),
	}));
}

/** The services of `projectIds` summed per step: cores, bytes, bytes per second. */
export async function usageTrend(
	sql: Sql,
	projectIds: string[],
	w: UsageWindow,
): Promise<UsagePoint[]> {
	if (!projectIds.length) return [];
	// An hourly row binned into a shorter step would land whole in one bucket.
	const cut = w.stepSec >= 3_600 ? w.cut : w.from;
	const rows = await sql.unsafe<Record<string, number>[]>(
		`select extract(epoch from date_bin(make_interval(secs => $5), ts, timestamptz 'epoch')) * 1000 as t,
			sum(cpu * sec)::float8 / $5 / 100 as cpu,
			sum(mem_used::float8 * sec) / $5 as mem_used,
			sum(coalesce(rx, 0) * sec)::float8 / $5 as rx,
			sum(coalesce(tx, 0) * sec)::float8 / $5 as tx
		from ${rowsOf(
			`select s.id from service s join environment e on e.id = s.environment_id
			where e.project_id = any($1::text[])`,
			"$4",
		)} m
		group by 1 order by 1`,
		[
			projectIds,
			w.from.toISOString(),
			w.to.toISOString(),
			cut.toISOString(),
			w.stepSec,
		],
	);
	return rows.map((r) => ({
		t: Number(r.t),
		cpu: Number(r.cpu),
		memUsed: Number(r.mem_used),
		rx: Number(r.rx),
		tx: Number(r.tx),
	}));
}

/**
 * Current volume bytes per service id, summed over the nodes that answered; null when none did.
 * A volume belongs to whoever its `logistack.resource` label (or adoption row) names: a volume
 * mount, or a database or storage service's data directory.
 */
export async function volumeBytes(
	db: Db,
	nodes: NodeRunner,
	swarmNodeIds: string[],
): Promise<Map<string, number> | null> {
	const results = await Promise.allSettled(
		swarmNodeIds.map((id) =>
			nodes.disk(id, { op: "usage" }, { timeoutMs: 10_000 }),
		),
	);
	if (!results.some((r) => r.status === "fulfilled")) return null;
	const volumes = results.flatMap((r) =>
		r.status === "fulfilled"
			? (r.value.usage.allVolumes ?? r.value.usage.topVolumes)
			: [],
	);
	const [mounts, adopted] = await Promise.all([
		db
			.select({ id: mount.id, serviceId: mount.serviceId })
			.from(mount)
			.where(eq(mount.kind, "volume")),
		db
			.select({
				name: adoptedVolume.volumeName,
				ownerId: adoptedVolume.ownerId,
			})
			.from(adoptedVolume),
	]);
	const serviceOf = new Map(mounts.map((m) => [m.id, m.serviceId]));
	const adoptedOwner = new Map(adopted.map((a) => [a.name, a.ownerId]));
	const out = new Map<string, number>();
	for (const v of volumes) {
		const owner = v.resourceId ?? adoptedOwner.get(v.name);
		if (!owner) continue;
		// A data-directory volume is labelled with its service's own id.
		const serviceId = serviceOf.get(owner) ?? owner;
		out.set(serviceId, (out.get(serviceId) ?? 0) + v.bytes);
	}
	return out;
}
