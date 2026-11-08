import { z } from "@hono/zod-openapi";
import type { EventEnvelope, LiveMessage } from "@logistack/contracts";
import type { Resource } from "@logistack/core";
import type { Db } from "@logistack/db";
import {
	aiAgentConversation,
	backupPolicy,
	backupRun,
	instanceUpdate,
	migration,
	nodeJoin,
	schedule,
	scheduleRun,
} from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { type Actor, requireActor, resolveActor } from "./actor.ts";
import { ACCESS_CHANNEL, cluster } from "./cluster.ts";
import type { Env } from "./env.ts";
import { parseJson } from "./events.ts";
import { live } from "./live.ts";
import { log } from "./log.ts";
import { actorCan, locate, organizationResource } from "./scope.ts";
import {
	followDeploymentLog,
	followServiceLogs,
	LogOptions,
	type StreamMessage,
} from "./streams.ts";

export { websocket } from "hono/bun";

const Channel = z
	.string()
	.regex(
		/^((org|deployment|service|node-join|backup-run|schedule-run|instance-update|deployment-log|service-logs|ai-agent):[A-Za-z0-9_-]+|org:[A-Za-z0-9_-]+:metrics)$/,
	);

const ClientMessage = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("subscribe"),
		channel: Channel,
		/** `service-logs:<id>` only. */
		options: LogOptions.optional(),
	}),
	z.object({ type: z.literal("unsubscribe"), channel: Channel }),
]);

export type ServerMessage =
	| { type: "subscribed" | "unsubscribed"; channel: string }
	| { type: "event"; channel: string; event: EventEnvelope }
	/** Live samples and log lines (`org:<id>:metrics`, `node-join:<id>`), not persisted events. */
	| { type: "data"; channel: string; data: LiveMessage }
	/** Log lines of `deployment-log:<id>` and `service-logs:<id>`. */
	| StreamMessage
	| {
			type: "error";
			channel?: string;
			code: "bad_request" | "forbidden";
			message: string;
	  };

async function channelResource(
	db: Db,
	actor: Actor,
	channel: string,
): Promise<Resource | undefined> {
	const [kind, id = ""] = channel.split(":");
	if (kind === "org") return organizationResource(id);
	// Only the member who owns the conversation follows it.
	if (kind === "ai-agent") {
		const n = await db.$count(
			aiAgentConversation,
			and(
				eq(aiAgentConversation.id, id),
				eq(aiAgentConversation.organizationId, actor.organizationId),
				eq(aiAgentConversation.userId, actor.userId),
			),
		);
		return n ? organizationResource(actor.organizationId) : undefined;
	}
	if (kind === "node-join") {
		const n = await db.$count(
			nodeJoin,
			and(
				eq(nodeJoin.id, id),
				eq(nodeJoin.organizationId, actor.organizationId),
			),
		);
		return n ? organizationResource(actor.organizationId) : undefined;
	}
	// Instance-wide, like the Updates page: anyone who can read the organization follows it.
	if (kind === "instance-update")
		return (await db.$count(instanceUpdate, eq(instanceUpdate.id, id)))
			? organizationResource(actor.organizationId)
			: undefined;
	// Migration progress: the wizard of the organization the migration belongs to.
	if (kind === "migration") {
		const n = await db.$count(
			migration,
			and(
				eq(migration.id, id),
				eq(migration.organizationId, actor.organizationId),
			),
		);
		return n ? organizationResource(actor.organizationId) : undefined;
	}
	if (kind === "backup-run") {
		const [r] = await db
			.select({ serviceId: backupPolicy.serviceId })
			.from(backupRun)
			.innerJoin(backupPolicy, eq(backupPolicy.id, backupRun.policyId))
			.where(eq(backupRun.id, id));
		return r
			? locate(db, actor.organizationId, "service", r.serviceId).catch(
					() => undefined,
				)
			: undefined;
	}
	if (kind === "schedule-run") {
		const [r] = await db
			.select({ org: schedule.organizationId, projectId: schedule.projectId })
			.from(scheduleRun)
			.innerJoin(schedule, eq(schedule.id, scheduleRun.scheduleId))
			.where(eq(scheduleRun.id, id));
		if (r?.org !== actor.organizationId) return undefined;
		return r.projectId
			? locate(db, actor.organizationId, "project", r.projectId).catch(
					() => undefined,
				)
			: organizationResource(actor.organizationId);
	}
	return locate(
		db,
		actor.organizationId,
		kind === "deployment" || kind === "deployment-log"
			? "deployment"
			: "service",
		id,
	).catch(() => undefined);
}

const sendTo = (ws: { send(data: string): void }, m: ServerMessage) =>
	ws.send(JSON.stringify(m));

/** Channels an envelope fans out to. */
export function channelsOf(e: EventEnvelope): string[] {
	const channels = [
		`org:${e.organizationId}`,
		`${e.resource.type}:${e.resource.id}`,
	];
	if (typeof e.payload.serviceId === "string")
		channels.push(`service:${e.payload.serviceId}`);
	return channels;
}

/** Close code for a socket whose credential no longer reaches the organization. */
export const ACCESS_REVOKED = 4403;

export const realtime = new Hono<Env>().get(
	"/ws",
	async (c, next) => {
		requireActor(c);
		await next();
	},
	upgradeWebSocket((c: Context<Env>) => {
		let actor = c.get("actor") as Actor;
		const { db, bus } = c.var.deps;
		// The upgrade's credential, re-resolved when the organization's access changes.
		const headers = new Headers(c.req.raw.headers);
		const subscribed = new Set<string>();
		/** Log streams by channel; each holds a Redis subscription or agent follows. */
		const streams = new Map<string, Promise<() => void>>();
		const stopStream = (channel: string) => {
			void streams.get(channel)?.then((stop) => stop());
			streams.delete(channel);
		};
		let unlisten: (() => void) | undefined;
		let unlive: (() => void) | undefined;
		let unaccess: (() => void) | undefined;
		let closed = false;
		let rechecks = Promise.resolve();
		/** Applies a role, grant or membership change from any replica to this open socket. */
		async function recheck(ws: {
			send(data: string): void;
			close(code: number, reason: string): void;
		}) {
			const next = await resolveActor(c.var.deps, headers);
			if (
				!next ||
				next.organizationId !== actor.organizationId ||
				next.twoFactor?.kind === "blocked"
			)
				return ws.close(ACCESS_REVOKED, "access revoked");
			actor = next;
			for (const channel of [...subscribed]) {
				const resource = await channelResource(db, actor, channel);
				if (resource && actorCan(actor, "read", resource)) continue;
				subscribed.delete(channel);
				stopStream(channel);
				sendTo(ws, {
					type: "error",
					channel,
					code: "forbidden",
					message: "access to this channel was revoked",
				});
			}
		}
		return {
			async onOpen(_evt, ws) {
				const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
				unlisten = bus.onEvent((event) => {
					if (event.organizationId !== actor.organizationId) return;
					const channel = channelsOf(event).find((ch) => subscribed.has(ch));
					if (channel) send({ type: "event", channel, event });
				});
				unlive = (await live(c.var.deps.config.REDIS_URL)).onLive((data) => {
					if (subscribed.has(data.channel))
						send({ type: "data", channel: data.channel, data });
				});
				// After the bus listener, so an event published right after subscribing is never missed.
				unaccess = await cluster(c.var.deps.config.REDIS_URL).on(
					ACCESS_CHANNEL,
					(m) => {
						if (
							(m as { organizationId?: unknown } | null)?.organizationId !==
							actor.organizationId
						)
							return;
						rechecks = rechecks
							.then(() => recheck(ws))
							.catch((e) =>
								log("error", "socket access recheck failed", {
									error: String(e),
								}),
							);
					},
				);
				if (closed) {
					unlisten();
					unlive();
					unaccess();
				}
			},
			async onMessage(evt, ws) {
				const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
				const msg = ClientMessage.safeParse(
					typeof evt.data === "string" ? parseJson(evt.data) : undefined,
				);
				if (!msg.success)
					return send({
						type: "error",
						code: "bad_request",
						message: "invalid message",
					});
				const { type, channel } = msg.data;
				if (type === "unsubscribe") {
					subscribed.delete(channel);
					stopStream(channel);
					return send({ type: "unsubscribed", channel });
				}
				const resource = await channelResource(db, actor, channel);
				if (!resource || !actorCan(actor, "read", resource))
					return send({
						type: "error",
						channel,
						code: "forbidden",
						message: "cannot subscribe to this channel",
					});
				subscribed.add(channel);
				send({ type: "subscribed", channel });
				const [kind, id = ""] = channel.split(":");
				const stream =
					kind === "deployment-log"
						? followDeploymentLog(c.var.deps, id, channel, send)
						: kind === "service-logs"
							? followServiceLogs(
									c.var.deps,
									id,
									channel,
									msg.data.options ?? LogOptions.parse({}),
									send,
								)
							: undefined;
				if (!stream) return;
				// A resubscribe (new tail or replica filter) replaces the running stream.
				stopStream(channel);
				streams.set(
					channel,
					stream.catch((e: unknown) => {
						send({ type: "end", channel, reason: String(e) });
						return () => {};
					}),
				);
				if (closed) stopStream(channel);
			},
			onClose() {
				closed = true;
				for (const channel of [...streams.keys()]) stopStream(channel);
				unlisten?.();
				unlive?.();
				unaccess?.();
			},
		};
	}),
);
