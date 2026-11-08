import type { MetricRange, TrafficPoint } from "@logistack/contracts";
import {
	hllDecode,
	hllEstimate,
	hllMerge,
	hllNew,
	quantiles,
} from "@logistack/core/traffic";
import type { Db } from "@logistack/db";
import { loadRetention, pickResolution } from "./metrics-query.ts";

type Sql = Db["$client"];

export type TrafficScope =
	| { serviceId: string; domainId?: string }
	| { organizationId: string };

export type TrafficWindow = {
	table: "traffic_1m" | "traffic_1h";
	step: number;
	from: Date;
};

/** traffic_1m while the minute retention holds the range, else traffic_1h; steps as for metrics. */
export async function trafficWindow(
	sql: Sql,
	range: MetricRange,
	now = Date.now(),
): Promise<TrafficWindow> {
	const r = await loadRetention(sql);
	// Traffic has no raw table: a zero raw retention keeps pickResolution on the rollups.
	const { source, stepSec } = pickResolution(range, { ...r, rawHours: 0 });
	const step = Math.max(stepSec, 60);
	const from = new Date(
		Math.floor((now - rangeMs(range)) / (step * 1000)) * step * 1000,
	);
	return { table: source === "1h" ? "traffic_1h" : "traffic_1m", step, from };
}

const rangeMs = (r: MetricRange) =>
	({ "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 })[r] * 3_600_000;

function where(scope: TrafficScope): [string, unknown[]] {
	if ("organizationId" in scope)
		return ["organization_id = $2", [scope.organizationId]];
	return scope.domainId
		? ["service_id = $2 and domain_id = $3", [scope.serviceId, scope.domainId]]
		: ["service_id = $2", [scope.serviceId]];
}

const SUMS = `sum(requests)::float8 as requests, sum(s1)::float8 as s1, sum(s2)::float8 as s2,
	sum(s3)::float8 as s3, sum(s4)::float8 as s4, sum(s5)::float8 as s5,
	sum(bytes_in)::float8 as bytes_in, sum(bytes_out)::float8 as bytes_out,
	sum(pageviews)::float8 as pageviews, sum(bots)::float8 as bots`;

type Sums = Record<
	| "requests"
	| "s1"
	| "s2"
	| "s3"
	| "s4"
	| "s5"
	| "bytes_in"
	| "bytes_out"
	| "pageviews"
	| "bots",
	number | null
>;

/** Requests, status classes, bytes and latency percentiles per step bucket, gaps filled with zeros. */
export async function trafficSeries(
	sql: Sql,
	scope: TrafficScope,
	w: TrafficWindow,
	now = Date.now(),
): Promise<TrafficPoint[]> {
	const [cond, params] = where(scope);
	const bucket = `(extract(epoch from date_bin(make_interval(secs => ${w.step}), ts, timestamptz 'epoch')) * 1000)::float8`;
	const rows = await sql.unsafe<(Sums & { t: number })[]>(
		`select ${bucket} as t, ${SUMS} from ${w.table} where ts >= $1 and ${cond} group by 1`,
		[w.from.toISOString(), ...params],
	);
	const lat = await sql.unsafe<{ t: number; k: string; n: number }[]>(
		`select ${bucket} as t, l.key as k, sum(l.value::int)::float8 as n
		from ${w.table}, jsonb_each_text(latency) l where ts >= $1 and ${cond} group by 1, 2`,
		[w.from.toISOString(), ...params],
	);
	const hist = new Map<number, Record<string, number>>();
	for (const r of lat) {
		const h = hist.get(r.t) ?? {};
		h[r.k] = r.n;
		hist.set(r.t, h);
	}
	const byT = new Map(rows.map((r) => [r.t, r]));
	const out: TrafficPoint[] = [];
	for (let t = w.from.getTime(); t <= now; t += w.step * 1000) {
		const r = byT.get(t);
		const [p50, p95, p99] = quantiles(hist.get(t) ?? {}, [0.5, 0.95, 0.99]);
		const requests = r?.requests ?? 0;
		out.push({
			t,
			requests,
			rps: requests / w.step,
			s2: r?.s2 ?? 0,
			s3: r?.s3 ?? 0,
			s4: r?.s4 ?? 0,
			s5: r?.s5 ?? 0,
			bytesOut: r?.bytes_out ?? 0,
			pageviews: r?.pageviews ?? 0,
			p50: p50 ?? null,
			p95: p95 ?? null,
			p99: p99 ?? null,
		});
	}
	return out;
}

export async function trafficTotals(
	sql: Sql,
	scope: TrafficScope,
	w: TrafficWindow,
) {
	const [cond, params] = where(scope);
	const args = [w.from.toISOString(), ...params];
	const [s] = await sql.unsafe<Sums[]>(
		`select ${SUMS} from ${w.table} where ts >= $1 and ${cond}`,
		args,
	);
	const lat = await sql.unsafe<{ k: string; n: number }[]>(
		`select l.key as k, sum(l.value::int)::float8 as n from ${w.table}, jsonb_each_text(latency) l
		where ts >= $1 and ${cond} group by 1`,
		args,
	);
	const [p50, p95, p99] = quantiles(
		Object.fromEntries(lat.map((r) => [r.k, r.n])),
		[0.5, 0.95, 0.99],
	);
	const sketches = await sql.unsafe<{ v: Uint8Array }[]>(
		`select visitors as v from ${w.table} where ts >= $1 and ${cond} and visitors is not null`,
		args,
	);
	const regs = hllNew();
	for (const { v } of sketches) {
		try {
			hllMerge(regs, hllDecode(v));
		} catch {
			// a malformed sketch counts as no visitors
		}
	}
	const n = (v: number | null | undefined) => v ?? 0;
	return {
		requests: n(s?.requests),
		visitors: hllEstimate(regs),
		pageviews: n(s?.pageviews),
		bots: n(s?.bots),
		bytesIn: n(s?.bytes_in),
		bytesOut: n(s?.bytes_out),
		status: [n(s?.s1), n(s?.s2), n(s?.s3), n(s?.s4), n(s?.s5)] as [
			number,
			number,
			number,
			number,
			number,
		],
		p50: p50 ?? null,
		p95: p95 ?? null,
		p99: p99 ?? null,
	};
}

const RANKED = [
	"paths",
	"referrers",
	"countries",
	"utm_sources",
	"events",
] as const;

/** The `limit` largest keys of each top-k column over the window. */
export async function trafficRanked(
	sql: Sql,
	scope: TrafficScope,
	w: TrafficWindow,
	limit = 20,
) {
	const [cond, params] = where(scope);
	const out: Record<(typeof RANKED)[number], { key: string; count: number }[]> =
		{
			paths: [],
			referrers: [],
			countries: [],
			utm_sources: [],
			events: [],
		};
	for (const col of RANKED)
		out[col] = await sql.unsafe<{ key: string; count: number }[]>(
			`select e.key, sum(e.value::bigint)::float8 as count from ${w.table}, jsonb_each_text(${col}) e
			where ts >= $1 and ${cond} and e.key <> '(other)'
			group by 1 order by 2 desc, 1 limit ${limit}`,
			[w.from.toISOString(), ...params],
		);
	return out;
}

/** Per service over the window, for the organization overview. */
export async function trafficByService(
	sql: Sql,
	organizationId: string,
	w: TrafficWindow,
) {
	const rows = await sql.unsafe<
		{ service_id: string; requests: number; s5: number; v: Uint8Array[] }[]
	>(
		`select service_id, sum(requests)::float8 as requests, sum(s5)::float8 as s5,
			array_agg(visitors) filter (where visitors is not null) as v
		from ${w.table} where ts >= $1 and organization_id = $2 group by 1`,
		[w.from.toISOString(), organizationId],
	);
	const lat = await sql.unsafe<{ service_id: string; k: string; n: number }[]>(
		`select service_id, l.key as k, sum(l.value::int)::float8 as n from ${w.table}, jsonb_each_text(latency) l
		where ts >= $1 and organization_id = $2 group by 1, 2`,
		[w.from.toISOString(), organizationId],
	);
	const hist = new Map<string, Record<string, number>>();
	for (const r of lat)
		hist.set(r.service_id, { ...hist.get(r.service_id), [r.k]: r.n });
	return rows.map((r) => {
		const regs = hllNew();
		for (const v of r.v ?? []) {
			try {
				hllMerge(regs, hllDecode(v));
			} catch {}
		}
		return {
			serviceId: r.service_id,
			requests: r.requests,
			visitors: hllEstimate(regs),
			errorRate: r.requests ? r.s5 / r.requests : 0,
			p95: quantiles(hist.get(r.service_id) ?? {}, [0.95])[0] ?? null,
		};
	});
}
