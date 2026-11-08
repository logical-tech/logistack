import {
	ContainerMetrics,
	DEFAULT_RETENTION,
	HostMetrics,
	type Retention,
} from "@logistack/contracts";
import type { Db } from "@logistack/db";
import { z } from "zod";

export type Sql = Db["$client"];

/** The `data` field of an `ls:metrics` entry: the agent's `metrics` message as received. */
export const MetricsEntry = z.object({
	type: z.literal("metrics"),
	at: z.number(),
	host: HostMetrics.nullable(),
	containers: z.array(ContainerMetrics),
});
export type MetricsEntry = z.infer<typeof MetricsEntry>;

export type HostRow = {
	node_id: string;
	ts: Date;
	cpu: number;
	load1: number;
	mem_used: number;
	mem_total: number;
	disk_used: number;
	disk_total: number;
	net_rx: number;
	net_tx: number;
};

export type ContainerRow = {
	node_id: string;
	container_id: string;
	ts: Date;
	service_id: string | null;
	name: string;
	cpu: number;
	mem_used: number;
	mem_limit: number;
	net_rx: number;
	net_tx: number;
	blk_read: number;
	blk_write: number;
};

/** Flattens one agent sample. Disks are summed per device, so bind mounts of one disk count once. */
export function toRows(
	nodeId: string,
	m: MetricsEntry,
): { host: HostRow | undefined; containers: ContainerRow[] } {
	const ts = new Date(m.at);
	let host: HostRow | undefined;
	if (m.host) {
		const devices = new Map<string, { used: number; total: number }>();
		for (const d of m.host.disks)
			devices.set(d.device, { used: d.usedBytes, total: d.totalBytes });
		const disks = [...devices.values()];
		host = {
			node_id: nodeId,
			ts,
			cpu: m.host.cpuPercent,
			load1: m.host.load[0],
			mem_used: m.host.memory.usedBytes,
			mem_total: m.host.memory.totalBytes,
			disk_used: disks.reduce((s, d) => s + d.used, 0),
			disk_total: disks.reduce((s, d) => s + d.total, 0),
			net_rx: m.host.network.rxBytes,
			net_tx: m.host.network.txBytes,
		};
	}
	const containers = m.containers.map((c) => ({
		node_id: nodeId,
		container_id: c.containerId,
		ts,
		service_id: c.resourceId ?? null,
		name: c.name,
		cpu: c.cpuPercent,
		mem_used: c.memoryBytes,
		mem_limit: c.memoryLimitBytes,
		net_rx: c.network.rxBytes,
		net_tx: c.network.txBytes,
		blk_read: c.blockIo.readBytes,
		blk_write: c.blockIo.writeBytes,
	}));
	return { host, containers };
}

const HOST_COLS = `node_id text, ts timestamptz, cpu real, load1 real, mem_used bigint,
	mem_total bigint, disk_used bigint, disk_total bigint, net_rx bigint, net_tx bigint`;
const CONTAINER_COLS = `node_id text, container_id text, ts timestamptz, service_id text,
	name text, cpu real, mem_used bigint, mem_limit bigint, net_rx bigint, net_tx bigint,
	blk_read bigint, blk_write bigint`;

/**
 * Inserts each table's batch as one JSON parameter expanded by `jsonb_to_recordset`, so a batch
 * costs one statement per table whatever its size. A redelivered sample hits the primary key
 * and is skipped: inserts are idempotent.
 */
export async function insertRows(
	sql: Sql,
	host: HostRow[],
	containers: ContainerRow[],
): Promise<void> {
	await sql.begin(async (tx) => {
		if (host.length)
			await tx.unsafe(
				`insert into metric_host_raw select * from jsonb_to_recordset($1::jsonb) as r(${HOST_COLS})
				on conflict do nothing`,
				[JSON.stringify(host)],
			);
		if (containers.length)
			await tx.unsafe(
				`insert into metric_container_raw select * from jsonb_to_recordset($1::jsonb) as r(${CONTAINER_COLS})
				on conflict do nothing`,
				[JSON.stringify(containers)],
			);
	});
}

export const PARTITIONED = [
	"metric_host_raw",
	"metric_container_raw",
	"metric_host_1m",
	"metric_container_1m",
	"traffic_1m",
] as const;

/** Creates the day partitions for yesterday through `daysAhead` days from now; idempotent. */
export async function ensurePartitions(sql: Sql, daysAhead = 2): Promise<void> {
	for (const table of PARTITIONED)
		await sql`select metric_ensure_partitions(${table},
			(now() at time zone 'UTC')::date - 1,
			(now() at time zone 'UTC')::date + ${daysAhead}::int)`;
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

const DAY = /_(\d{4})(\d{2})(\d{2})$/;

/**
 * Drops whole day partitions once their last instant is older than the retention, so a table
 * always holds at least the retention window. Hourly tables are not partitioned and are trimmed
 * with DELETE. Returns the dropped partition names.
 */
export async function applyRetention(
	sql: Sql,
	retention: Retention,
	now = new Date(),
): Promise<string[]> {
	const cutoff = {
		raw: now.getTime() - retention.rawHours * 3_600_000,
		"1m": now.getTime() - retention.minuteDays * 86_400_000,
	};
	const dropped: string[] = [];
	for (const parent of PARTITIONED) {
		const limit = parent.endsWith("_raw") ? cutoff.raw : cutoff["1m"];
		const children = await sql<{ name: string }[]>`
			select c.relname as name from pg_inherits i
			join pg_class c on c.oid = i.inhrelid
			join pg_class p on p.oid = i.inhparent
			where p.relname = ${parent}`;
		for (const { name } of children) {
			const m = DAY.exec(name);
			if (!m) continue;
			const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
			if (end > limit) continue;
			await sql`drop table if exists ${sql(name)}`;
			dropped.push(name);
		}
	}
	const hourCutoff = new Date(now.getTime() - retention.hourDays * 86_400_000);
	await sql`delete from metric_host_1h where ts < ${hourCutoff.toISOString()}::timestamptz`;
	await sql`delete from metric_container_1h where ts < ${hourCutoff.toISOString()}::timestamptz`;
	await sql`delete from traffic_1h where ts < ${hourCutoff.toISOString()}::timestamptz`;
	return dropped;
}

const floorTo = (t: number, ms: number) => Math.floor(t / ms) * ms;
const MINUTE = 60_000;
const HOUR = 3_600_000;

async function watermark(sql: Sql, name: string): Promise<Date | undefined> {
	// Drizzle's postgres-js setup returns timestamps as strings.
	const [row] = await sql<
		{ through: string }[]
	>`select through::text from metric_rollup_state where name = ${name}`;
	return row ? new Date(row.through) : undefined;
}

async function setWatermark(sql: Sql, name: string, through: Date) {
	await sql`insert into metric_rollup_state (name, through) values (${name}, ${through.toISOString()}::timestamptz)
		on conflict (name) do update set through = excluded.through`;
}

/**
 * Rolls raw samples into 1-minute buckets and those into 1-hour buckets. Buckets are upserted,
 * so a rerun converges to the same rows; each pass also recomputes the two buckets before the
 * watermark to absorb samples that arrived late. Rates come from positive counter deltas over
 * the elapsed time, so a counter reset (agent or container restart) drops one delta, not the bucket.
 */
export async function rollup(sql: Sql, now = new Date()): Promise<void> {
	// A minute is final 30s after it ends; an hour once its last minute is final.
	const to1m = new Date(floorTo(now.getTime() - 30_000, MINUTE));
	const from1m = new Date(
		((await watermark(sql, "1m"))?.getTime() ?? to1m.getTime() - HOUR) -
			2 * MINUTE,
	);
	if (from1m < to1m) {
		await rollupMinute(sql, from1m, to1m);
		await setWatermark(sql, "1m", to1m);
	}
	const to1h = new Date(floorTo(to1m.getTime(), HOUR));
	const from1h = new Date(
		((await watermark(sql, "1h"))?.getTime() ?? to1h.getTime() - 24 * HOUR) -
			HOUR,
	);
	if (from1h < to1h) {
		await rollupHour(sql, from1h, to1h);
		await setWatermark(sql, "1h", to1h);
	}
}

const rate = (counter: string) =>
	`sum(greatest(d_${counter}, 0)) filter (where dt > 0) / nullif(sum(dt) filter (where dt > 0), 0)`;

const delta = (counter: string) =>
	`${counter} - lag(${counter}) over w as d_${counter}`;

export async function rollupMinute(sql: Sql, from: Date, to: Date) {
	// One sample before `from` seeds lag() for the first bucket's deltas.
	const lookback = new Date(from.getTime() - MINUTE);
	await sql.unsafe(
		`
		insert into metric_host_1m
		select node_id, date_bin('1 minute', ts, timestamptz 'epoch') as b,
			avg(cpu), max(cpu), avg(load1), avg(mem_used)::bigint, max(mem_total),
			avg(disk_used)::bigint, max(disk_total), ${rate("net_rx")}, ${rate("net_tx")}, count(*)
		from (
			select *, ${delta("net_rx")}, ${delta("net_tx")},
				extract(epoch from ts - lag(ts) over w) as dt
			from metric_host_raw where ts >= $1 and ts < $3
			window w as (partition by node_id order by ts)
		) s
		where ts >= $2
		group by node_id, b
		on conflict (node_id, ts) do update set
			cpu = excluded.cpu, cpu_max = excluded.cpu_max, load1 = excluded.load1,
			mem_used = excluded.mem_used, mem_total = excluded.mem_total,
			disk_used = excluded.disk_used, disk_total = excluded.disk_total,
			rx = excluded.rx, tx = excluded.tx, samples = excluded.samples`,
		[lookback.toISOString(), from.toISOString(), to.toISOString()],
	);
	await sql.unsafe(
		`
		insert into metric_container_1m
		select node_id, container_id, date_bin('1 minute', ts, timestamptz 'epoch') as b,
			max(service_id), max(name), avg(cpu), max(cpu), avg(mem_used)::bigint, max(mem_limit),
			${rate("net_rx")}, ${rate("net_tx")}, ${rate("blk_read")}, ${rate("blk_write")}, count(*)
		from (
			select *, ${delta("net_rx")}, ${delta("net_tx")}, ${delta("blk_read")}, ${delta("blk_write")},
				extract(epoch from ts - lag(ts) over w) as dt
			from metric_container_raw where ts >= $1 and ts < $3
			window w as (partition by node_id, container_id order by ts)
		) s
		where ts >= $2
		group by node_id, container_id, b
		on conflict (node_id, container_id, ts) do update set
			service_id = excluded.service_id, name = excluded.name, cpu = excluded.cpu,
			cpu_max = excluded.cpu_max, mem_used = excluded.mem_used, mem_limit = excluded.mem_limit,
			rx = excluded.rx, tx = excluded.tx, read = excluded.read, write = excluded.write,
			samples = excluded.samples`,
		[lookback.toISOString(), from.toISOString(), to.toISOString()],
	);
}

/** Sample-weighted averages, so an hour with a gap is not skewed by its sparse minutes. */
const wavg = (c: string) =>
	`sum(${c} * samples) / nullif(sum(samples) filter (where ${c} is not null), 0)`;

export async function rollupHour(sql: Sql, from: Date, to: Date) {
	await sql.unsafe(
		`
		insert into metric_host_1h
		select node_id, date_bin('1 hour', ts, timestamptz 'epoch') as b,
			${wavg("cpu")}, max(cpu_max), ${wavg("load1")}, (${wavg("mem_used")})::bigint, max(mem_total),
			(${wavg("disk_used")})::bigint, max(disk_total), ${wavg("rx")}, ${wavg("tx")}, sum(samples)
		from metric_host_1m where ts >= $1 and ts < $2
		group by node_id, b
		on conflict (node_id, ts) do update set
			cpu = excluded.cpu, cpu_max = excluded.cpu_max, load1 = excluded.load1,
			mem_used = excluded.mem_used, mem_total = excluded.mem_total,
			disk_used = excluded.disk_used, disk_total = excluded.disk_total,
			rx = excluded.rx, tx = excluded.tx, samples = excluded.samples`,
		[from.toISOString(), to.toISOString()],
	);
	await sql.unsafe(
		`
		insert into metric_container_1h
		select node_id, container_id, date_bin('1 hour', ts, timestamptz 'epoch') as b,
			max(service_id), max(name), ${wavg("cpu")}, max(cpu_max), (${wavg("mem_used")})::bigint,
			max(mem_limit), ${wavg("rx")}, ${wavg("tx")}, ${wavg("read")}, ${wavg("write")}, sum(samples)
		from metric_container_1m where ts >= $1 and ts < $2
		group by node_id, container_id, b
		on conflict (node_id, container_id, ts) do update set
			service_id = excluded.service_id, name = excluded.name, cpu = excluded.cpu,
			cpu_max = excluded.cpu_max, mem_used = excluded.mem_used, mem_limit = excluded.mem_limit,
			rx = excluded.rx, tx = excluded.tx, read = excluded.read, write = excluded.write,
			samples = excluded.samples`,
		[from.toISOString(), to.toISOString()],
	);
}
