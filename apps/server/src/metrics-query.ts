import {
	type ContainerPoint,
	DEFAULT_RETENTION,
	type HostPoint,
	type MetricRange,
	type MetricSource,
	RANGE_SECONDS,
	type Retention,
} from "@logistack/contracts";
import type { Db } from "@logistack/db";

type Sql = Db["$client"];

const NICE_STEPS = [
	10, 30, 60, 300, 600, 900, 1_800, 3_600, 7_200, 21_600, 43_200, 86_400,
];
const RESOLUTION: Record<MetricSource, number> = {
	raw: 10,
	"1m": 60,
	"1h": 3_600,
};
const COARSE_FIRST: MetricSource[] = ["1h", "1m", "raw"];

/**
 * The cheapest source that still resolves the step and still holds the whole range, and a step
 * that keeps a series near `maxPoints` buckets: 1h -> raw/10s, 6h -> 1m/1m, 24h -> 1m/5m,
 * 7d -> 1m/30m, 30d -> 1h/2h with the default retention.
 */
export function pickResolution(
	range: MetricRange,
	retention: Retention = DEFAULT_RETENTION,
	maxPoints = 360,
): { source: MetricSource; stepSec: number } {
	const rangeSec = RANGE_SECONDS[range];
	const ideal = rangeSec / maxPoints;
	const step = NICE_STEPS.find((s) => s >= ideal) ?? 86_400;
	const keeps: Record<MetricSource, number> = {
		raw: retention.rawHours * 3_600,
		"1m": retention.minuteDays * 86_400,
		"1h": retention.hourDays * 86_400,
	};
	const source =
		COARSE_FIRST.find((s) => RESOLUTION[s] <= step && keeps[s] >= rangeSec) ??
		COARSE_FIRST.reduce((a, b) => (keeps[b] > keeps[a] ? b : a));
	return { source, stepSec: Math.max(step, RESOLUTION[source]) };
}

export async function loadRetention(sql: Sql): Promise<Retention> {
	const [row] = await sql<
		{ raw: number; minute: number; hour: number }[]
	>`select raw_retention_hours as raw, minute_retention_days as minute, hour_retention_days as hour
		from monitoring_settings where id = 'singleton'`;
	return row
		? { rawHours: row.raw, minuteDays: row.minute, hourDays: row.hour }
		: DEFAULT_RETENTION;
}

/** Raw rows carry cumulative counters; rates come from positive deltas, as in the rollups. */
const rateOf = (c: string) =>
	`greatest(${c} - lag(${c}) over w, 0) / nullif(extract(epoch from ts - lag(ts) over w), 0)`;

function hostSource(source: MetricSource): string {
	if (source !== "raw") return `metric_host_${source}`;
	return `(select node_id, ts, cpu, load1, mem_used, mem_total, disk_used, disk_total,
			${rateOf("net_rx")} as rx, ${rateOf("net_tx")} as tx,
			${rateOf("disk_read")} as dread, ${rateOf("disk_write")} as dwrite, temp, iowait, steal
		from metric_host_raw
		where node_id = any(string_to_array($1, ',')) and ts >= $2::timestamptz - interval '1 minute' and ts < $3
		window w as (partition by node_id order by ts))`;
}

type Window = { from: Date; to: Date; stepSec: number; source: MetricSource };

/** Per-node buckets, or one cluster series (CPU averaged, bytes and rates summed) when `cluster`. */
export async function hostSeries(
	sql: Sql,
	swarmNodeIds: string[],
	w: Window,
	cluster: boolean,
): Promise<Map<string | null, HostPoint[]>> {
	const perNode = `
		select node_id, date_bin(make_interval(secs => $4), ts, timestamptz 'epoch') as t,
			avg(cpu) as cpu, avg(load1) as load1, avg(mem_used) as mem_used, max(mem_total) as mem_total,
			avg(disk_used) as disk_used, max(disk_total) as disk_total, avg(rx) as rx, avg(tx) as tx,
			avg(dread) as dread, avg(dwrite) as dwrite, max(temp) as temp, avg(iowait) as iowait,
			avg(steal) as steal
		from ${hostSource(w.source)} s
		where node_id = any(string_to_array($1, ',')) and ts >= $2 and ts < $3
		group by 1, 2`;
	const query = cluster
		? `select null as node_id, t, avg(cpu) as cpu, avg(load1) as load1, sum(mem_used) as mem_used,
				sum(mem_total) as mem_total, sum(disk_used) as disk_used, sum(disk_total) as disk_total,
				sum(rx) as rx, sum(tx) as tx, sum(dread) as dread, sum(dwrite) as dwrite,
				max(temp) as temp, avg(iowait) as iowait, avg(steal) as steal
			from (${perNode}) b group by t`
		: perNode;
	const rows = await sql.unsafe<
		Record<string, string | number | Date | null>[]
	>(
		`select node_id, extract(epoch from t) * 1000 as t, ${[
			"cpu",
			"load1",
			"mem_used",
			"mem_total",
			"disk_used",
			"disk_total",
			"rx",
			"tx",
			"dread",
			"dwrite",
			"temp",
			"iowait",
			"steal",
		]
			.map((c) => `${c}::float8 as ${c}`)
			.join(", ")} from (${query}) q order by node_id, t`,
		[
			swarmNodeIds.join(","),
			w.from.toISOString(),
			w.to.toISOString(),
			w.stepSec,
		],
	);
	const out = new Map<string | null, HostPoint[]>();
	for (const r of rows) {
		const key = (r.node_id as string | null) ?? null;
		const list = out.get(key) ?? [];
		list.push({
			t: Number(r.t),
			cpu: r.cpu as number | null,
			load1: r.load1 as number | null,
			memUsed: r.mem_used as number | null,
			memTotal: r.mem_total as number | null,
			diskUsed: r.disk_used as number | null,
			diskTotal: r.disk_total as number | null,
			rx: r.rx as number | null,
			tx: r.tx as number | null,
			diskRead: r.dread as number | null,
			diskWrite: r.dwrite as number | null,
			temp: r.temp as number | null,
			iowait: r.iowait as number | null,
			steal: r.steal as number | null,
		});
		out.set(key, list);
	}
	return out;
}

function containerSource(source: MetricSource, filter: string): string {
	if (source !== "raw") return `metric_container_${source}`;
	return `(select node_id, container_id, service_id, ts, cpu, mem_used, mem_limit,
			${rateOf("net_rx")} as rx, ${rateOf("net_tx")} as tx,
			${rateOf("blk_read")} as read, ${rateOf("blk_write")} as write
		from metric_container_raw
		where ${filter} = $1 and ts >= $2::timestamptz - interval '1 minute' and ts < $3
		window w as (partition by node_id, container_id order by ts))`;
}

/**
 * Container buckets summed across every container matching `by` (all replicas of a service on
 * every node, or one container): each container is averaged within the bucket first, so a
 * replica that reported twice in a bucket is not counted twice.
 */
export async function containerSeries(
	sql: Sql,
	by: { serviceId: string } | { containerId: string },
	w: Window,
): Promise<ContainerPoint[]> {
	const filter = "serviceId" in by ? "service_id" : "container_id";
	const rows = await sql.unsafe<Record<string, number | null>[]>(
		`select extract(epoch from t) * 1000 as t, sum(cpu)::float8 as cpu,
			sum(mem_used)::float8 as mem_used, sum(mem_limit)::float8 as mem_limit,
			sum(rx)::float8 as rx, sum(tx)::float8 as tx, sum(read)::float8 as read,
			sum(write)::float8 as write, count(*)::int as containers
		from (
			select node_id, container_id,
				date_bin(make_interval(secs => $4), ts, timestamptz 'epoch') as t,
				avg(cpu) as cpu, avg(mem_used) as mem_used, max(mem_limit) as mem_limit,
				avg(rx) as rx, avg(tx) as tx, avg(read) as read, avg(write) as write
			from ${containerSource(w.source, filter)} s
			where ${filter} = $1 and ts >= $2 and ts < $3
			group by 1, 2, 3
		) b group by t order by t`,
		[
			"serviceId" in by ? by.serviceId : by.containerId,
			w.from.toISOString(),
			w.to.toISOString(),
			w.stepSec,
		],
	);
	return rows.map((r) => ({
		t: Number(r.t),
		cpu: r.cpu ?? null,
		memUsed: r.mem_used ?? null,
		memLimit: r.mem_limit ?? null,
		rx: r.rx ?? null,
		tx: r.tx ?? null,
		read: r.read ?? null,
		write: r.write ?? null,
		containers: Number(r.containers),
	}));
}

/** The query window ending now, aligned to whole steps so consecutive polls share buckets. */
export async function windowFor(
	sql: Sql,
	range: MetricRange,
	now = Date.now(),
): Promise<Window> {
	const { source, stepSec } = pickResolution(range, await loadRetention(sql));
	const stepMs = stepSec * 1000;
	const to = new Date(Math.ceil(now / stepMs) * stepMs);
	return {
		source,
		stepSec,
		to,
		from: new Date(to.getTime() - RANGE_SECONDS[range] * 1000),
	};
}
