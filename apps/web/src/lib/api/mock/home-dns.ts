import {
	type HomeDns,
	type HomeDnsLogPage,
	type HomeDnsRecord,
	HomeDnsSettings,
	type HomeDnsStats,
	type HomeDnsStatsRange,
	type HomeDnsZone,
	homeDnsRecordId,
} from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { HomeDnsApi } from "../home-dns";
import { nodes } from "./monitoring";

const hostname = (id: string) =>
	nodes.find((n) => n.id === id)?.hostname ?? null;

/*
 * A believable house: ~20 devices on 192.168.1.0/24, a week of traffic with an evening
 * peak, ad and tracker lookups blocked by Hagezi Pro, and a home.lan zone. Turning the
 * feature on walks the real status machine on a timer so the wizard's progress shows.
 */

const delay = <T>(v: T, ms = 180 + Math.random() * 220) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

const HAGEZI_PRO =
	"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro-onlydomains.txt";

const CLIENTS: { ip: string; name: string; weight: number }[] = [
	{ ip: "192.168.1.21", name: "living-room-tv.home.lan", weight: 18 },
	{ ip: "192.168.1.34", name: "simone-iphone.home.lan", weight: 14 },
	{ ip: "192.168.1.35", name: "giulia-iphone.home.lan", weight: 12 },
	{ ip: "192.168.1.40", name: "macbook-pro.home.lan", weight: 11 },
	{ ip: "192.168.1.41", name: "work-laptop.home.lan", weight: 9 },
	{ ip: "192.168.1.52", name: "ipad-kids.home.lan", weight: 8 },
	{ ip: "192.168.1.60", name: "playstation.home.lan", weight: 6 },
	{ ip: "192.168.1.61", name: "echo-kitchen.home.lan", weight: 5 },
	{ ip: "192.168.1.62", name: "echo-bedroom.home.lan", weight: 4 },
	{ ip: "192.168.1.70", name: "nest-thermostat.home.lan", weight: 3 },
	{ ip: "192.168.1.71", name: "doorbell.home.lan", weight: 3 },
	{ ip: "192.168.1.72", name: "camera-garden.home.lan", weight: 3 },
	{ ip: "192.168.1.80", name: "nas.home.lan", weight: 3 },
	{ ip: "192.168.1.81", name: "printer.home.lan", weight: 1 },
	{ ip: "192.168.1.90", name: "hue-bridge.home.lan", weight: 2 },
	{ ip: "192.168.1.91", name: "sonos-living.home.lan", weight: 2 },
	{ ip: "192.168.1.92", name: "robot-vacuum.home.lan", weight: 1 },
	{ ip: "192.168.1.100", name: "kindle.home.lan", weight: 1 },
	{ ip: "192.168.1.101", name: "", weight: 1 },
	{ ip: "192.168.1.110", name: "guest-android.home.lan", weight: 2 },
];

const DOMAINS: [string, number][] = [
	["api.apple-cloudkit.com", 21],
	["netflix.com", 18],
	["www.google.com", 16],
	["graph.instagram.com", 14],
	["i.ytimg.com", 13],
	["gateway.icloud.com", 12],
	["api.spotify.com", 10],
	["time.apple.com", 9],
	["www.youtube.com", 9],
	["web.whatsapp.com", 8],
	["clients4.google.com", 7],
	["device-metrics-us.amazon.com", 6],
	["github.com", 5],
	["playstation.net", 5],
	["nas.home.lan", 4],
	["connectivitycheck.gstatic.com", 4],
];

const BLOCKED: [string, number][] = [
	["doubleclick.net", 22],
	["app-measurement.com", 17],
	["googleads.g.doubleclick.net", 14],
	["graph.facebook.com", 11],
	["firebaselogging-pa.googleapis.com", 9],
	["ads.samsungads.com", 8],
	["metrics.icloud.com", 7],
	["telemetry.sdk.inmobi.com", 5],
	["log.tiktokv.com", 4],
	["settings-win.data.microsoft.com", 3],
];

const pickWeighted = <T>(items: T[], weight: (t: T) => number, r: number) => {
	const total = items.reduce((s, t) => s + weight(t), 0);
	let x = r * total;
	for (const t of items) {
		x -= weight(t);
		if (x <= 0) return t;
	}
	return items[0] as T;
};

/** Deterministic noise, so a range shows the same week every reload. */
const noise = (i: number) => {
	const x = Math.sin(i * 12.9898) * 43758.5453;
	return x - Math.floor(x);
};

const STEP: Record<HomeDnsStatsRange, { points: number; ms: number }> = {
	hour: { points: 60, ms: 60_000 },
	day: { points: 24, ms: 3_600_000 },
	week: { points: 7 * 24, ms: 3_600_000 },
	month: { points: 30, ms: 86_400_000 },
	year: { points: 12, ms: 30 * 86_400_000 },
};

/** Queries per minute at a local hour: quiet at night, a dinner-time peak. */
const perMinute = (hour: number) =>
	40 +
	160 * Math.exp(-((hour - 21) ** 2) / 8) +
	70 * Math.exp(-((hour - 8) ** 2) / 4);

function stats(range: HomeDnsStatsRange): HomeDnsStats {
	const { points, ms } = STEP[range];
	const end = Math.floor(Date.now() / ms) * ms;
	const labels: string[] = [];
	const total: number[] = [];
	const blocked: number[] = [];
	const cached: number[] = [];
	for (let i = points - 1; i >= 0; i--) {
		const t = end - i * ms;
		const h = new Date(t).getHours();
		const minutes = ms / 60_000;
		const avg =
			ms >= 86_400_000
				? Array.from({ length: 24 }, (_, k) => perMinute(k)).reduce(
						(a, b) => a + b,
					) / 24
				: perMinute(h);
		const q = Math.round(avg * minutes * (0.85 + 0.3 * noise(t / ms)));
		labels.push(new Date(t).toISOString());
		total.push(q);
		blocked.push(Math.round(q * (0.17 + 0.06 * noise(t / ms + 7))));
		cached.push(Math.round(q * (0.48 + 0.08 * noise(t / ms + 3))));
	}
	const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
	const queries = sum(total);
	const b = sum(blocked);
	const c = sum(cached);
	const share = (list: [string, number][], of: number) => {
		const w = list.reduce((s, [, x]) => s + x, 0);
		return list.map(([name, x]) => ({
			name,
			hits: Math.round((of * x) / w / 2.4),
		}));
	};
	const cw = CLIENTS.reduce((s, x) => s + x.weight, 0);
	return {
		totals: {
			queries,
			noError: Math.round(queries * 0.93),
			serverFailure: Math.round(queries * 0.002),
			nxDomain: Math.round(queries * 0.05),
			refused: 0,
			authoritative: Math.round(queries * 0.03),
			recursive: queries - b - c,
			cached: c,
			blocked: b,
			dropped: 0,
			clients: CLIENTS.length,
		},
		chart: {
			labels,
			series: [
				{ label: "Total", data: total },
				{ label: "Cached", data: cached },
				{ label: "Blocked", data: blocked },
			],
		},
		topClients: CLIENTS.slice(0, 10).map((c) => ({
			name: c.ip,
			...(c.name ? { domain: c.name } : {}),
			hits: Math.round((queries * c.weight) / cw),
		})),
		topDomains: share(DOMAINS, queries - b).slice(0, 10),
		topBlocked: share(BLOCKED, b * 2.4).slice(0, 10),
	};
}

function logEntries(count: number) {
	const now = Date.now();
	return Array.from({ length: count }, (_, i) => {
		const r = noise(i + 1);
		const client = pickWeighted(CLIENTS, (c) => c.weight, noise(i + 101));
		const isBlocked = r < 0.18;
		const [domain] = isBlocked
			? pickWeighted(BLOCKED, (x) => x[1], noise(i + 202))
			: pickWeighted(DOMAINS, (x) => x[1], noise(i + 303));
		const local = domain.endsWith(".home.lan");
		const responseType = isBlocked
			? "Blocked"
			: local
				? "Authoritative"
				: r < 0.65
					? "Cached"
					: "Recursive";
		const type = noise(i + 404) < 0.22 ? "AAAA" : r > 0.97 ? "HTTPS" : "A";
		return {
			timestamp: new Date(now - i * 3_100 - 900 * noise(i)).toISOString(),
			client: client.ip,
			protocol: "Udp",
			responseType,
			rcode: "NoError",
			domain,
			type,
			answer: isBlocked
				? type === "AAAA"
					? "::"
					: "0.0.0.0"
				: local
					? "192.168.1.80"
					: type === "AAAA"
						? `2606:4700::${(i % 90) + 10}`
						: `104.18.${(i * 7) % 255}.${(i * 13) % 255}`,
			rttMs:
				responseType === "Recursive" ? Math.round(8 + 40 * noise(i + 5)) : null,
		};
	});
}

const LOG = logEntries(1_240);

type State = {
	dns: HomeDns;
	enabledAt: number;
	allowed: string[];
	blocked: string[];
	zones: HomeDnsZone[];
	records: Record<string, HomeDnsRecord[]>;
};

const rec = (
	name: string,
	type: HomeDnsRecord["type"],
	content: string,
	comment?: string,
): HomeDnsRecord => ({
	id: homeDnsRecordId({ name, type, content }),
	name,
	type,
	content,
	ttl: 3600,
	disabled: false,
	...(comment ? { comment } : {}),
});

const homeLan = () => [
	rec("nas.home.lan", "A", "192.168.1.80", "Synology DS923+"),
	rec("printer.home.lan", "A", "192.168.1.81"),
	rec("router.home.lan", "A", "192.168.1.1"),
	rec("photos.home.lan", "CNAME", "nas.home.lan"),
	rec("home.lan", "TXT", "v=spf1 -all"),
	rec("_ipp._tcp.home.lan", "SRV", "0 5 631 printer.home.lan"),
];

const ready = (): State => ({
	dns: {
		enabled: true,
		nodeId: "node_fra1",
		nodeHostname: "fra-1",
		lanAddress: "192.168.1.2",
		desiredState: "running",
		status: "ready",
		statusMessage: null,
		settings: HomeDnsSettings.parse({
			upstream: {
				servers: [
					"https://cloudflare-dns.com/dns-query (1.1.1.1)",
					"https://cloudflare-dns.com/dns-query (1.0.0.1)",
				],
				protocol: "Https",
			},
			blocking: { enabled: true, listUrls: [HAGEZI_PRO] },
			localZone: "home.lan",
		}),
		version: "15.6.2",
		updatedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
	},
	enabledAt: 0,
	allowed: ["s.youtube.com", "click.redditmail.com"],
	blocked: ["tiktok.com"],
	zones: [
		{ name: "home.lan", type: "Primary", disabled: false },
		{ name: "1.168.192.in-addr.arpa", type: "Primary", disabled: false },
	],
	records: {
		"home.lan": homeLan(),
		"1.168.192.in-addr.arpa": [
			rec("80.1.168.192.in-addr.arpa", "PTR", "nas.home.lan"),
			rec("1.1.168.192.in-addr.arpa", "PTR", "router.home.lan"),
		],
	},
});

let s: State | null = ready();

/** Seconds since the mock "worker" started: starting, configuring, ready with the log extension installing, ready. */
function tick(st: State) {
	if (!st.enabledAt || st.dns.desiredState !== "running") return;
	const t = (Date.now() - st.enabledAt) / 1000;
	st.dns.status = t < 4 ? "starting" : t < 9 ? "configuring" : "ready";
	st.dns.statusMessage =
		t < 4
			? "Pulling technitium/dns-server:15.6.2"
			: t < 9
				? "Applying upstream, block lists and the local zone"
				: t < 24
					? "Installing the query log extension..."
					: null;
	st.dns.version = t < 9 ? null : "15.6.2";
	if (t >= 24) st.enabledAt = 0;
}

function on(): State {
	if (!s)
		throw new ApiError(409, "home DNS is off; enable it first", "conflict");
	tick(s);
	return s;
}

function live(): State {
	const st = on();
	if (st.dns.status !== "ready")
		throw new ApiError(
			409,
			`home DNS is not ready (status ${st.dns.status}${st.dns.statusMessage ? `: ${st.dns.statusMessage}` : ""})`,
			"conflict",
		);
	return st;
}

const off: HomeDns = {
	enabled: false,
	nodeId: null,
	nodeHostname: null,
	lanAddress: null,
	desiredState: null,
	status: null,
	statusMessage: null,
	settings: null,
	version: null,
	updatedAt: null,
};

const BLOCKED_SET = new Set(BLOCKED.map(([d]) => d));

export const mockHomeDns: HomeDnsApi = {
	get: () => {
		if (s) tick(s);
		return delay(s?.dns ?? off);
	},
	enable: (input) => {
		if (s) throw new ApiError(409, "home DNS is already on", "conflict");
		const fresh = ready();
		fresh.dns = {
			...fresh.dns,
			nodeId: input.nodeId,
			nodeHostname: hostname(input.nodeId),
			lanAddress: input.lanAddress,
			settings: input.settings,
			status: "starting",
			version: null,
			updatedAt: new Date().toISOString(),
		};
		fresh.enabledAt = Date.now();
		fresh.zones = input.settings.localZone
			? [{ name: input.settings.localZone, type: "Primary", disabled: false }]
			: [];
		fresh.records = input.settings.localZone
			? { [input.settings.localZone]: [] }
			: {};
		fresh.allowed = [];
		fresh.blocked = [];
		s = fresh;
		return delay(s.dns, 500);
	},
	update: (input) => {
		const st = on();
		const moved =
			(input.nodeId && input.nodeId !== st.dns.nodeId) ||
			(input.lanAddress && input.lanAddress !== st.dns.lanAddress);
		st.dns = {
			...st.dns,
			...(input.nodeId
				? {
						nodeId: input.nodeId,
						nodeHostname: hostname(input.nodeId),
					}
				: {}),
			...(input.lanAddress ? { lanAddress: input.lanAddress } : {}),
			settings: {
				...(st.dns.settings ?? HomeDnsSettings.parse({})),
				...input.settings,
			},
			updatedAt: new Date().toISOString(),
		};
		if (input.desiredState === "stopped") {
			st.dns.desiredState = "stopped";
			st.dns.status = "stopped";
			st.dns.statusMessage = null;
			st.enabledAt = 0;
		} else if (input.desiredState === "running" || moved) {
			st.dns.desiredState = "running";
			st.enabledAt = Date.now();
			tick(st);
		}
		const zone = input.settings?.localZone;
		if (zone && !st.zones.some((z) => z.name === zone)) {
			st.zones.push({ name: zone, type: "Primary", disabled: false });
			st.records[zone] = [];
		}
		return delay(st.dns, 400);
	},
	disable: () => {
		on();
		s = null;
		return delay(undefined, 500);
	},
	test: (name) => {
		const st = live();
		const n = name.toLowerCase();
		const listed = (list: Iterable<string>) =>
			[...list].some((d) => n === d || n.endsWith(`.${d}`));
		const isBlocked =
			!listed(st.allowed) &&
			(listed(st.blocked) ||
				(st.dns.settings?.blocking.enabled === true && listed(BLOCKED_SET)));
		const local = Object.values(st.records)
			.flat()
			.filter((r) => r.name === n && (r.type === "A" || r.type === "CNAME"));
		return delay({
			name: n,
			blocked: isBlocked,
			rcode: "NoError",
			answers: isBlocked
				? [{ type: "A", data: "0.0.0.0" }]
				: local.length
					? local.map((r) => ({ type: r.type, data: r.content }))
					: [
							{ type: "A", data: "104.18.32.7" },
							{ type: "A", data: "172.64.155.249" },
						],
		});
	},
	console: () => {
		const st = on();
		return delay({
			url: `http://${st.dns.lanAddress}:5380/`,
			username: "admin",
			password: "q7Lk2vR9-mXe4TbN8wZp3HsC",
		});
	},
	stats: (range) => {
		live();
		return delay(stats(range));
	},
	logs: (q) => {
		const st = live();
		if (st.dns.statusMessage)
			throw new ApiError(
				409,
				"the query log extension is not installed yet; the worker is installing it",
				"conflict",
			);
		const page = q.page ?? 1;
		const perPage = q.perPage ?? 50;
		const start = q.start ? Date.parse(q.start) : -Infinity;
		const end = q.end ? Date.parse(q.end) : Infinity;
		const rows = LOG.filter(
			(e) =>
				(!q.client || e.client === q.client) &&
				(!q.domain || e.domain.includes(q.domain.toLowerCase())) &&
				(!q.responseType || e.responseType === q.responseType) &&
				Date.parse(e.timestamp) >= start &&
				Date.parse(e.timestamp) <= end,
		);
		const result: HomeDnsLogPage = {
			page,
			totalPages: Math.max(1, Math.ceil(rows.length / perPage)),
			totalEntries: rows.length,
			entries: rows.slice((page - 1) * perPage, page * perPage),
		};
		return delay(result);
	},
	setBlocking: (b) => {
		const st = on();
		if (st.dns.settings) st.dns.settings.blocking = b;
		return delay(b);
	},
	refreshLists: () => {
		live();
		return delay(undefined, 700);
	},
	list: (kind) => delay(live()[kind]),
	add: (kind, domain) => {
		const st = live();
		const other = kind === "allowed" ? "blocked" : "allowed";
		st[other] = st[other].filter((d) => d !== domain);
		if (!st[kind].includes(domain)) st[kind] = [...st[kind], domain].sort();
		return delay(undefined);
	},
	remove: (kind, domain) => {
		const st = live();
		st[kind] = st[kind].filter((d) => d !== domain);
		return delay(undefined);
	},
	zones: () => delay(live().zones),
	createZone: (name) => {
		const st = live();
		if (st.zones.some((z) => z.name === name))
			throw new ApiError(409, `Zone already exists: ${name}`, "conflict");
		const zone = { name, type: "Primary", disabled: false };
		st.zones.push(zone);
		st.records[name] = [];
		return delay(zone);
	},
	deleteZone: (name) => {
		const st = live();
		if (st.dns.settings?.localZone === name)
			throw new ApiError(
				409,
				`${name} is the local zone in the home DNS settings; clear it there first`,
				"conflict",
			);
		st.zones = st.zones.filter((z) => z.name !== name);
		delete st.records[name];
		return delay(undefined);
	},
	records: (zone) => {
		const list = live().records[zone];
		if (!list) throw new ApiError(409, `No such zone: ${zone}`, "conflict");
		return delay(list);
	},
	addRecord: (zone, r) => {
		const st = live();
		const list = st.records[zone] ?? [];
		if (
			list.some(
				(x) =>
					x.name === r.name && x.type === r.type && x.content === r.content,
			)
		)
			throw new ApiError(409, "That record already exists", "conflict");
		st.records[zone] = [...list, rec(r.name, r.type, r.content, r.comment)].map(
			(x) =>
				x.name === r.name && x.content === r.content ? { ...x, ttl: r.ttl } : x,
		);
		return delay(undefined);
	},
	updateRecord: (zone, id, r) => {
		const st = live();
		st.records[zone] = (st.records[zone] ?? []).map((x) =>
			x.id === id
				? { ...rec(r.name, r.type, r.content, r.comment), ttl: r.ttl }
				: x,
		);
		return delay(undefined);
	},
	deleteRecord: (zone, id) => {
		const st = live();
		st.records[zone] = (st.records[zone] ?? []).filter((x) => x.id !== id);
		return delay(undefined);
	},
};
