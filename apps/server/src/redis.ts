import { RedisClient } from "bun";

const clients = new Map<string, RedisClient>();

/** One command connection per Redis URL, opened on first use; the Bus keeps its own pub/sub pair. */
export function redisFor(url: string): RedisClient {
	let client = clients.get(url);
	if (!client) {
		client = new RedisClient(url);
		clients.set(url, client);
	}
	return client;
}

export function closeRedis(url: string) {
	clients.get(url)?.close();
	clients.delete(url);
}

/** Worker-side contract: the worker subscribes here and runs a coalesced proxy sync. */
export const PROXY_SYNC_CHANNEL = "ls:proxy:sync";

/** Written by the worker after every proxy sync and certificate pass. */
export const CERTS_KEY = "ls:certs";

/** Hash per notification channel, written by the worker's dispatcher. */
export const channelStatusKey = (channelId: string) =>
	`ls:notify:status:${channelId}`;

/** Asks the worker to converge Caddy now instead of at its next periodic pass. */
export async function requestProxySync(url: string, reason: string) {
	await redisFor(url).publish(PROXY_SYNC_CHANNEL, reason);
}

/** Worker-side contract: the worker subscribes here and queues a reconcile pass. */
export const RECONCILE_CHANNEL = "ls:reconcile:request";

/** Asks the worker to converge Docker now (a desired-state change) instead of at its next pass. */
export async function requestReconcile(url: string, reason: string) {
	await redisFor(url).publish(RECONCILE_CHANNEL, reason);
}
