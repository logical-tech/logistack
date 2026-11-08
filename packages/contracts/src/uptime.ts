import { z } from "zod";

// Uptime monitors, incidents, maintenance windows and public status pages.
// Design and sources of the ideas: docs/plans/uptime-status.md.

export const monitorKinds = ["http", "tcp", "dns", "tls", "push"] as const;
export const MonitorKind = z.enum(monitorKinds);
export type MonitorKind = z.infer<typeof MonitorKind>;

/** `pending` until confirmed either way; `paused` while disabled. */
export const monitorStatuses = [
	"pending",
	"up",
	"down",
	"maintenance",
	"paused",
] as const;
export const MonitorStatus = z.enum(monitorStatuses);
export type MonitorStatus = z.infer<typeof MonitorStatus>;

const Hostname = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(253)
	.regex(/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/, "not a hostname or IP address");
const Port = z.int().min(1).max(65_535);
const HeaderName = z
	.string()
	.regex(/^[A-Za-z0-9-]{1,64}$/, "not a header name");

/** `200`, `200-299`, `3xx`; the default accepts 2xx. */
export const StatusCodePattern = z
	.string()
	.trim()
	.regex(/^([1-5]xx|[1-5]\d\d(-[1-5]\d\d)?)$/, "use 200, 200-299 or 2xx");

export const HttpConfig = z.object({
	url: z
		.url({ protocol: /^https?$/ })
		.max(2_048)
		.describe("http or https URL; the host must resolve to a public address"),
	method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
	headers: z
		.array(z.object({ name: HeaderName, value: z.string().max(4_096) }))
		.max(20)
		.default([]),
	body: z.string().max(16_384).optional(),
	/** Any match passes. */
	statusCodes: z.array(StatusCodePattern).min(1).max(10).default(["2xx"]),
	keyword: z
		.object({
			value: z.string().min(1).max(512),
			/** true: fails when the body contains the keyword. */
			invert: z.boolean().default(false),
			caseSensitive: z.boolean().default(false),
		})
		.optional(),
	/** `$.status`, `data.items[0].ok`; the value at the path, as text, must equal `equals`. */
	jsonPath: z
		.object({
			path: z.string().min(1).max(256),
			equals: z.string().max(512),
		})
		.optional(),
	/** A slower answer counts as a failure. */
	maxLatencyMs: z.int().min(1).max(60_000).optional(),
	followRedirects: z.boolean().default(true),
});
export type HttpConfig = z.infer<typeof HttpConfig>;

export const TcpConfig = z.object({ host: Hostname, port: Port });
export type TcpConfig = z.infer<typeof TcpConfig>;

export const monitorDnsRecordTypes = [
	"A",
	"AAAA",
	"CNAME",
	"MX",
	"TXT",
	"NS",
] as const;
export const DnsConfig = z.object({
	hostname: Hostname,
	recordType: z.enum(monitorDnsRecordTypes),
	/** A public resolver IP; the system resolver when unset. */
	resolver: z.ipv4().or(z.ipv6()).optional(),
	/** Passes only when some answer contains this text. */
	expected: z.string().max(512).optional(),
});
export type DnsConfig = z.infer<typeof DnsConfig>;

export const TlsConfig = z.object({
	host: Hostname,
	port: Port.default(443),
	/** Days before expiry that each send one `certificate.expiring`. */
	warnDays: z
		.array(z.int().min(1).max(365))
		.min(1)
		.max(5)
		.default([30, 14, 7, 1]),
});
export type TlsConfig = z.infer<typeof TlsConfig>;

/** A job pings `/api/push/<token>`; silence for longer than `graceSec` past the interval is a failure. */
export const PushConfig = z.object({
	graceSec: z.int().min(0).max(86_400).default(60),
});
export type PushConfig = z.infer<typeof PushConfig>;

export const MonitorConfig = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("http"), http: HttpConfig }),
	z.object({ kind: z.literal("tcp"), tcp: TcpConfig }),
	z.object({ kind: z.literal("dns"), dns: DnsConfig }),
	z.object({ kind: z.literal("tls"), tls: TlsConfig }),
	z.object({ kind: z.literal("push"), push: PushConfig }),
]);
export type MonitorConfig = z.infer<typeof MonitorConfig>;

/** Timing and confirmation shared by every kind. */
export const MonitorTiming = z.object({
	intervalSec: z.int().min(20).max(86_400).default(60),
	/** Between checks while a failure is being confirmed. */
	retryIntervalSec: z.int().min(5).max(3_600).default(20),
	timeoutMs: z.int().min(1_000).max(60_000).default(10_000),
	/** Consecutive failures before `down`. */
	downAfter: z.int().min(1).max(10).default(3),
	/** Consecutive successes before `up` again. */
	upAfter: z.int().min(1).max(10).default(1),
	/** Repeat `monitor.down` every N minutes while still down; 0 never. */
	resendMinutes: z.int().min(0).max(10_080).default(0),
});
export type MonitorTiming = z.infer<typeof MonitorTiming>;

export const incidentStatuses = [
	"investigating",
	"identified",
	"monitoring",
	"resolved",
] as const;
export const IncidentStatus = z.enum(incidentStatuses);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

export const incidentImpacts = ["minor", "major", "critical"] as const;
export const IncidentImpact = z.enum(incidentImpacts);
export type IncidentImpact = z.infer<typeof IncidentImpact>;

export const maintenanceRepeats = ["none", "daily", "weekly"] as const;
export const MaintenanceRepeat = z.enum(maintenanceRepeats);
export type MaintenanceRepeat = z.infer<typeof MaintenanceRepeat>;

export const StatusPageSection = z.object({
	name: z.string().trim().max(80),
	monitors: z
		.array(
			z.object({
				monitorId: z.string().min(1).max(64),
				/** Public name; the monitor's own name when unset (it may reveal internals). */
				label: z.string().trim().max(80).optional(),
			}),
		)
		.max(100),
});
export type StatusPageSection = z.infer<typeof StatusPageSection>;

export const StatusPageTheme = z.object({
	/** `#rrggbb` */
	accent: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.default("#2563eb"),
	appearance: z.enum(["auto", "light", "dark"]).default("auto"),
	/** https URL of a logo image. */
	logoUrl: z
		.url({ protocol: /^https$/ })
		.max(2_048)
		.optional(),
	/** Shown in the footer as a link. */
	websiteUrl: z
		.url({ protocol: /^https?$/ })
		.max(2_048)
		.optional(),
});
export type StatusPageTheme = z.infer<typeof StatusPageTheme>;

/** One day of a 90-day bar. `none`: no checks that day. */
export const DayStatus = z.enum([
	"up",
	"degraded",
	"down",
	"maintenance",
	"none",
]);
export type DayStatus = z.infer<typeof DayStatus>;

export const UptimeDay = z.object({
	day: z.string(),
	/** Percent of checks that passed, maintenance excluded; null without checks. */
	uptime: z.number().nullable(),
	status: DayStatus,
});
export type UptimeDay = z.infer<typeof UptimeDay>;

export type MonitorEventPayload = {
	monitorId: string;
	name: string;
	kind: MonitorKind;
	target: string;
	state: "firing" | "resolved";
	error?: string;
	projectId?: string;
	serviceId?: string;
	url?: string;
};
