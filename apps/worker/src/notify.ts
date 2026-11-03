import type { EventEnvelope } from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import { notificationChannel, notificationRule } from "@logistack/db";
import {
	type Fetch,
	instantiate,
	matchRules,
	type NotificationChannel,
	type NotificationRule,
	notificationChannels,
	ProviderError,
	renderEvent,
} from "@logistack/providers";
import type { RedisClient } from "bun";
import { eq } from "drizzle-orm";
// shortcut: imported across apps; move ssrf.ts into a package once a third caller needs it.
import {
	guardedFetch,
	type HostPolicy,
	hostPolicy,
} from "../../server/src/ssrf.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";

/** Same key and shape as apps/server/src/routes/notifications.ts reads. */
export const channelStatusKey = (channelId: string) =>
	`ls:notify:status:${channelId}`;
const seenKey = (eventId: string) => `ls:notify:seen:${eventId}`;

export type DeliveryStatus = {
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	lastError: string | null;
	consecutiveFailures: number;
};

export type Outcome = { ok: true } | { ok: false; error: string };

export type DispatchDeps = {
	/** True for exactly one caller per event id, across every worker replica. */
	claim(eventId: string): Promise<boolean>;
	rules(organizationId: string): Promise<NotificationRule[]>;
	channel(id: string): Promise<NotificationChannel | null>;
	record(channelId: string, outcome: Outcome, at: Date): Promise<void>;
	sleep(ms: number): Promise<void>;
};

export const RETRY = { attempts: 4, baseMs: 1_000 };

/** 4xx other than 429 means the channel refuses this message; retrying won't change that. */
const retryable = (err: unknown) =>
	!(err instanceof ProviderError) ||
	err.status === undefined ||
	err.status === 429 ||
	err.status >= 500;

/** Sends with exponential backoff (1 s, 2 s, 4 s by default) until it succeeds or gives up. */
export async function deliver(
	send: () => Promise<void>,
	sleep: (ms: number) => Promise<void>,
	retry = RETRY,
): Promise<Outcome & { attempts: number }> {
	for (let attempt = 1; ; attempt++) {
		try {
			await send();
			return { ok: true, attempts: attempt };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			if (attempt >= retry.attempts || !retryable(err))
				return { ok: false, error, attempts: attempt };
			await sleep(retry.baseMs * 2 ** (attempt - 1));
		}
	}
}

/**
 * Routes one event to every channel a rule matches, each once. The claim dedupes by event
 * id, so a replayed or doubly-received envelope sends nothing the second time.
 */
export async function dispatch(
	event: EventEnvelope,
	deps: DispatchDeps,
	retry = RETRY,
): Promise<Map<string, Outcome>> {
	const results = new Map<string, Outcome>();
	if (!(await deps.claim(event.id))) return results;
	const channelIds = matchRules(event, await deps.rules(event.organizationId));
	if (channelIds.length === 0) return results;
	const rendered = renderEvent(event);
	await Promise.all(
		channelIds.map(async (id) => {
			const ch = await deps.channel(id);
			if (!ch) return;
			const { attempts: _, ...outcome } = await deliver(
				() => ch.send(event, rendered),
				deps.sleep,
				retry,
			);
			results.set(id, outcome);
			await deps.record(id, outcome, new Date());
		}),
	);
	return results;
}

export async function recordDelivery(
	redis: RedisClient,
	channelId: string,
	outcome: Outcome,
	at: Date,
) {
	const key = channelStatusKey(channelId);
	const prev = JSON.parse(
		(await redis.get(key)) ?? "null",
	) as DeliveryStatus | null;
	const next: DeliveryStatus = outcome.ok
		? {
				lastSuccessAt: at.toISOString(),
				lastFailureAt: prev?.lastFailureAt ?? null,
				lastError: prev?.lastError ?? null,
				consecutiveFailures: 0,
			}
		: {
				lastSuccessAt: prev?.lastSuccessAt ?? null,
				lastFailureAt: at.toISOString(),
				lastError: outcome.error,
				consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
			};
	await redis.set(key, JSON.stringify(next));
}

/**
 * Claims, rules and channels backed by the worker's Redis and Postgres. Channel requests go
 * through the API's SSRF guard (https only, no private hosts unless the instance allows
 * them); tests pass a plain `fetch` to reach a local receiver.
 */
export function dispatchDeps(ctx: Ctx, fetchFor?: Fetch): DispatchDeps {
	const redis = ctx.bus.redis;
	return {
		async claim(eventId) {
			// A day outlives any redelivery; the key is the whole dedupe state.
			return (
				(await redis.send("SET", [
					seenKey(eventId),
					"1",
					"NX",
					"EX",
					"86400",
				])) === "OK"
			);
		},
		async rules(organizationId) {
			return ctx.db
				.select()
				.from(notificationRule)
				.where(eq(notificationRule.organizationId, organizationId));
		},
		async channel(id) {
			const [row] = await ctx.db
				.select()
				.from(notificationChannel)
				.where(eq(notificationChannel.id, id));
			if (!row) return null;
			const config = JSON.parse(
				await decrypt(ctx.masterKey, row.configEncrypted),
			);
			const policy = fetchFor ? null : await hostPolicy(ctx.db);
			return instantiate(notificationChannels[row.kind], config, {
				fetch:
					fetchFor ??
					((url, init) => guardedFetch(url, init ?? {}, policy as HostPolicy)),
			});
		},
		record: (id, outcome, at) => recordDelivery(redis, id, outcome, at),
		sleep: Bun.sleep,
	};
}

/** The worker's bus listener. shortcut: retries live in memory, so a crash mid-backoff drops them; move to a BullMQ queue if that matters. */
export function notifier(ctx: Ctx) {
	const deps = dispatchDeps(ctx);
	return (event: EventEnvelope) => {
		dispatch(event, deps)
			.then((results) => {
				for (const [channelId, r] of results)
					if (!r.ok)
						log("warn", "notification failed", {
							event: event.type,
							channelId,
							error: r.error,
						});
			})
			.catch((err: unknown) =>
				log("error", "notification dispatch failed", {
					event: event.id,
					error: String(err),
				}),
			);
	};
}
