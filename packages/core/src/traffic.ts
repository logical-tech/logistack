import type { TrafficRoute } from "@logistack/contracts";

// Pure pieces of traffic analytics, shared by the agent (aggregation) and the API (queries).

// ---- HyperLogLog (p = 10: 1024 registers, ~3.25% standard error) ----

export const HLL_P = 10;
export const HLL_M = 1 << HLL_P;

export const hllNew = () => new Uint8Array(HLL_M);

/** Adds a hash of at least 8 bytes (e.g. SHA-256). */
export function hllAdd(regs: Uint8Array, hash: Uint8Array) {
	const hi =
		((hash[0] as number) << 24) |
		((hash[1] as number) << 16) |
		((hash[2] as number) << 8) |
		(hash[3] as number);
	const lo =
		((hash[4] as number) << 24) |
		((hash[5] as number) << 16) |
		((hash[6] as number) << 8) |
		(hash[7] as number);
	const idx = hi >>> (32 - HLL_P);
	// The 54 bits after the index: 22 from `hi`, 32 from `lo`.
	const rest = (hi << HLL_P) >>> 0;
	let rank: number;
	if (rest !== 0) rank = Math.clz32(rest) + 1;
	else rank = lo !== 0 ? 22 + Math.clz32(lo) + 1 : 55;
	if (rank > (regs[idx] as number)) regs[idx] = rank;
}

/** Max per register, in place on `into`; merging is idempotent and order-free. */
export function hllMerge(into: Uint8Array, other: Uint8Array) {
	for (let i = 0; i < HLL_M; i++)
		if ((other[i] as number) > (into[i] as number))
			into[i] = other[i] as number;
	return into;
}

export function hllEstimate(regs: Uint8Array): number {
	let sum = 0;
	let zeros = 0;
	for (let i = 0; i < HLL_M; i++) {
		const r = regs[i] as number;
		sum += 2 ** -r;
		if (r === 0) zeros++;
	}
	const alpha = 0.7213 / (1 + 1.079 / HLL_M);
	const e = (alpha * HLL_M * HLL_M) / sum;
	// Linear counting is far more accurate for small sets.
	if (e <= 2.5 * HLL_M && zeros > 0)
		return Math.round(HLL_M * Math.log(HLL_M / zeros));
	return Math.round(e);
}

/** Sparse (`1`, then idx-hi, idx-lo, rank triples) when that is smaller, else dense (`0` + registers). */
export function hllEncode(regs: Uint8Array): Uint8Array {
	let nonzero = 0;
	for (const r of regs) if (r) nonzero++;
	if (nonzero * 3 >= HLL_M) {
		const out = new Uint8Array(HLL_M + 1);
		out.set(regs, 1);
		return out;
	}
	const out = new Uint8Array(1 + nonzero * 3);
	out[0] = 1;
	let j = 1;
	for (let i = 0; i < HLL_M; i++) {
		const r = regs[i] as number;
		if (!r) continue;
		out[j++] = i >> 8;
		out[j++] = i & 0xff;
		out[j++] = r;
	}
	return out;
}

/** Throws on a malformed sketch. */
export function hllDecode(buf: Uint8Array): Uint8Array {
	const regs = hllNew();
	if (buf.length === 0) return regs;
	if (buf[0] === 0) {
		if (buf.length !== HLL_M + 1) throw new Error("bad dense sketch");
		regs.set(buf.subarray(1));
		return regs;
	}
	if (buf[0] !== 1 || (buf.length - 1) % 3 !== 0)
		throw new Error("bad sparse sketch");
	for (let j = 1; j < buf.length; j += 3) {
		const i = ((buf[j] as number) << 8) | (buf[j + 1] as number);
		if (i >= HLL_M) throw new Error("bad sparse sketch");
		regs[i] = Math.max(regs[i] as number, buf[j + 2] as number);
	}
	return regs;
}

// ---- Latency histogram: 8 buckets per doubling of milliseconds (~4.4% relative error) ----

const PER_DOUBLING = 8;
export const LATENCY_BUCKETS = 256;

/** Bucket 0 holds < 1 ms; bucket i >= 1 holds [2^((i-1)/8), 2^(i/8)) ms. */
export function latencyBucket(ms: number): number {
	if (!(ms >= 1)) return 0;
	return Math.min(
		LATENCY_BUCKETS - 1,
		1 + Math.floor(Math.log2(ms) * PER_DOUBLING),
	);
}

/** The value reported for a bucket: its geometric midpoint. */
export function bucketValue(i: number): number {
	return i === 0 ? 0.5 : 2 ** ((i - 0.5) / PER_DOUBLING);
}

export type Histogram = Record<string, number>;

export function mergeCounts(
	into: Record<string, number>,
	other: Record<string, number>,
) {
	for (const [k, v] of Object.entries(other)) into[k] = (into[k] ?? 0) + v;
	return into;
}

/** Quantiles (0..1) of a histogram in ms, rounded to 0.1 ms; null when it is empty. */
export function quantiles(h: Histogram, qs: number[]): (number | null)[] {
	const buckets = Object.entries(h)
		.map(([k, v]) => [Number(k), v] as const)
		.filter(([, v]) => v > 0)
		.sort((a, b) => a[0] - b[0]);
	const total = buckets.reduce((s, [, v]) => s + v, 0);
	return qs.map((q) => {
		if (total === 0) return null;
		const rank = Math.max(1, Math.ceil(q * total));
		let cum = 0;
		for (const [i, v] of buckets) {
			cum += v;
			if (cum >= rank) return Math.round(bucketValue(i) * 10) / 10;
		}
		return null;
	});
}

/** The `n` largest entries, ties broken by key so the result is stable. */
export function topN(
	counts: Record<string, number>,
	n: number,
): [string, number][] {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, n);
}

// ---- Attribution: the same order Caddy evaluates routes in ----

export type RouteTable = {
	exact: Map<string, TrafficRoute[]>;
	wildcard: Map<string, TrafficRoute[]>;
};

const byPrefixDesc = (a: TrafficRoute, b: TrafficRoute) =>
	(b.pathPrefix?.length ?? 0) - (a.pathPrefix?.length ?? 0);

export function routeTable(routes: TrafficRoute[]): RouteTable {
	const exact = new Map<string, TrafficRoute[]>();
	const wildcard = new Map<string, TrafficRoute[]>();
	for (const r of routes) {
		const host = r.hostname.toLowerCase();
		const [map, key] = host.startsWith("*.")
			? [wildcard, host.slice(2)]
			: [exact, host];
		map.set(key, [...(map.get(key) ?? []), r].sort(byPrefixDesc));
	}
	return { exact, wildcard };
}

function prefixMatches(prefix: string | undefined, path: string) {
	const base = prefix?.replace(/\/+$/, "");
	return !base || path === base || path.startsWith(`${base}/`);
}

/** Exact host before a single-label wildcard, then the longest path prefix. */
export function matchRoute(
	t: RouteTable,
	rawHost: string,
	path: string,
): TrafficRoute | undefined {
	const host = rawHost.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
	const pick = (rs: TrafficRoute[] | undefined) =>
		rs?.find((r) => prefixMatches(r.pathPrefix, path));
	const hit = pick(t.exact.get(host));
	if (hit) return hit;
	const dot = host.indexOf(".");
	return dot > 0 ? pick(t.wildcard.get(host.slice(dot + 1))) : undefined;
}

// ---- Classification ----

const BOT =
	/bot|crawl|spider|slurp|archiver|curl|wget|python|httpx|aiohttp|go-http|java\/|okhttp|axios|node-fetch|undici|libwww|headless|phantom|lighthouse|pingdom|uptime|monitor|statuscake|facebookexternalhit|preview|scan/i;

export const isBot = (ua: string | undefined) => !ua || BOT.test(ua);

/** A browser navigation that rendered a page: GET, 2xx or 304, asking for HTML. */
export const isPageview = (
	method: string,
	status: number,
	accept: string | undefined,
) =>
	method === "GET" &&
	((status >= 200 && status < 300) || status === 304) &&
	!!accept?.includes("text/html");

/** The referrer's host, or undefined for none, a self-referral or garbage. */
export function referrerHost(
	referrer: string | undefined,
	ownHost: string,
): string | undefined {
	if (!referrer) return undefined;
	try {
		const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
		const own = ownHost
			.toLowerCase()
			.replace(/:\d+$/, "")
			.replace(/^www\./, "");
		return host && host !== own ? host : undefined;
	} catch {
		return undefined;
	}
}

/** Path without query or fragment, cut to `max` characters. */
export function cleanPath(uri: string, max = 200): string {
	const end = uri.search(/[?#]/);
	const p = end === -1 ? uri : uri.slice(0, end);
	return (p || "/").slice(0, max);
}

// ---- Autoscaler hook (stub: the autoscaler does not read it yet) ----

/** A service's recent traffic, as a future request-rate or latency autoscale trigger would read it. */
export type TrafficSignal = {
	windowSec: number;
	requestsPerSec: number;
	/** Milliseconds; null with no requests in the window. */
	p95Ms: number | null;
	errorRate: number;
};

/** Implemented by the worker over `traffic_1m`; null when the service has no domain traffic. */
export type TrafficSignalSource = (
	serviceId: string,
	windowSec: number,
) => Promise<TrafficSignal | null>;
