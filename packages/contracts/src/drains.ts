import { z } from "zod";

// Log drains: org-level destinations for container logs, enabled per project or service. The
// server pushes `drains.config` (every drain and the services routed to them) to agents with the
// `log-drains` capability; each agent tails its own node's containers and ships batches straight
// to the destination. Agents report `drains.status` per drain; a drain that is down only shows up
// there and never slows a container: the agent drops the oldest lines once its buffer is full.

export const logDrainKinds = [
	"loki",
	"otlp",
	"http",
	"datadog",
	"syslog",
] as const;
export const LogDrainKind = z.enum(logDrainKinds);
export type LogDrainKind = z.infer<typeof LogDrainKind>;

const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);
const Headers = z
	.record(
		z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "not a header name"),
		z.string().max(4096),
	)
	.default({});

export const datadogSites = [
	"datadoghq.com",
	"us3.datadoghq.com",
	"us5.datadoghq.com",
	"datadoghq.eu",
	"ap1.datadoghq.com",
	"ddog-gov.com",
] as const;

/** Credentials are part of the config; the server keeps it encrypted and never returns it. */
export const LogDrainConfig = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("loki"),
		/** Base URL (`https://loki:3100`) or the full push URL. */
		url: HttpUrl,
		tenantId: z.string().max(256).optional(),
		username: z.string().max(256).optional(),
		password: z.string().max(4096).optional(),
		bearerToken: z.string().max(4096).optional(),
	}),
	z.object({
		kind: z.literal("otlp"),
		/** Collector base URL (`https://otel:4318`) or the full `/v1/logs` URL. */
		url: HttpUrl,
		headers: Headers,
	}),
	z.object({
		kind: z.literal("http"),
		/** Receives a JSON array of log records per batch. */
		url: HttpUrl,
		headers: Headers,
	}),
	z.object({
		kind: z.literal("datadog"),
		site: z.enum(datadogSites).default("datadoghq.com"),
		apiKey: z.string().min(1).max(256),
	}),
	z.object({
		kind: z.literal("syslog"),
		host: z
			.string()
			.min(1)
			.max(253)
			.regex(/^[A-Za-z0-9.:\-[\]]+$/, "not a host name or address"),
		port: z.number().int().min(1).max(65535).default(514),
		/** RFC 5424; TCP and TLS use octet-counting framing (RFC 6587). */
		protocol: z.enum(["tcp", "tls", "udp"]).default("tcp"),
	}),
]);
export type LogDrainConfig = z.infer<typeof LogDrainConfig>;
export type LogDrainConfigInput = z.input<typeof LogDrainConfig>;

/** Where a line came from; ids are stable, names are for humans. */
export const LogMeta = z.object({
	organizationId: z.string(),
	organization: z.string(),
	projectId: z.string(),
	project: z.string(),
	environmentId: z.string(),
	environment: z.string(),
	serviceId: z.string(),
	service: z.string(),
});
export type LogMeta = z.infer<typeof LogMeta>;

/** One log line ready to encode: `meta` plus what only the agent knows. */
export type LogRecord = {
	/** Unix milliseconds. */
	at: number;
	/** Nanoseconds within `at`'s millisecond, so ordering survives Loki's per-stream checks. */
	nanos?: number;
	stream: "stdout" | "stderr";
	line: string;
	meta: LogMeta;
	deploymentId: string;
	node: string;
};

export const DrainsConfig = z.object({
	drains: z
		.array(z.object({ id: z.string(), config: LogDrainConfig }))
		.max(500),
	/** By service id (`logistack.resource`); a service missing here is not shipped. */
	routes: z.record(
		z.string(),
		z.object({ meta: LogMeta, drainIds: z.array(z.string()).min(1) }),
	),
});
export type DrainsConfig = z.infer<typeof DrainsConfig>;

export const DrainNodeStatus = z.object({
	drainId: z.string(),
	/** `ok` after a delivered batch, `failing` after a failed one, `idle` before the first batch. */
	state: z.enum(["idle", "ok", "failing"]),
	lastSuccessAt: z.number().nullable(),
	lastFailureAt: z.number().nullable(),
	lastError: z.string().max(1024).nullable(),
	/** Counters since the agent started. */
	sentLines: z.number().int().nonnegative(),
	droppedLines: z.number().int().nonnegative(),
	queuedLines: z.number().int().nonnegative(),
	queuedBytes: z.number().int().nonnegative(),
});
export type DrainNodeStatus = z.infer<typeof DrainNodeStatus>;

export const drainHealths = [
	"unknown",
	"healthy",
	"degraded",
	"failing",
] as const;
export const DrainHealth = z.enum(drainHealths);
export type DrainHealth = z.infer<typeof DrainHealth>;

/** Fresh reports only; a node that went quiet stops counting after this. */
export const DRAIN_STATUS_TTL_SEC = 180;

/** Healthy when every reporting node delivered last, failing when none did, degraded in between. */
export function drainHealth(
	nodes: Pick<DrainNodeStatus, "state">[],
): DrainHealth {
	const active = nodes.filter((n) => n.state !== "idle");
	if (active.length === 0) return "unknown";
	const failing = active.filter((n) => n.state === "failing").length;
	if (failing === 0) return "healthy";
	return failing === active.length ? "failing" : "degraded";
}
