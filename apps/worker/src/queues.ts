import { type ConnectionOptions, Queue } from "bullmq";

export const QUEUES = [
	"deploy",
	"proxy",
	"reconcile",
	"maintenance",
	"backup",
	"schedule",
	"migration",
	"scan",
	"notify",
	"uptime",
] as const;
export type QueueName = (typeof QUEUES)[number];
export type Queues = Record<QueueName, Queue>;

/** BullMQ takes ioredis options, not a URL. */
export function redisConnection(url: string): ConnectionOptions {
	const u = new URL(url);
	return {
		host: u.hostname,
		port: Number(u.port || 6379),
		...(u.username ? { username: decodeURIComponent(u.username) } : {}),
		...(u.password ? { password: decodeURIComponent(u.password) } : {}),
		db: Number(u.pathname.slice(1) || 0),
		...(u.protocol === "rediss:" ? { tls: {} } : {}),
		// Required by BullMQ workers: blocking commands must not time out.
		maxRetriesPerRequest: null,
	};
}

export function createQueues(
	connection: ConnectionOptions,
	prefix?: string,
): Queues {
	const make = (name: QueueName) =>
		new Queue(name, {
			connection,
			...(prefix ? { prefix } : {}),
			defaultJobOptions: {
				removeOnComplete: { count: 200 },
				removeOnFail: { count: 500 },
			},
		});
	return Object.fromEntries(QUEUES.map((n) => [n, make(n)])) as Queues;
}

/**
 * One deploy job per service at a time: the job id is the service id, so BullMQ never runs two
 * for the same service. The job drains every queued deployment of that service before it ends.
 */
export const enqueueDeploy = (q: Queues, serviceId: string) =>
	q.deploy.add(
		"service",
		{ serviceId },
		{
			jobId: serviceId,
			attempts: 3,
			backoff: { type: "exponential", delay: 5_000 },
			// A finished job must free its id at once, or the next deploy of the service is dropped.
			removeOnComplete: true,
			removeOnFail: true,
		},
	);

/** Proxy pushes are idempotent (Caddy skips an identical config); the processor coalesces. */
export const enqueueProxySync = (q: Queues, reason: string) =>
	q.proxy.add(
		"sync",
		{ reason },
		{ attempts: 3, backoff: { type: "exponential", delay: 1_000 } },
	);

/** Scans a service's image after a deploy; a burst of deploys of one service shares one job. */
export const enqueueScan = (q: Queues, serviceId: string) =>
	q.scan.add(
		"service",
		{ serviceId },
		{ deduplication: { id: `scan:${serviceId}`, ttl: 60_000 }, delay: 5_000 },
	);

export const enqueueReconcile = (q: Queues, reason: string) =>
	q.reconcile.add(
		"pass",
		{ reason },
		// Debounce bursts of Docker events into one pass.
		{ deduplication: { id: "reconcile", ttl: 2_000 }, delay: 500 },
	);
