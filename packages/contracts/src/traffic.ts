import { z } from "zod";

// Traffic analytics: the agent aggregates its node's Caddy access log per minute and domain and
// ships `TrafficMinute`s (never raw lines, never an IP). The API appends them to TRAFFIC_STREAM
// and answers `traffic.ack`; the worker upserts them. See docs/plans/traffic-analytics.md.

/** Redis stream the agent gateway appends `traffic` batches to; the worker consumes it. */
export const TRAFFIC_STREAM = "ls:traffic";
/** Path prefix Caddy answers itself on domains with web analytics on (script and beacon). */
export const WEB_ANALYTICS_PREFIX = "/_ls/";
export const TOP_KEYS = 50;
export const MAX_KEY_CHARS = 200;

const Count = z.number().int().nonnegative();
/** Key -> count, at most TOP_KEYS keys of at most MAX_KEY_CHARS. */
export const TopCounts = z
	.record(z.string().max(MAX_KEY_CHARS), Count)
	.refine((r) => Object.keys(r).length <= TOP_KEYS, "too many keys");
export type TopCounts = z.infer<typeof TopCounts>;

export const TrafficRoute = z.object({
	hostname: z.string().min(1).max(253),
	pathPrefix: z.string().max(512).optional(),
	domainId: z.string().min(1).max(64),
	serviceId: z.string().min(1).max(64),
	organizationId: z.string().min(1).max(64),
	/** The first-party script is on: pageviews and referrers come from its beacons only. */
	script: z.boolean(),
});
export type TrafficRoute = z.infer<typeof TrafficRoute>;

export const TrafficConfig = z.object({
	/** Swarm service name of Caddy; the agent follows its containers on its own node. */
	caddyService: z.string().min(1).max(255),
	/** UTC day (`YYYY-MM-DD`) -> visitor hash salt (hex). Only today and tomorrow are sent. */
	salts: z.record(z.string().regex(/^\d{4}-\d\d-\d\d$/), z.string().min(16)),
	routes: z.array(TrafficRoute).max(20_000),
});
export type TrafficConfig = z.infer<typeof TrafficConfig>;

export const TrafficMinute = z.object({
	/** Minute start, Unix ms. */
	ts: z.number().int(),
	domainId: z.string().min(1).max(64),
	serviceId: z.string().min(1).max(64),
	organizationId: z.string().min(1).max(64),
	requests: Count,
	/** Requests per status class: 1xx, 2xx, 3xx, 4xx, 5xx. */
	status: z.tuple([Count, Count, Count, Count, Count]),
	bytesIn: Count,
	bytesOut: Count,
	/** Latency histogram, bucket index (see `latencyBucket`) -> requests. */
	latency: z
		.record(z.string().regex(/^\d{1,3}$/), Count)
		.refine((r) => Object.keys(r).length <= 256),
	pageviews: Count,
	/** Requests from user agents that look automated; not in visitors or pageviews. */
	bots: Count,
	paths: TopCounts,
	referrers: TopCounts,
	/** ISO 3166-1 alpha-2 -> requests; empty without a GeoIP database. */
	countries: TopCounts,
	utmSources: TopCounts,
	/** Custom event name (script only) -> count. */
	events: TopCounts,
	/** HyperLogLog sketch of the salted visitor hashes, base64 (see `hllEncode`). */
	visitors: z.string().max(2048),
});
export type TrafficMinute = z.infer<typeof TrafficMinute>;

// ---- REST ----

// Same values as MetricRange; not imported, since monitoring.ts imports agent.ts, which imports this file.
const MetricRange = z.enum(["1h", "6h", "24h", "7d", "30d"]);

export const TrafficQuery = z.object({
	range: MetricRange.default("24h"),
	domainId: z.string().optional(),
});

export const TrafficPoint = z.object({
	t: z.number(),
	requests: z.number(),
	/** Per second over the bucket. */
	rps: z.number(),
	s2: z.number(),
	s3: z.number(),
	s4: z.number(),
	s5: z.number(),
	bytesOut: z.number(),
	pageviews: z.number(),
	p50: z.number().nullable(),
	p95: z.number().nullable(),
	p99: z.number().nullable(),
});
export type TrafficPoint = z.infer<typeof TrafficPoint>;

const Ranked = z.array(z.object({ key: z.string(), count: z.number() }));

export const TrafficReport = z.object({
	range: MetricRange,
	/** Bucket width in seconds: 60 up to 24h, 3600 beyond. */
	step: z.number(),
	totals: z.object({
		requests: z.number(),
		visitors: z.number(),
		pageviews: z.number(),
		bots: z.number(),
		bytesIn: z.number(),
		bytesOut: z.number(),
		status: z.tuple([
			z.number(),
			z.number(),
			z.number(),
			z.number(),
			z.number(),
		]),
		/** Milliseconds; null with no requests. */
		p50: z.number().nullable(),
		p95: z.number().nullable(),
		p99: z.number().nullable(),
	}),
	series: z.array(TrafficPoint),
	paths: Ranked,
	referrers: Ranked,
	countries: Ranked,
	utmSources: Ranked,
	events: Ranked,
	domains: z.array(
		z.object({
			id: z.string(),
			hostname: z.string(),
			webAnalytics: z.boolean(),
		}),
	),
});
export type TrafficReport = z.infer<typeof TrafficReport>;

export const TrafficOverview = z.object({
	range: MetricRange,
	step: z.number(),
	series: z.array(TrafficPoint),
	services: z.array(
		z.object({
			serviceId: z.string(),
			name: z.string(),
			projectId: z.string(),
			project: z.string(),
			requests: z.number(),
			visitors: z.number(),
			errorRate: z.number(),
			p95: z.number().nullable(),
		}),
	),
});
export type TrafficOverview = z.infer<typeof TrafficOverview>;
