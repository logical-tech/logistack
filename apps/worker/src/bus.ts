import {
	DEPLOYMENT_LOG_TTL_SEC,
	type DeploymentLogLine,
	deploymentLogChannel,
	deploymentLogKey,
	EventEnvelope,
	type EventType,
} from "@logistack/contracts";
import { newId } from "@logistack/core";
import { RedisClient } from "bun";

/** Same channel and envelope as apps/server/src/events.ts. */
export const EVENTS_CHANNEL = "ls:events";

let silent = false;
export const setLogLevel = (level: "info" | "silent") => {
	silent = level === "silent";
};

/** One JSON object per line on stdout. */
export function log(
	level: "info" | "warn" | "error",
	msg: string,
	fields: Record<string, unknown> = {},
) {
	if (silent) return;
	console.log(
		JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields }),
	);
}

export type Bus = {
	/** A plain command connection, also used for locks. */
	redis: RedisClient;
	publish(
		type: EventType,
		organizationId: string,
		resource: EventEnvelope["resource"],
		payload?: EventEnvelope["payload"],
	): Promise<void>;
	/** Appends to the replay list, then publishes with its index. Callers send one line at a time. */
	publishLog(deploymentId: string, line: string): Promise<void>;
	onEvent(listener: (e: EventEnvelope) => void): void;
	close(): void;
};

export async function createBus(url: string): Promise<Bus> {
	const redis = new RedisClient(url);
	// A subscribed connection cannot run other commands, hence a second one.
	const sub = new RedisClient(url);
	const listeners = new Set<(e: EventEnvelope) => void>();
	await sub.subscribe(EVENTS_CHANNEL, (message: string) => {
		let raw: unknown;
		try {
			raw = JSON.parse(message);
		} catch {}
		const parsed = EventEnvelope.safeParse(raw);
		if (!parsed.success) {
			log("warn", "dropped malformed event", { channel: EVENTS_CHANNEL });
			return;
		}
		for (const l of listeners) l(parsed.data);
	});
	return {
		redis,
		async publish(type, organizationId, resource, payload = {}) {
			const envelope: EventEnvelope = {
				id: newId("evt"),
				type,
				organizationId,
				resource,
				payload,
				at: new Date(),
			};
			await redis.publish(EVENTS_CHANNEL, JSON.stringify(envelope));
		},
		async publishLog(deploymentId, line) {
			const key = deploymentLogKey(deploymentId);
			const at = new Date().toISOString();
			const length = await redis.rpush(key, JSON.stringify({ line, at }));
			await redis.expire(key, DEPLOYMENT_LOG_TTL_SEC);
			const m: DeploymentLogLine = { seq: length - 1, line, at };
			await redis.publish(
				deploymentLogChannel(deploymentId),
				JSON.stringify(m),
			);
		},
		onEvent: (l) => void listeners.add(l),
		close() {
			sub.close();
			redis.close();
		},
	};
}

/** Redis lock for one pass across worker replicas; returns false when another holder has it. */
export async function withLock(
	redis: RedisClient,
	key: string,
	ttlMs: number,
	fn: () => Promise<void>,
): Promise<boolean> {
	const token = crypto.randomUUID();
	const ok = await redis.send("SET", [key, token, "NX", "PX", String(ttlMs)]);
	if (ok !== "OK") return false;
	try {
		await fn();
	} finally {
		// Release only our own lock: a pass that outlived its TTL must not free the next holder's.
		await redis.send("EVAL", [
			"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
			"1",
			key,
			token,
		]);
	}
	return true;
}
