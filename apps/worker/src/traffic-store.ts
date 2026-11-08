import { TrafficMinute } from "@logistack/contracts";
import {
	hllDecode,
	hllEncode,
	hllMerge,
	hllNew,
	mergeCounts,
	quantiles,
	type TrafficSignalSource,
	topN,
} from "@logistack/core/traffic";
import { z } from "zod";
import { log } from "./bus.ts";
import { type Entry, field } from "./metrics-consumer.ts";
import type { Sql } from "./metrics-store.ts";

/** The `data` field of an `ls:traffic` entry: the agent's minutes as received. */
export const TrafficEntry = z.array(TrafficMinute);

const COLS = `node_id text, domain_id text, ts timestamptz, service_id text, organization_id text,
	requests int, s1 int, s2 int, s3 int, s4 int, s5 int, bytes_in bigint, bytes_out bigint,
	pageviews int, bots int, latency jsonb, paths jsonb, referrers jsonb, countries jsonb,
	utm_sources jsonb, events jsonb, visitors text`;

const MAPS = [
	"latency",
	"paths",
	"referrers",
	"countries",
	"utm_sources",
	"events",
] as const;
const SUMS = [
	"requests",
	"s1",
	"s2",
	"s3",
	"s4",
	"s5",
	"bytes_in",
	"bytes_out",
	"pageviews",
	"bots",
] as const;
const SET = [...SUMS, ...MAPS, "service_id", "organization_id", "visitors"]
	.map((c) => `${c} = excluded.${c}`)
	.join(", ");

function toRow(nodeId: string, m: TrafficMinute) {
	return {
		node_id: nodeId,
		domain_id: m.domainId,
		ts: new Date(m.ts).toISOString(),
		service_id: m.serviceId,
		organization_id: m.organizationId,
		requests: m.requests,
		s1: m.status[0],
		s2: m.status[1],
		s3: m.status[2],
		s4: m.status[3],
		s5: m.status[4],
		bytes_in: m.bytesIn,
		bytes_out: m.bytesOut,
		pageviews: m.pageviews,
		bots: m.bots,
		latency: m.latency,
		paths: m.paths,
		referrers: m.referrers,
		countries: m.countries,
		utm_sources: m.utmSources,
		events: m.events,
		visitors: m.visitors,
	};
}

/** One statement per batch. A resent minute replaces its row, so delivery may repeat. */
export async function insertTraffic(
	sql: Sql,
	rows: { nodeId: string; minute: TrafficMinute }[],
) {
	if (!rows.length) return;
	// Postgres rejects two rows with the same key in one upsert; the later copy wins.
	const unique = new Map(
		rows.map((r) => [
			`${r.nodeId}|${r.minute.domainId}|${r.minute.ts}`,
			toRow(r.nodeId, r.minute),
		]),
	);
	await sql.unsafe(
		`insert into traffic_1m
		select node_id, domain_id, ts, service_id, organization_id, requests, s1, s2, s3, s4, s5,
			bytes_in, bytes_out, pageviews, bots, latency, paths, referrers, countries, utm_sources, events,
			decode(nullif(visitors, ''), 'base64')
		from jsonb_to_recordset($1::jsonb) as r(${COLS})
		on conflict (node_id, domain_id, ts) do update set ${SET}`,
		[JSON.stringify([...unique.values()])],
	);
}

/** One batch of `ls:traffic` entries into traffic_1m; malformed entries and far-off minutes are dropped. */
export async function storeTrafficEntries(sql: Sql, entries: Entry[]) {
	const rows: { nodeId: string; minute: TrafficMinute }[] = [];
	for (const [, fields] of entries) {
		const nodeId = field(fields, "node");
		const parsed = TrafficEntry.safeParse(
			JSON.parse(field(fields, "data") ?? "null"),
		);
		if (!nodeId || !parsed.success) {
			log("warn", "dropped malformed traffic entry", { node: nodeId });
			continue;
		}
		// Partitions exist from yesterday on; older minutes (a long outage) have no home.
		for (const minute of parsed.data)
			if (Math.abs(minute.ts - Date.now()) < 86_400_000)
				rows.push({ nodeId, minute });
	}
	await insertTraffic(sql, rows);
}

type Row = Record<(typeof SUMS)[number], number> &
	Record<(typeof MAPS)[number], Record<string, number>> & {
		domain_id: string;
		ts: string;
		service_id: string;
		organization_id: string;
		visitors: Uint8Array | null;
	};

/** Sums counts, merges histograms and top-k maps (kept to 200 keys) and visitor sketches. */
export function mergeRows(rows: Row[]) {
	const out = {
		...(Object.fromEntries(SUMS.map((c) => [c, 0])) as Record<
			(typeof SUMS)[number],
			number
		>),
		...(Object.fromEntries(MAPS.map((c) => [c, {}])) as Record<
			(typeof MAPS)[number],
			Record<string, number>
		>),
	};
	let visitors: Uint8Array | undefined;
	for (const r of rows) {
		for (const c of SUMS) out[c] += Number(r[c]);
		for (const c of MAPS) mergeCounts(out[c], r[c]);
		if (r.visitors?.length)
			visitors = hllMerge(visitors ?? hllNew(), hllDecode(r.visitors));
	}
	for (const c of MAPS)
		if (c !== "latency") out[c] = Object.fromEntries(topN(out[c], 200));
	return { ...out, visitors };
}

const HOUR = 3_600_000;
const floorTo = (t: number, ms: number) => Math.floor(t / ms) * ms;

/** Recomputes every hour in [from, to) from traffic_1m; idempotent. */
export async function rollupTrafficHour(sql: Sql, from: Date, to: Date) {
	const rows = await sql.unsafe<Row[]>(
		"select * from traffic_1m where ts >= $1 and ts < $2",
		[from.toISOString(), to.toISOString()],
	);
	const groups = new Map<string, Row[]>();
	for (const r of rows) {
		const hour = floorTo(new Date(r.ts).getTime(), HOUR);
		const key = `${r.domain_id}|${hour}`;
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	const out = [...groups.entries()].map(([key, rs]) => {
		const [domainId, hour] = key.split("|");
		const m = mergeRows(rs);
		const first = rs[0] as Row;
		return {
			...m,
			domain_id: domainId,
			ts: new Date(Number(hour)).toISOString(),
			service_id: first.service_id,
			organization_id: first.organization_id,
			visitors: m.visitors
				? Buffer.from(hllEncode(m.visitors)).toString("base64")
				: "",
		};
	});
	if (!out.length) return;
	await sql.unsafe(
		`insert into traffic_1h
		select domain_id, ts, service_id, organization_id, requests, s1, s2, s3, s4, s5,
			bytes_in, bytes_out, pageviews, bots, latency, paths, referrers, countries, utm_sources, events,
			decode(nullif(visitors, ''), 'base64')
		from jsonb_to_recordset($1::jsonb) as r(${COLS.replace("node_id text, ", "")})
		on conflict (domain_id, ts) do update set ${SET}`,
		[JSON.stringify(out)],
	);
}

/** Rolls finished hours (minutes are final 30 s after they end), re-doing the last one for late rows. */
export async function rollupTraffic(sql: Sql, now = new Date()) {
	const to = new Date(floorTo(now.getTime() - 30_000, HOUR) + HOUR);
	const [row] = await sql<
		{ through: string }[]
	>`select through::text from metric_rollup_state where name = 'traffic_1h'`;
	const from = new Date(
		(row ? new Date(row.through).getTime() : to.getTime() - 24 * HOUR) - HOUR,
	);
	await rollupTrafficHour(sql, from, to);
	// The current hour is partial: the watermark stays at its start, so the next pass redoes it.
	const through = new Date(to.getTime() - HOUR).toISOString();
	await sql`insert into metric_rollup_state (name, through) values ('traffic_1h', ${through}::timestamptz)
		on conflict (name) do update set through = excluded.through`;
}

/** The autoscaler hook over traffic_1m (stub: nothing calls it yet). */
export const trafficSignal =
	(sql: Sql): TrafficSignalSource =>
	async (serviceId, windowSec) => {
		const rows = await sql<Row[]>`select * from traffic_1m
			where service_id = ${serviceId} and ts >= now() - make_interval(secs => ${windowSec})`;
		if (!rows.length) return null;
		const m = mergeRows(rows);
		const [p95] = quantiles(m.latency, [0.95]);
		return {
			windowSec,
			requestsPerSec: m.requests / windowSec,
			p95Ms: p95 ?? null,
			errorRate: m.requests ? m.s5 / m.requests : 0,
		};
	};
