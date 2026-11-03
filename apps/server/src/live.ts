import {
	LIVE_CHANNEL,
	LiveMessage,
	NODE_OPS_CHANNEL,
} from "@logistack/contracts";
import { RedisClient } from "bun";
import { parseJson } from "./events.ts";
import { log } from "./log.ts";

type Live = {
	/** Plain command connection: presence keys, last samples, node-op pokes. */
	redis: RedisClient;
	onLive(listener: (m: LiveMessage) => void): () => void;
	poke(): Promise<void>;
};

const byUrl = new Map<string, Promise<Live>>();

// shortcut: one lazily opened pair of connections per Redis URL instead of a Deps field, so other routes and the test harness stay untouched; fold into Deps when Deps next changes.
export function live(redisUrl: string): Promise<Live> {
	let found = byUrl.get(redisUrl);
	if (!found) {
		found = open(redisUrl);
		byUrl.set(redisUrl, found);
	}
	return found;
}

async function open(url: string): Promise<Live> {
	const redis = new RedisClient(url);
	const sub = new RedisClient(url);
	const listeners = new Set<(m: LiveMessage) => void>();
	await sub.subscribe(LIVE_CHANNEL, (raw: string) => {
		const m = LiveMessage.safeParse(parseJson(raw));
		if (!m.success) {
			log("warn", "dropped malformed live message", { channel: LIVE_CHANNEL });
			return;
		}
		for (const l of listeners) l(m.data);
	});
	return {
		redis,
		onLive(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async poke() {
			await redis.publish(NODE_OPS_CHANNEL, "1");
		},
	};
}
