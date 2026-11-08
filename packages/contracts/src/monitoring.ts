import { z } from "zod";
import { PruneReport, PruneTarget, pruneTargets } from "./agent.ts";
import { AiAgentMessage, AiAgentStatus } from "./ai-agent.ts";
import { NodeRole, NodeStatus } from "./enums.ts";
import { UpdateState, UpdateSteps } from "./updates.ts";

/** Redis stream the agent gateway appends `metrics` messages to; the worker consumes it. */
export const METRICS_STREAM = "ls:metrics";
/** Redis pub/sub channel carrying `LiveMessage`s from the worker to the server's /ws. */
export const LIVE_CHANNEL = "ls:live";
/** Redis pub/sub channel the server pokes when a node operation is queued in Postgres. */
export const NODE_OPS_CHANNEL = "ls:node-ops";

export const metricRanges = ["1h", "6h", "24h", "7d", "30d"] as const;
export const MetricRange = z.enum(metricRanges);
export type MetricRange = z.infer<typeof MetricRange>;

export const RANGE_SECONDS: Record<MetricRange, number> = {
	"1h": 3_600,
	"6h": 6 * 3_600,
	"24h": 24 * 3_600,
	"7d": 7 * 86_400,
	"30d": 30 * 86_400,
};

/** Where a series was read from: raw 10s samples, or the 1m / 1h rollups. */
export const metricSources = ["raw", "1m", "1h"] as const;
export const MetricSource = z.enum(metricSources);
export type MetricSource = z.infer<typeof MetricSource>;

const Num = z.number().nullable();

/** One bucket. Bytes are absolute; `rx`/`tx` are bytes per second. Cluster points sum bytes and average CPU. */
export const HostPoint = z.object({
	t: z.number(),
	cpu: Num,
	load1: Num,
	memUsed: Num,
	memTotal: Num,
	diskUsed: Num,
	diskTotal: Num,
	rx: Num,
	tx: Num,
	/** Bytes per second over whole disks; null from agents that predate it. */
	diskRead: Num.optional(),
	diskWrite: Num.optional(),
	/** Hottest sensor, °C; null on hosts without sensors. */
	temp: Num.optional(),
	/** 0..100 of CPU time waiting on I/O, and taken by the hypervisor. */
	iowait: Num.optional(),
	steal: Num.optional(),
});
export type HostPoint = z.infer<typeof HostPoint>;

export const HostSeries = z.object({
	/** `null` for the cluster aggregate. */
	nodeId: z.string().nullable(),
	points: z.array(HostPoint),
});
export type HostSeries = z.infer<typeof HostSeries>;

const Window = {
	range: MetricRange,
	source: MetricSource,
	stepSec: z.number().int().positive(),
	from: z.number(),
	to: z.number(),
};

export const HostMetricsResponse = z.object({
	...Window,
	series: z.array(HostSeries),
});
export type HostMetricsResponse = z.infer<typeof HostMetricsResponse>;

/** `cpu` follows Docker: 100 per fully used core. */
export const ContainerPoint = z.object({
	t: z.number(),
	cpu: Num,
	memUsed: Num,
	memLimit: Num,
	rx: Num,
	tx: Num,
	read: Num,
	write: Num,
	/** Containers that reported in the bucket. */
	containers: z.number().int(),
});
export type ContainerPoint = z.infer<typeof ContainerPoint>;

export const ContainerMetricsResponse = z.object({
	...Window,
	points: z.array(ContainerPoint),
});
export type ContainerMetricsResponse = z.infer<typeof ContainerMetricsResponse>;

export const usageRanges = ["24h", "7d"] as const;
export const UsageRange = z.enum(usageRanges);
export type UsageRange = z.infer<typeof UsageRange>;

/**
 * Consumption over the window. `cpu` is average cores and `memUsed` average bytes, both over the
 * whole window (a service that ran half of it counts half); `rx`/`tx` are bytes transferred.
 * `disk` is the current size of the volumes, null when no node reported it.
 */
export const UsageFigures = z.object({
	cpu: z.number(),
	memUsed: z.number(),
	rx: z.number(),
	tx: z.number(),
	disk: Num,
});
export type UsageFigures = z.infer<typeof UsageFigures>;

/** One bucket of the summed scope: `cpu` in cores, `memUsed` in bytes, `rx`/`tx` in bytes per second. */
export const UsagePoint = z.object({
	t: z.number(),
	cpu: z.number(),
	memUsed: z.number(),
	rx: z.number(),
	tx: z.number(),
});
export type UsagePoint = z.infer<typeof UsagePoint>;

const UsageWindow = {
	range: UsageRange,
	stepSec: z.number().int().positive(),
	from: z.number(),
	to: z.number(),
	totals: UsageFigures,
	trend: z.array(UsagePoint),
};

const Named = { id: z.string(), name: z.string() };

export const EnvironmentUsage = UsageFigures.extend({
	...Named,
	services: z.array(UsageFigures.extend(Named)),
});
export type EnvironmentUsage = z.infer<typeof EnvironmentUsage>;

export const ProjectUsage = z.object({
	...UsageWindow,
	environments: z.array(EnvironmentUsage),
});
export type ProjectUsage = z.infer<typeof ProjectUsage>;

export const OrganizationUsage = z.object({
	...UsageWindow,
	/** Every node's cores, memory and disk; null unless the actor can read the organization. */
	capacity: z
		.object({ cpus: z.number(), memory: z.number(), disk: z.number() })
		.nullable(),
	/** Only the projects the actor can read; `totals` and `trend` cover the same set. */
	projects: z.array(UsageFigures.extend(Named)),
});
export type OrganizationUsage = z.infer<typeof OrganizationUsage>;

/** Desired Swarm availability; `remove` drains, leaves and deletes the node. */
export const nodeDesiredStates = ["active", "drain", "remove"] as const;
export const NodeDesired = z.enum(nodeDesiredStates);
export type NodeDesired = z.infer<typeof NodeDesired>;

/** Latest host sample, pushed live on `org:<id>:metrics` and embedded in node views. */
export const LiveHostSample = z.object({
	nodeId: z.string(),
	at: z.number(),
	cpu: z.number(),
	load1: z.number(),
	memUsed: z.number(),
	memTotal: z.number(),
	diskUsed: z.number(),
	diskTotal: z.number(),
	containers: z.number().int(),
});
export type LiveHostSample = z.infer<typeof LiveHostSample>;

export const NodeLabels = z.record(
	z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "letters, digits, . _ / -"),
	z.string().max(256),
);

export const NodeView = z.object({
	id: z.string(),
	swarmNodeId: z.string(),
	hostname: z.string(),
	address: z.string(),
	role: NodeRole,
	labels: z.record(z.string(), z.string()),
	desired: NodeDesired,
	status: NodeStatus,
	agentVersion: z.string().nullable(),
	lastSeenAt: z.coerce.date().nullable(),
	/** From the latest Swarm inspect, when known. */
	cpus: z.number().nullable(),
	memoryBytes: z.number().nullable(),
	engineVersion: z.string().nullable(),
	leader: z.boolean(),
	live: LiveHostSample.nullable(),
	createdAt: z.coerce.date(),
});
export type NodeView = z.infer<typeof NodeView>;

export const NodeUpdate = z
	.object({
		labels: NodeLabels.optional(),
		desired: z.enum(["active", "drain"]).optional(),
	})
	.refine((v) => v.labels || v.desired, "nothing to update");
export type NodeUpdate = z.infer<typeof NodeUpdate>;

export const thresholdMetrics = ["cpu", "memory", "disk"] as const;
export const ThresholdMetric = z.enum(thresholdMetrics);
export type ThresholdMetric = z.infer<typeof ThresholdMetric>;

export const ThresholdInput = z.object({
	metric: ThresholdMetric,
	/** `null` applies to every node. */
	nodeId: z.string().nullable(),
	percent: z.number().min(1).max(100),
	/** The average over this window must exceed `percent`. */
	forSec: z.int().min(60).max(86_400),
	enabled: z.boolean(),
});
export type ThresholdInput = z.infer<typeof ThresholdInput>;

export const Threshold = ThresholdInput.extend({ id: z.string() });
export type Threshold = z.infer<typeof Threshold>;

export const Retention = z.object({
	rawHours: z.int().min(1).max(168),
	minuteDays: z.int().min(1).max(90),
	hourDays: z.int().min(1).max(3_650),
});
export type Retention = z.infer<typeof Retention>;

export const DEFAULT_RETENTION: Retention = {
	rawHours: 24,
	minuteDays: 7,
	hourDays: 90,
};

/** Instance-wide scheduled prune of every connected node. */
export const Cleanup = z.object({
	enabled: z.boolean(),
	/** Five-field cron. */
	cron: z.string(),
	timezone: z.string(),
	targets: z.array(PruneTarget),
	/** Keep anything newer, so a rollback right after a deploy still finds its image. */
	untilHours: z.int().min(0).max(8_760),
});
export type Cleanup = z.infer<typeof Cleanup>;

export const DEFAULT_CLEANUP: Cleanup = {
	enabled: true,
	cron: "0 3 * * *",
	timezone: "UTC",
	targets: [...pruneTargets],
	untilHours: 24,
};

export const CleanupRun = z.object({
	at: z.number(),
	nodes: z.array(
		z.object({
			nodeId: z.string(),
			hostname: z.string(),
			reclaimedBytes: z.number().nonnegative(),
			report: PruneReport,
			error: z.string().nullable(),
		}),
	),
});
export type CleanupRun = z.infer<typeof CleanupRun>;

/**
 * `cpu` is a percent of one core, `memoryPercent` a percent of the container's memory limit
 * (of the node's memory when the service sets none), `memoryMb` absolute mebibytes. Each is
 * read per replica and the worst replica counts.
 */
export const serviceThresholdMetrics = [
	"cpu",
	"memoryPercent",
	"memoryMb",
] as const;
export const ServiceThresholdMetric = z.enum(serviceThresholdMetrics);
export type ServiceThresholdMetric = z.infer<typeof ServiceThresholdMetric>;

/** A `memoryPercent` threshold above 100 is rejected by the server. */
export const ServiceThresholdInput = z.object({
	serviceId: z.string(),
	metric: ServiceThresholdMetric,
	/** Fires when the window average is above this, in the metric's unit. */
	above: z.number().positive().max(1_000_000),
	forSec: z.int().min(60).max(86_400),
	enabled: z.boolean(),
});
export type ServiceThresholdInput = z.infer<typeof ServiceThresholdInput>;

export const ServiceThreshold = ServiceThresholdInput.extend({
	id: z.string(),
	/** null until first evaluated. */
	firing: z.boolean().nullable(),
	serviceName: z.string(),
	projectId: z.string(),
});
export type ServiceThreshold = z.infer<typeof ServiceThreshold>;

export const MonitoringSettings = z.object({
	retention: Retention,
	thresholds: z.array(Threshold),
	serviceThresholds: z.array(ServiceThreshold),
	cleanup: Cleanup,
	lastCleanup: CleanupRun.nullable(),
});
export type MonitoringSettings = z.infer<typeof MonitoringSettings>;

export const MonitoringSettingsInput = z.object({
	retention: Retention,
	thresholds: z.array(ThresholdInput.extend({ id: z.string().optional() })),
	/** The organization's complete per-service set; omitted keeps it. */
	serviceThresholds: z
		.array(ServiceThresholdInput.extend({ id: z.string().optional() }))
		.optional(),
	/** Omitted keeps the current schedule. */
	cleanup: Cleanup.optional(),
});
export type MonitoringSettingsInput = z.infer<typeof MonitoringSettingsInput>;

/** Payload of the `metric.threshold` event. */
export const ThresholdEventPayload = z.object({
	thresholdId: z.string(),
	nodeId: z.string(),
	hostname: z.string(),
	metric: ThresholdMetric,
	state: z.enum(["firing", "resolved"]),
	/** Window average that crossed (or fell back under) the limit. */
	value: z.number(),
	percent: z.number(),
	forSec: z.number(),
});
export type ThresholdEventPayload = z.infer<typeof ThresholdEventPayload>;

/** Payload of the `service.threshold` event. */
export const ServiceThresholdEventPayload = z.object({
	thresholdId: z.string(),
	serviceId: z.string(),
	service: z.string(),
	metric: ServiceThresholdMetric,
	state: z.enum(["firing", "resolved"]),
	value: z.number(),
	above: z.number(),
	forSec: z.number(),
});
export type ServiceThresholdEventPayload = z.infer<
	typeof ServiceThresholdEventPayload
>;

/** A service whose tasks keep failing, as the reconciler last saw it. */
export const CrashLoop = z.object({
	/** ISO time the loop was first detected. */
	since: z.string(),
	/** Failed tasks inside the detection window. */
	failures: z.int(),
	/** The newest failed task's error, e.g. `task: non-zero exit (1)`. */
	reason: z.string(),
	exitCode: z.int().nullable(),
});
export type CrashLoop = z.infer<typeof CrashLoop>;

// ---- Adding a server ----

/** No leading dash, so neither value can be read by ssh as an option. */
export const SshHost = z.union([
	z.ipv4(),
	z.ipv6(),
	z
		.string()
		.trim()
		.max(253)
		.regex(
			/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/,
			"an IP address or hostname",
		),
]);
export const SshUser = z
	.string()
	.trim()
	.min(1)
	.max(32)
	.regex(/^[a-z_][a-z0-9_.-]*$/, "a POSIX user name");

export const NodeJoinInput = z.object({
	name: z.string().trim().min(1).max(100),
	host: SshHost,
	port: z.int().min(1).max(65_535).default(22),
	sshUser: SshUser,
	sshKeyId: z.string().min(1),
	role: NodeRole.default("worker"),
	labels: NodeLabels.default({}),
});
export type NodeJoinInput = z.infer<typeof NodeJoinInput>;

/** Wizard steps the worker runs over SSH, in order. */
export const nodeJoinSteps = ["test", "preflight", "bootstrap"] as const;
export const NodeJoinStep = z.enum(nodeJoinSteps);
export type NodeJoinStep = z.infer<typeof NodeJoinStep>;

export const nodeJoinStates = [
	"queued",
	"running",
	"succeeded",
	"failed",
] as const;
export const NodeJoinState = z.enum(nodeJoinStates);
export type NodeJoinState = z.infer<typeof NodeJoinState>;

export const PreflightCheck = z.object({
	id: z.string(),
	label: z.string(),
	status: z.enum(["ok", "warn", "fail"]),
	detail: z.string(),
});
export type PreflightCheck = z.infer<typeof PreflightCheck>;

export const NodeJoin = z.object({
	id: z.string(),
	name: z.string(),
	host: z.string(),
	port: z.number(),
	sshUser: z.string(),
	sshKeyId: z.string(),
	role: NodeRole,
	labels: z.record(z.string(), z.string()),
	step: NodeJoinStep,
	state: NodeJoinState,
	error: z.string().nullable(),
	checks: z.array(PreflightCheck),
	log: z.array(z.string()),
	swarmNodeId: z.string().nullable(),
	nodeId: z.string().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type NodeJoin = z.infer<typeof NodeJoin>;

/** `data` frames on /ws: a host sample on `org:<id>:metrics`, a log line or state change on `node-join:<id>`. */
export const LiveMessage = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("host"),
		channel: z.string(),
		sample: LiveHostSample,
	}),
	z.object({
		kind: z.literal("join"),
		channel: z.string(),
		line: z.string().optional(),
		step: NodeJoinStep,
		state: NodeJoinState,
	}),
	/** Output of a schedule run on `schedule-run:<id>`. */
	z.object({
		kind: z.literal("output"),
		channel: z.string(),
		stream: z.enum(["stdout", "stderr"]),
		data: z.string(),
	}),
	/** A backup, verify or restore moving along on `backup-run:<id>`. */
	z.object({
		kind: z.literal("progress"),
		channel: z.string(),
		phase: z.string(),
		bytes: z.number().nonnegative(),
		/** Null while the size is unknown (a dump in flight). */
		total: z.number().nonnegative().nullable(),
		done: z.boolean().default(false),
	}),
	/** An instance update on `instance-update:<id>`: every step's state, plus the newest log line. */
	z.object({
		kind: z.literal("update"),
		channel: z.string(),
		state: UpdateState,
		steps: UpdateSteps,
		line: z.string().optional(),
	}),
	/** An agent conversation on `ai-agent:<id>`: its status, plus the message being written. */
	z.object({
		kind: z.literal("ai-agent"),
		channel: z.string(),
		status: AiAgentStatus,
		error: z.string().nullable().default(null),
		message: AiAgentMessage.optional(),
	}),
]);
export type LiveMessage = z.infer<typeof LiveMessage>;

/**
 * A node's status from what Swarm reports and whether its agent holds a presence key. An agent
 * that has never reported leaves a reachable node `pending`; one that stopped makes it `down`.
 */
export function deriveNodeStatus(input: {
	swarmState: "unknown" | "down" | "ready" | "disconnected" | undefined;
	availability: "active" | "pause" | "drain" | undefined;
	agentPresent: boolean;
	agentEverSeen: boolean;
}): NodeStatus {
	if (input.availability === "drain") return "draining";
	if (input.swarmState === "down" || input.swarmState === "disconnected")
		return "down";
	if (input.agentPresent) return "ready";
	return input.agentEverSeen ? "down" : "pending";
}
