import { createHash } from "node:crypto";
import {
	type AgentMessage,
	MAX_KEY_CHARS,
	TOP_KEYS,
	type TrafficConfig,
	type TrafficMinute,
	type TrafficRoute,
	WEB_ANALYTICS_PREFIX,
} from "@logistack/contracts";
import {
	cleanPath,
	hllAdd,
	hllEncode,
	hllNew,
	isBot,
	isPageview,
	latencyBucket,
	matchRoute,
	type RouteTable,
	referrerHost,
	routeTable,
	topN,
} from "@logistack/core/traffic";
import type { DockerClient } from "@logistack/docker";
import { parseTimestamped } from "./drains.ts";
import type { CountryReader } from "./geoip.ts";
import { lineSplitter } from "./sessions.ts";

// Traffic analytics from the local Caddy's JSON access log. Lines are folded into per-minute,
// per-domain aggregates as they arrive; the IP and user agent only feed a salted hash and a
// country lookup, then are dropped. Memory is bounded at every stage (see TrafficLimits).

export type TrafficLimits = {
	/** Open (minute, domain) aggregates; lines for a new one past this are dropped and counted. */
	maxOpen: number;
	/** Distinct keys per top-k map while a minute is open; later keys go to "(other)". */
	maxKeys: number;
	/** Closed minutes waiting for an ack, in approximate JSON bytes; the oldest go first. */
	maxOutboxBytes: number;
	/** One `traffic` frame. */
	maxBatchBytes: number;
	/** A minute stays open this long after it ends, for late lines. */
	graceMs: number;
	/** An unacked batch is resent after this. */
	ackTimeoutMs: number;
};

export const DEFAULT_TRAFFIC_LIMITS: TrafficLimits = {
	maxOpen: 2000,
	maxKeys: 500,
	maxOutboxBytes: 8 * 1024 * 1024,
	maxBatchBytes: 512 * 1024,
	graceMs: 10_000,
	ackTimeoutMs: 30_000,
};

const OTHER = "(other)";
const MINUTE = 60_000;

/** The fields of a Caddy access log entry we read. */
type AccessEntry = {
	logger?: string;
	ts?: number;
	status?: number;
	duration?: number;
	size?: number;
	bytes_read?: number;
	request?: {
		remote_ip?: string;
		client_ip?: string;
		method?: string;
		host?: string;
		uri?: string;
		headers?: Record<string, string[] | undefined>;
	};
};

type Agg = {
	ts: number;
	route: TrafficRoute;
	requests: number;
	status: [number, number, number, number, number];
	bytesIn: number;
	bytesOut: number;
	latency: Record<string, number>;
	pageviews: number;
	bots: number;
	paths: Map<string, number>;
	referrers: Map<string, number>;
	countries: Map<string, number>;
	utmSources: Map<string, number>;
	events: Map<string, number>;
	visitors: Uint8Array | undefined;
};

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type AggregatorStats = {
	lines: number;
	unmatched: number;
	dropped: number;
};

export class TrafficAggregator {
	private table: RouteTable = routeTable([]);
	private salts: Record<string, string> = {};
	private open = new Map<string, Agg>();
	readonly stats: AggregatorStats = { lines: 0, unmatched: 0, dropped: 0 };

	constructor(
		private limits: TrafficLimits = DEFAULT_TRAFFIC_LIMITS,
		private country?: CountryReader,
	) {}

	configure(config: Pick<TrafficConfig, "routes" | "salts">) {
		this.table = routeTable(config.routes);
		this.salts = config.salts;
	}

	setCountryReader(r: CountryReader | undefined) {
		this.country = r;
	}

	get openCount() {
		return this.open.size;
	}

	private bump(m: Map<string, number>, key: string, n = 1) {
		const k = key.slice(0, MAX_KEY_CHARS);
		if (!m.has(k) && m.size >= this.limits.maxKeys)
			return void m.set(OTHER, (m.get(OTHER) ?? 0) + n);
		m.set(k, (m.get(k) ?? 0) + n);
	}

	private agg(ts: number, route: TrafficRoute): Agg | undefined {
		const key = `${ts}|${route.domainId}`;
		let a = this.open.get(key);
		if (a) return a;
		if (this.open.size >= this.limits.maxOpen) return undefined;
		a = {
			ts,
			route,
			requests: 0,
			status: [0, 0, 0, 0, 0],
			bytesIn: 0,
			bytesOut: 0,
			latency: {},
			pageviews: 0,
			bots: 0,
			paths: new Map(),
			referrers: new Map(),
			countries: new Map(),
			utmSources: new Map(),
			events: new Map(),
			visitors: undefined,
		};
		this.open.set(key, a);
		return a;
	}

	private visitor(a: Agg, ip: string | undefined, ua: string) {
		const salt = this.salts[dayOf(a.ts)];
		if (!salt || !ip) return;
		const hash = createHash("sha256")
			.update(`${salt}\n${a.route.domainId}\n${ip}\n${ua}`)
			.digest();
		a.visitors ??= hllNew();
		hllAdd(a.visitors, hash);
	}

	/** Folds one log line in. `now` bounds how old a line may be (an already-closed minute is dropped). */
	ingest(line: string, now = Date.now()) {
		if (!line.includes('"http.log.access')) return;
		let e: AccessEntry;
		try {
			e = JSON.parse(line);
		} catch {
			return;
		}
		if (
			!e.logger?.startsWith("http.log.access") ||
			!e.request ||
			typeof e.ts !== "number"
		)
			return;
		this.stats.lines++;
		const r = e.request;
		const uri = r.uri ?? "/";
		const path = cleanPath(uri, 2048);
		const route = matchRoute(this.table, r.host ?? "", path);
		if (!route) return void this.stats.unmatched++;
		const atMs = Math.floor(e.ts * 1000);
		const ts = Math.floor(atMs / MINUTE) * MINUTE;
		if (ts + MINUTE + this.limits.graceMs < now)
			return void this.stats.dropped++;
		const a = this.agg(ts, route);
		if (!a) return void this.stats.dropped++;

		const h = r.headers ?? {};
		const ua = h["User-Agent"]?.[0] ?? "";
		const ip = r.client_ip || r.remote_ip;
		const bot = isBot(ua);
		const status = e.status ?? 0;

		if (route.script && path.includes(WEB_ANALYTICS_PREFIX)) {
			// The script and its beacon are answered by Caddy itself; only the beacon counts, as an event.
			if (!path.endsWith(`${WEB_ANALYTICS_PREFIX}e`) || bot) return;
			const q = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
			this.visitor(a, ip, ua);
			const name = (q.get("n") || "pageview").slice(0, 64);
			if (name !== "pageview") return this.bump(a.events, name);
			a.pageviews++;
			const ref = referrerHost(q.get("r") ?? undefined, r.host ?? "");
			if (ref) this.bump(a.referrers, ref);
			const page = q.get("u") ?? "";
			const utm = new URLSearchParams(page.slice(page.indexOf("?") + 1)).get(
				"utm_source",
			);
			if (utm && page.includes("?")) this.bump(a.utmSources, utm.toLowerCase());
			return;
		}

		a.requests++;
		const cls = Math.floor(status / 100);
		if (cls >= 1 && cls <= 5) a.status[cls - 1] = (a.status[cls - 1] ?? 0) + 1;
		a.bytesIn += e.bytes_read ?? 0;
		a.bytesOut += e.size ?? 0;
		const b = String(latencyBucket((e.duration ?? 0) * 1000));
		a.latency[b] = (a.latency[b] ?? 0) + 1;
		this.bump(a.paths, cleanPath(uri));
		if (bot) return void a.bots++;
		this.visitor(a, ip, ua);
		const c = ip ? this.country?.(ip) : undefined;
		if (c) this.bump(a.countries, c);
		if (route.script || !isPageview(r.method ?? "", status, h.Accept?.[0]))
			return;
		a.pageviews++;
		const ref = referrerHost(h.Referer?.[0], r.host ?? "");
		if (ref) this.bump(a.referrers, ref);
		const utm = uri.includes("?")
			? new URLSearchParams(uri.slice(uri.indexOf("?") + 1)).get("utm_source")
			: null;
		if (utm) this.bump(a.utmSources, utm.toLowerCase());
	}

	/** Closes and returns every minute that ended more than `graceMs` before `now` (all of them with `all`). */
	close(now = Date.now(), all = false): TrafficMinute[] {
		const out: TrafficMinute[] = [];
		for (const [key, a] of this.open) {
			if (!all && a.ts + MINUTE + this.limits.graceMs > now) continue;
			this.open.delete(key);
			const top = (m: Map<string, number>) =>
				Object.fromEntries(topN(Object.fromEntries(m), TOP_KEYS));
			out.push({
				ts: a.ts,
				domainId: a.route.domainId,
				serviceId: a.route.serviceId,
				organizationId: a.route.organizationId,
				requests: a.requests,
				status: a.status,
				bytesIn: a.bytesIn,
				bytesOut: a.bytesOut,
				latency: a.latency,
				pageviews: a.pageviews,
				bots: a.bots,
				paths: top(a.paths),
				referrers: top(a.referrers),
				countries: top(a.countries),
				utmSources: top(a.utmSources),
				events: top(a.events),
				visitors: a.visitors
					? Buffer.from(hllEncode(a.visitors)).toString("base64")
					: "",
			});
		}
		return out;
	}
}

type Pending = { minute: TrafficMinute; bytes: number };

/** Closed minutes until the server acks them; bounded by bytes, shedding the oldest. */
export class TrafficOutbox {
	private queue: Pending[] = [];
	private bytes = 0;
	private inflight: { seq: number; count: number; sentAt: number } | undefined;
	private seq = 0;
	dropped = 0;

	constructor(private limits: TrafficLimits = DEFAULT_TRAFFIC_LIMITS) {}

	get length() {
		return this.queue.length;
	}

	get heldBytes() {
		return this.bytes;
	}

	push(minutes: TrafficMinute[]) {
		for (const minute of minutes) {
			const bytes = JSON.stringify(minute).length;
			this.queue.push({ minute, bytes });
			this.bytes += bytes;
		}
		// Never shed what is in flight: the ack would then remove the wrong entries.
		const keep = this.inflight?.count ?? 0;
		while (
			this.bytes > this.limits.maxOutboxBytes &&
			this.queue.length > keep
		) {
			const [old] = this.queue.splice(keep, 1);
			this.bytes -= old?.bytes ?? 0;
			this.dropped++;
		}
	}

	/** The next batch to send, or undefined while one is in flight (until it times out). */
	next(
		now = Date.now(),
	): Extract<AgentMessage, { type: "traffic" }> | undefined {
		if (this.inflight && now - this.inflight.sentAt < this.limits.ackTimeoutMs)
			return undefined;
		if (!this.queue.length) return undefined;
		let bytes = 0;
		let count = 0;
		while (count < this.queue.length && count < 500) {
			const p = this.queue[count] as Pending;
			if (count > 0 && bytes + p.bytes > this.limits.maxBatchBytes) break;
			bytes += p.bytes;
			count++;
		}
		this.inflight = { seq: ++this.seq, count, sentAt: now };
		return {
			type: "traffic",
			seq: this.seq,
			minutes: this.queue.slice(0, count).map((p) => p.minute),
		};
	}

	ack(seq: number) {
		if (this.inflight?.seq !== seq) return;
		for (const p of this.queue.splice(0, this.inflight.count))
			this.bytes -= p.bytes;
		this.inflight = undefined;
	}

	/** The connection dropped: what was in flight goes again on the next one. */
	reset() {
		this.inflight = undefined;
	}
}

const SERVICE_NAME = "com.docker.swarm.service.name";

/** Follows the local Caddy containers' logs into an aggregator, and ships closed minutes. */
export function createTraffic(
	docker: DockerClient,
	opts: {
		send: (m: AgentMessage) => boolean;
		limits?: Partial<TrafficLimits>;
		onError?: (msg: string, fields: Record<string, unknown>) => void;
	},
) {
	const limits = { ...DEFAULT_TRAFFIC_LIMITS, ...opts.limits };
	const agg = new TrafficAggregator(limits);
	const outbox = new TrafficOutbox(limits);
	const followers = new Map<string, AbortController>();
	let caddyService: string | undefined;

	async function follow(containerId: string, ac: AbortController) {
		let since = Date.now() / 1000;
		for (let attempt = 0; !ac.signal.aborted; attempt++) {
			try {
				const frames = await docker.containers.logs(containerId, {
					follow: true,
					timestamps: true,
					since,
					signal: ac.signal,
				});
				const split = lineSplitter();
				for await (const fr of frames) {
					attempt = 0;
					for (const raw of split.push(
						fr.stream === "stderr" ? "stderr" : "stdout",
						fr.data,
					)) {
						const p = parseTimestamped(raw);
						if (!p) continue;
						since = (p.at + 1) / 1000;
						agg.ingest(p.line);
					}
				}
				return;
			} catch (e) {
				if (ac.signal.aborted) return;
				opts.onError?.("traffic log stream failed", {
					containerId,
					error: String(e),
				});
				await Bun.sleep(Math.min(30_000, 500 * 2 ** attempt));
			}
		}
	}

	async function reconcile() {
		const wanted = new Set<string>();
		if (caddyService) {
			const running = await docker.containers.list({
				label: [`${SERVICE_NAME}=${caddyService}`],
				status: ["running"],
			});
			for (const c of running) wanted.add(c.Id);
		}
		for (const [id, ac] of followers)
			if (!wanted.has(id)) {
				ac.abort();
				followers.delete(id);
			}
		for (const id of wanted) {
			if (followers.has(id)) continue;
			const ac = new AbortController();
			followers.set(id, ac);
			void follow(id, ac).finally(() => {
				if (followers.get(id) === ac) followers.delete(id);
			});
		}
	}

	function flush(now = Date.now()) {
		outbox.push(agg.close(now));
		const batch = outbox.next(now);
		if (batch && !opts.send(batch)) outbox.reset();
	}
	const timer = setInterval(flush, 5_000);

	return {
		aggregator: agg,
		outbox,
		apply(config: TrafficConfig) {
			agg.configure(config);
			caddyService = config.caddyService;
			return reconcile().catch((e) =>
				opts.onError?.("traffic reconcile failed", { error: String(e) }),
			);
		},
		containerEvent: () => void reconcile().catch(() => {}),
		ack: (seq: number) => {
			outbox.ack(seq);
			flush();
		},
		disconnected: () => outbox.reset(),
		flush,
		get following() {
			return followers.size;
		},
		close() {
			clearInterval(timer);
			for (const ac of followers.values()) ac.abort();
			followers.clear();
		},
	};
}

export type Traffic = ReturnType<typeof createTraffic>;
