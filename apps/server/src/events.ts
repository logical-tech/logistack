import { EventEnvelope, type EventType } from "@logistack/contracts";
import { newId } from "@logistack/core";
import { RedisClient } from "bun";
import { log } from "./log.ts";

/** Redis pub/sub channel every producer (server, worker, agent relay) publishes envelopes on. */
export const EVENTS_CHANNEL = "ls:events";

export type Bus = {
	publishEvent(envelope: EventEnvelope): Promise<void>;
	/** Called for every envelope received on `ls:events`, from any replica. Returns an unsubscribe. */
	onEvent(listener: (envelope: EventEnvelope) => void): () => void;
	ping(): Promise<boolean>;
	close(): void;
};

export function envelope(
	type: EventType,
	organizationId: string,
	resource: EventEnvelope["resource"],
	payload: EventEnvelope["payload"] = {},
): EventEnvelope {
	return {
		id: newId("evt"),
		type,
		organizationId,
		resource,
		payload,
		at: new Date(),
	};
}

export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// Bun's built-in client: pub/sub and PING are all the server needs, so no ioredis dependency.
export async function createBus(url: string): Promise<Bus> {
	const pub = new RedisClient(url);
	// A subscribed connection cannot run other commands, hence a second one.
	const sub = new RedisClient(url);
	const listeners = new Set<(e: EventEnvelope) => void>();
	await sub.subscribe(EVENTS_CHANNEL, (message: string) => {
		const parsed = EventEnvelope.safeParse(parseJson(message));
		if (!parsed.success) {
			log("warn", "dropped malformed event", { channel: EVENTS_CHANNEL });
			return;
		}
		for (const listener of listeners) listener(parsed.data);
	});
	return {
		async publishEvent(e) {
			await pub.publish(EVENTS_CHANNEL, JSON.stringify(e));
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async ping() {
			try {
				return (await pub.ping()) === "PONG";
			} catch {
				return false;
			}
		},
		close() {
			sub.close();
			pub.close();
		},
	};
}
