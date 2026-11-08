import type {
	Incident,
	MaintenanceWindow,
	Monitor,
	MonitorDetail,
	StatusPage,
	Suggestion,
	UptimeDay,
} from "../uptime";

// Deterministic fixtures for VITE_API_MOCK=1: the same page every load, so screenshots are stable.

const NOW = Date.parse("2026-11-08T10:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

/** A small LCG so "random" latencies repeat. */
function rng(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
		return s / 2_147_483_648;
	};
}

function recent(seed: number, base: number, failFrom?: number) {
	const r = rng(seed);
	return Array.from({ length: 40 }, (_, i) => {
		const ok = failFrom === undefined || i < failFrom;
		return {
			at: iso((40 - i) * MIN),
			ok,
			latencyMs: ok ? Math.round(base + r() * base * 0.6) : null,
		};
	});
}

const timing = {
	intervalSec: 60,
	retryIntervalSec: 20,
	timeoutMs: 10_000,
	downAfter: 3,
	upAfter: 1,
	resendMinutes: 0,
	autoIncident: true,
	enabled: true,
};

const http = (url: string) => ({
	kind: "http" as const,
	http: {
		url,
		method: "GET" as const,
		headers: [],
		statusCodes: ["2xx"],
		followRedirects: true,
	},
});

export const monitors: Monitor[] = [
	{
		id: "mon_web",
		name: "Storefront",
		kind: "http",
		config: http("https://shop.acme.dev/"),
		projectId: "prj_shop",
		serviceId: "svc_web",
		domainId: "dom_shop",
		...timing,
		status: "up",
		statusChangedAt: iso(12 * DAY),
		lastCheckAt: iso(MIN / 2),
		lastPingAt: null,
		lastLatencyMs: 118,
		lastError: null,
		certExpiresAt: null,
		uptime24h: 100,
		uptime30d: 99.97,
		recent: recent(1, 110),
		createdAt: iso(60 * DAY),
	},
	{
		id: "mon_api",
		name: "Public API",
		kind: "http",
		config: {
			kind: "http",
			http: {
				...http("https://api.acme.dev/health").http,
				jsonPath: { path: "$.status", equals: "ok" },
				maxLatencyMs: 800,
			},
		},
		projectId: "prj_shop",
		serviceId: "svc_api",
		domainId: "dom_api",
		...timing,
		status: "down",
		statusChangedAt: iso(6 * MIN),
		lastCheckAt: iso(MIN / 3),
		lastPingAt: null,
		lastLatencyMs: 64,
		lastError: "HTTP 502, expected 2xx",
		certExpiresAt: null,
		uptime24h: 98.6,
		uptime30d: 99.81,
		recent: recent(2, 60, 33),
		createdAt: iso(45 * DAY),
	},
	{
		id: "mon_cert",
		name: "acme.dev certificate",
		kind: "tls",
		config: {
			kind: "tls",
			tls: { host: "acme.dev", port: 443, warnDays: [30, 14, 7, 1] },
		},
		projectId: null,
		serviceId: null,
		domainId: null,
		...timing,
		intervalSec: 3_600,
		status: "up",
		statusChangedAt: iso(30 * DAY),
		lastCheckAt: iso(20 * MIN),
		lastPingAt: null,
		lastLatencyMs: 41,
		lastError: null,
		certExpiresAt: iso(-12 * DAY),
		uptime24h: 100,
		uptime30d: 100,
		recent: recent(3, 40),
		createdAt: iso(90 * DAY),
	},
	{
		id: "mon_backup",
		name: "Nightly export",
		kind: "push",
		config: { kind: "push", push: { graceSec: 300 } },
		projectId: "prj_shop",
		serviceId: null,
		domainId: null,
		...timing,
		intervalSec: 86_400,
		downAfter: 1,
		status: "up",
		statusChangedAt: iso(9 * DAY),
		lastCheckAt: iso(7 * 3_600_000),
		lastPingAt: iso(7 * 3_600_000),
		lastLatencyMs: null,
		lastError: null,
		certExpiresAt: null,
		uptime24h: 100,
		uptime30d: 96.67,
		recent: [],
		createdAt: iso(20 * DAY),
	},
	{
		id: "mon_db",
		name: "Postgres replica",
		kind: "tcp",
		config: { kind: "tcp", tcp: { host: "db.acme.dev", port: 5432 } },
		projectId: null,
		serviceId: null,
		domainId: null,
		...timing,
		enabled: false,
		status: "paused",
		statusChangedAt: iso(2 * DAY),
		lastCheckAt: iso(2 * DAY),
		lastPingAt: null,
		lastLatencyMs: 9,
		lastError: null,
		certExpiresAt: null,
		uptime24h: null,
		uptime30d: 99.99,
		recent: [],
		createdAt: iso(70 * DAY),
	},
];

function bars(seed: number): UptimeDay[] {
	const r = rng(seed);
	return Array.from({ length: 90 }, (_, i) => {
		const day = new Date(NOW - (89 - i) * DAY).toISOString().slice(0, 10);
		const x = r();
		if (seed === 2 && i === 89)
			return { day, uptime: 98.6, status: "degraded" };
		if (x > 0.985) return { day, uptime: 96.2, status: "down" };
		if (x > 0.96) return { day, uptime: 99.4, status: "degraded" };
		if (i === 61) return { day, uptime: null, status: "maintenance" };
		return { day, uptime: 100, status: "up" };
	});
}

export function monitorDetail(id: string): MonitorDetail {
	const i = Math.max(
		0,
		monitors.findIndex((m) => m.id === id),
	);
	const m = monitors[i] as Monitor;
	const r = rng(i + 7);
	return {
		...m,
		bars: bars(i + 1),
		latency: Array.from({ length: 7 * 24 }, (_, h) => {
			const avg = Math.round((m.lastLatencyMs ?? 50) * (0.8 + r() * 0.5));
			return {
				hour: new Date(NOW - (7 * 24 - h) * 3_600_000).toISOString(),
				avgMs: avg,
				maxMs: Math.round(avg * (1.4 + r())),
				checks: 60,
				failures: 0,
			};
		}),
		checks: m.recent
			.slice()
			.reverse()
			.map((c) => ({
				...c,
				maintenance: false,
				error: c.ok ? null : (m.lastError ?? "failed"),
				region: "worker",
			})),
	};
}

export const suggestions: Suggestion[] = [
	{
		domainId: "dom_docs",
		hostname: "docs.acme.dev",
		url: "https://docs.acme.dev/",
		serviceId: "svc_docs",
		serviceName: "docs",
		projectId: "prj_shop",
		projectName: "Shop",
	},
	{
		domainId: "dom_admin",
		hostname: "admin.acme.dev",
		url: "https://admin.acme.dev/",
		serviceId: "svc_admin",
		serviceName: "admin",
		projectId: "prj_shop",
		projectName: "Shop",
	},
];

export const incidents: Incident[] = [
	{
		id: "inc_api",
		title: "Public API is down",
		status: "identified",
		impact: "major",
		monitorIds: ["mon_api"],
		openedByMonitorId: "mon_api",
		startedAt: iso(6 * MIN),
		resolvedAt: null,
		updates: [
			{
				id: "inu_2",
				status: "identified",
				message:
					"A bad migration left the API without its connection pool. Rolling back now.",
				createdAt: iso(3 * MIN),
			},
			{
				id: "inu_1",
				status: "investigating",
				message: "Automatic check failed: HTTP 502, expected 2xx.",
				createdAt: iso(6 * MIN),
			},
		],
	},
	{
		id: "inc_old",
		title: "Slow checkout",
		status: "resolved",
		impact: "minor",
		monitorIds: ["mon_web"],
		openedByMonitorId: null,
		startedAt: iso(11 * DAY),
		resolvedAt: iso(11 * DAY - 42 * MIN),
		updates: [
			{
				id: "inu_4",
				status: "resolved",
				message: "The payment provider's latency is back to normal.",
				createdAt: iso(11 * DAY - 42 * MIN),
			},
			{
				id: "inu_3",
				status: "investigating",
				message: "Checkout takes up to 8 seconds for some customers.",
				createdAt: iso(11 * DAY),
			},
		],
	},
];

export const windows: MaintenanceWindow[] = [
	{
		id: "mtw_db",
		title: "Database upgrade",
		description: "Postgres 17 to 18. Writes pause for about ten minutes.",
		monitorIds: ["mon_api", "mon_web"],
		startsAt: iso(-2 * DAY),
		endsAt: iso(-2 * DAY - 30 * MIN),
		repeat: "none",
		active: false,
	},
	{
		id: "mtw_weekly",
		title: "Weekly patch window",
		description: "",
		monitorIds: ["mon_db"],
		startsAt: iso(5 * DAY),
		endsAt: iso(5 * DAY - 60 * MIN),
		repeat: "weekly",
		active: false,
	},
];

export const pages: StatusPage[] = [
	{
		id: "stp_acme",
		title: "Acme",
		slug: "acme",
		description: "Live status of the Acme shop and API.",
		projectId: "prj_shop",
		hostname: "status.acme.dev",
		sections: [
			{
				name: "Shop",
				monitors: [
					{ monitorId: "mon_web", label: "Storefront" },
					{ monitorId: "mon_api", label: "API" },
				],
			},
		],
		theme: { accent: "#2563eb", appearance: "auto" },
		historyDays: 90,
		published: true,
		createdAt: iso(40 * DAY),
	},
];
