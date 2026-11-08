import { RedisClient } from "bun";
import { log } from "./log.ts";

/**
 * What api replicas share. Several replicas run behind one VIP, so anything a request starts
 * must be reachable from any replica: pub/sub for signals, Redis leases for single runners.
 */

/** Asks every replica to re-resolve the sockets of an organization (`{ organizationId }`). */
export const ACCESS_CHANNEL = "ls:access";
/** Asks the replica holding a node's socket to close it (`{ nodeId }`, the Swarm node id). */
export const NODE_REVOKED_CHANNEL = "ls:node:revoked";

export type Cluster = {
	publish(channel: string, message: unknown): Promise<void>;
	/** Calls `fn` with each JSON message on `channel`, from any replica. Resolves to the unsubscribe. */
	on(channel: string, fn: (message: unknown) => void): Promise<() => void>;
	close(): void;
};

export function createCluster(url: string): Cluster {
	const pub = new RedisClient(url);
	// A subscribed connection runs nothing else, hence its own.
	const sub = new RedisClient(url);
	const handlers = new Map<string, Set<(m: unknown) => void>>();
	return {
		async publish(channel, message) {
			await pub.publish(channel, JSON.stringify(message));
		},
		async on(channel, fn) {
			let set = handlers.get(channel);
			if (!set) {
				const fresh = new Set<(m: unknown) => void>();
				set = fresh;
				handlers.set(channel, fresh);
				await sub.subscribe(channel, (raw: string) => {
					let m: unknown;
					try {
						m = JSON.parse(raw);
					} catch {
						return log("warn", "dropped malformed cluster message", {
							channel,
						});
					}
					for (const h of fresh) h(m);
				});
			}
			set.add(fn);
			return () => {
				set.delete(fn);
				if (set.size || handlers.get(channel) !== set) return;
				handlers.delete(channel);
				void sub.unsubscribe(channel).catch(() => {});
			};
		},
		close() {
			sub.close();
			pub.close();
		},
	};
}

const byUrl = new Map<string, Cluster>();

// shortcut: one lazily opened pair per Redis URL, like live.ts, instead of a Deps field; fold into Deps when Deps next changes.
export function cluster(url: string): Cluster {
	let found = byUrl.get(url);
	if (!found) {
		found = createCluster(url);
		byUrl.set(url, found);
	}
	return found;
}

export function closeCluster(url: string) {
	byUrl.get(url)?.close();
	byUrl.delete(url);
}

const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export type Lease = {
	/** True once another holder took the key (this one expired); stop working on it. */
	readonly lost: boolean;
	release(): Promise<void>;
};

/**
 * Takes `key` for this process, or undefined when another holder has it. The lease renews itself
 * every third of `ttlMs` while held; a replica that dies lets it lapse within `ttlMs`.
 */
export async function acquireLease(
	redis: RedisClient,
	key: string,
	ttlMs = 30_000,
): Promise<Lease | undefined> {
	const token = crypto.randomUUID();
	const ok = await redis.send("SET", [key, token, "NX", "PX", String(ttlMs)]);
	if (ok !== "OK") return undefined;
	let lost = false;
	const timer = setInterval(async () => {
		try {
			const renewed = await redis.send("EVAL", [
				RENEW,
				"1",
				key,
				token,
				String(ttlMs),
			]);
			if (renewed !== 1) {
				lost = true;
				clearInterval(timer);
			}
		} catch (e) {
			log("warn", "lease renewal failed", { key, error: String(e) });
		}
	}, ttlMs / 3);
	return {
		get lost() {
			return lost;
		},
		async release() {
			clearInterval(timer);
			await redis
				.send("EVAL", [RELEASE, "1", key, token])
				.catch((e) =>
					log("warn", "lease release failed", { key, error: String(e) }),
				);
		},
	};
}

/** Runs `fn` while holding `key`, waiting up to `waitMs` for another holder (any replica) to finish. */
export async function withLock<T>(
	redis: RedisClient,
	key: string,
	fn: () => Promise<T>,
	{ ttlMs = 30_000, waitMs = 600_000, pollMs = 100 } = {},
): Promise<T> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const lease = await acquireLease(redis, key, ttlMs);
		if (lease)
			try {
				return await fn();
			} finally {
				await lease.release();
			}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${key}`);
		await Bun.sleep(pollMs);
	}
}
