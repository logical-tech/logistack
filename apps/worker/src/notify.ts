import { EventEnvelope } from "@logistack/contracts";
import { decrypt, pluginBaseUrl } from "@logistack/core";
import {
	notificationChannel,
	notificationRule,
	pluginInstall,
} from "@logistack/db";
import {
	callPlugin,
	channel,
	type Fetch,
	guardedFetch,
	type HostPolicy,
	instantiate,
	matchRules,
	type NotificationChannel,
	type NotificationRule,
	notificationChannels,
	ProviderError,
	renderEvent,
} from "@logistack/providers";
import type { RedisClient } from "bun";
import { and, eq } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { hostPolicy } from "./ssrf.ts";

/**
 * An enabled install subscribed to events, as a channel: POST `/v1/events`, signed. A container
 * sits on our own network and is called directly; a dev URL is user input and goes through the
 * SSRF guard like a webhook.
 */
async function pluginChannel(
	ctx: Ctx,
	id: string,
	fetchFor?: Fetch,
): Promise<NotificationChannel | null> {
	const [row] = await ctx.db
		.select()
		.from(pluginInstall)
		.where(eq(pluginInstall.id, id));
	if (!row?.enabled) return null;
	const target = {
		baseUrl: pluginBaseUrl(row, ctx.cfg.LS_NAME_PREFIX),
		installId: row.id,
		signingSecret: await decrypt(ctx.masterKey, row.signingSecretEncrypted),
	};
	const policy = row.devUrl && !fetchFor ? await hostPolicy(ctx.db) : null;
	const f: Fetch =
		fetchFor ??
		(policy
			? (url, init) => guardedFetch(url, init ?? {}, policy, undefined, true)
			: (url, init) => fetch(url, init));
	return channel(async (event) => {
		await callPlugin(target, "/v1/events", { event }, { fetch: f });
	});
}

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

/** One delivery of one event to one channel; `attempt` counts from 1. */
export type NotifyJob = {
	event: EventEnvelope;
	channelId: string;
	attempt: number;
};

export type DispatchDeps = {
	/** True for exactly one caller per event id, across every worker replica. */
	claim(eventId: string): Promise<boolean>;
	rules(organizationId: string): Promise<NotificationRule[]>;
	/** Enabled plugin installs subscribed to the event's type; their ids resolve through `channel`. */
	subscribers?(event: EventEnvelope): Promise<string[]>;
	channel(id: string): Promise<NotificationChannel | null>;
	record(channelId: string, outcome: Outcome, at: Date): Promise<void>;
	/** Runs `job` again after `delayMs`, durably: a worker restart in between does not lose it. */
	retryLater(job: NotifyJob, delayMs: number): Promise<void>;
};

export const RETRY = { attempts: 4, baseMs: 1_000 };

/** 4xx other than 429 means the channel refuses this message; retrying won't change that. */
const retryable = (err: unknown) =>
	!(err instanceof ProviderError) ||
	err.status === undefined ||
	err.status === 429 ||
	err.status >= 500;

/**
 * One try. A retryable failure before the last attempt schedules the next one with
 * exponential backoff (1 s, 2 s, 4 s by default) and returns "retrying"; anything else is
 * recorded as the channel's outcome.
 */
export async function attempt(
	job: NotifyJob,
	deps: DispatchDeps,
	retry = RETRY,
): Promise<Outcome | "retrying" | "gone"> {
	const ch = await deps.channel(job.channelId);
	if (!ch) return "gone";
	let outcome: Outcome;
	try {
		await ch.send(job.event, renderEvent(job.event));
		outcome = { ok: true };
	} catch (err) {
		if (job.attempt < retry.attempts && retryable(err)) {
			await deps.retryLater(
				{ ...job, attempt: job.attempt + 1 },
				retry.baseMs * 2 ** (job.attempt - 1),
			);
			return "retrying";
		}
		outcome = {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	await deps.record(job.channelId, outcome, new Date());
	return outcome;
}

/**
 * Routes one event to every channel a rule matches, each once, and returns each first
 * try's result. The claim dedupes by event id, so a replayed or doubly-received envelope
 * sends nothing the second time.
 */
export async function dispatch(
	event: EventEnvelope,
	deps: DispatchDeps,
	retry = RETRY,
): Promise<Map<string, Outcome | "retrying">> {
	const results = new Map<string, Outcome | "retrying">();
	if (!(await deps.claim(event.id))) return results;
	const channelIds = [
		...matchRules(event, await deps.rules(event.organizationId)),
		...((await deps.subscribers?.(event)) ?? []),
	];
	await Promise.all(
		channelIds.map(async (channelId) => {
			const r = await attempt({ event, channelId, attempt: 1 }, deps, retry);
			if (r !== "gone") results.set(channelId, r);
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
		async subscribers(event) {
			const rows = await ctx.db
				.select({ id: pluginInstall.id, manifest: pluginInstall.manifest })
				.from(pluginInstall)
				.where(
					and(
						eq(pluginInstall.organizationId, event.organizationId),
						eq(pluginInstall.enabled, true),
					),
				);
			return rows
				.filter((r) => r.manifest.contributes.events.includes(event.type))
				.map((r) => r.id);
		},
		async channel(id) {
			if (id.startsWith("plg_")) return pluginChannel(ctx, id, fetchFor);
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
		async retryLater(job, delayMs) {
			await ctx.queues.notify.add("retry", job, {
				delay: delayMs,
				jobId: `${job.event.id}:${job.channelId}:${job.attempt}`,
			});
		},
	};
}

/** The worker's bus listener: the first try runs at once, retries wait in the `notify` queue. */
export function notifier(ctx: Ctx) {
	const deps = dispatchDeps(ctx);
	const warn = (
		event: EventEnvelope,
		channelId: string,
		r: Outcome | "retrying" | "gone",
	) => {
		if (typeof r === "object" && !r.ok)
			log("warn", "notification failed", {
				event: event.type,
				channelId,
				error: r.error,
			});
	};
	return {
		onEvent(event: EventEnvelope) {
			dispatch(event, deps)
				.then((results) => {
					for (const [channelId, r] of results) warn(event, channelId, r);
				})
				.catch((err: unknown) =>
					log("error", "notification dispatch failed", {
						event: event.id,
						error: String(err),
					}),
				);
		},
		/** The `notify` queue's processor. */
		async retry(data: unknown) {
			const raw = data as NotifyJob;
			const job = { ...raw, event: EventEnvelope.parse(raw.event) };
			warn(job.event, job.channelId, await attempt(job, deps));
		},
	};
}
