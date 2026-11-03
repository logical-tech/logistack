import { createRoute, z } from "@hono/zod-openapi";
import {
	EventType,
	NotificationChannelKind,
	NotificationRuleScope,
} from "@logistack/contracts";
import { decrypt, encrypt } from "@logistack/core";
import {
	type Db,
	environment,
	notificationChannel,
	notificationRule,
	project,
	service,
} from "@logistack/db";
import {
	instantiate,
	type NotificationChannel,
	notificationChannels,
	ProviderError,
} from "@logistack/providers";
import { and, asc, eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, notFound, one } from "../errors.ts";
import { parseJson } from "../events.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { channelStatusKey, redisFor } from "../redis.ts";
import { inOrganization, requirePermission } from "../scope.ts";
import { BlockedHostError, guardedFetch, hostPolicy } from "../ssrf.ts";

const Config = z.record(z.string(), z.unknown());

/** Mirrors `DeliveryStatus` in apps/worker/src/notify.ts, which writes it after each send. */
const Delivery = z
	.object({
		lastSuccessAt: z.string().nullable(),
		lastFailureAt: z.string().nullable(),
		lastError: z.string().nullable(),
		consecutiveFailures: z.int(),
	})
	.openapi("ChannelDelivery");

const ChannelView = z
	.object({
		id: z.string(),
		kind: NotificationChannelKind,
		name: z.string(),
		rules: z.int(),
		delivery: Delivery.nullable(),
		createdAt: z.string(),
	})
	.openapi("NotificationChannel");

const RuleInput = z.object({
	events: z.array(EventType).min(1),
	scope: NotificationRuleScope,
	channelId: z.string(),
	enabled: z.boolean().default(true),
});

const Rule = RuleInput.extend({
	id: z.string(),
	createdAt: z.string(),
}).openapi("NotificationRule");

type ChannelRow = typeof notificationChannel.$inferSelect;
type RuleRow = typeof notificationRule.$inferSelect;

function parseConfig(kind: NotificationChannelKind, config: unknown): unknown {
	const parsed = notificationChannels[kind].configSchema.safeParse(config);
	if (!parsed.success)
		throw new Failure(
			"validation_failed",
			"config does not match the channel",
			parsed.error.issues,
		);
	return parsed.data;
}

/** A channel whose requests go through the SSRF guard: webhook, ntfy and Gotify URLs are the user's. */
async function openChannel(
	db: Db,
	kind: NotificationChannelKind,
	config: unknown,
): Promise<NotificationChannel> {
	const policy = await hostPolicy(db);
	return instantiate(notificationChannels[kind], config, {
		fetch: (url, init) => guardedFetch(url, init ?? {}, policy),
	});
}

async function sendTest(ch: NotificationChannel) {
	try {
		await ch.test();
	} catch (err) {
		if (err instanceof ProviderError || err instanceof BlockedHostError)
			throw new Failure("bad_request", err.message);
		throw err;
	}
}

async function channelRow(db: Db, organizationId: string, id: string) {
	const [row] = await db
		.select()
		.from(notificationChannel)
		.where(
			and(
				eq(notificationChannel.id, id),
				eq(notificationChannel.organizationId, organizationId),
			),
		);
	if (!row) throw notFound("notification channel");
	return row;
}

/** A rule's channel, project and service must all be the caller's organization's. */
async function assertRuleOwned(
	db: Db,
	organizationId: string,
	input: z.infer<typeof RuleInput>,
) {
	await channelRow(db, organizationId, input.channelId);
	const { projectId, serviceId } = input.scope;
	if (projectId) {
		const n = await db.$count(
			project,
			and(
				eq(project.id, projectId),
				eq(project.organizationId, organizationId),
			),
		);
		if (n === 0) throw notFound("project");
	}
	if (serviceId) {
		const [row] = await db
			.select({ projectId: project.id })
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.where(
				and(
					eq(service.id, serviceId),
					eq(project.organizationId, organizationId),
				),
			);
		if (!row) throw notFound("service");
		if (projectId && row.projectId !== projectId)
			throw new Failure("bad_request", "the service is not in that project");
	}
}

const ruleView = (r: RuleRow) => ({
	id: r.id,
	events: r.events,
	scope: r.scope,
	channelId: r.channelId,
	enabled: r.enabled,
	createdAt: r.createdAt.toISOString(),
});

async function channelView(
	redisUrl: string,
	r: ChannelRow,
	rules: number,
): Promise<z.infer<typeof ChannelView>> {
	const raw = await redisFor(redisUrl)
		.get(channelStatusKey(r.id))
		.catch(() => null);
	const delivery = Delivery.safeParse(raw ? parseJson(raw) : undefined);
	return {
		id: r.id,
		kind: r.kind,
		name: r.name,
		rules,
		delivery: delivery.success ? delivery.data : null,
		createdAt: r.createdAt.toISOString(),
	};
}

const tags = ["notifications"];
const admin = [requirePermission("admin", inOrganization)];

export const notifications = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/notification-channels",
			tags,
			security,
			summary: "Channels with their last delivery outcome",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(ChannelView), "Channels"), ...errors },
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const [rows, rules] = await Promise.all([
				db
					.select()
					.from(notificationChannel)
					.where(eq(notificationChannel.organizationId, organizationId))
					.orderBy(asc(notificationChannel.name)),
				db
					.select({ channelId: notificationRule.channelId })
					.from(notificationRule)
					.where(eq(notificationRule.organizationId, organizationId)),
			]);
			return c.json(
				await Promise.all(
					rows.map((r) =>
						channelView(
							config.REDIS_URL,
							r,
							rules.filter((x) => x.channelId === r.id).length,
						),
					),
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"notification_channel.test",
			createRoute({
				method: "post",
				path: "/notification-channels/test",
				tags,
				security,
				summary: "Send the test message through an unsaved channel config",
				middleware: admin,
				request: body(
					z.object({ kind: NotificationChannelKind, config: Config }),
				),
				responses: {
					200: json(z.object({ ok: z.literal(true) }), "Sent"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { kind, config } = c.req.valid("json");
			await sendTest(
				await openChannel(c.var.deps.db, kind, parseConfig(kind, config)),
			);
			return c.json({ ok: true as const }, 200);
		},
	)
	.openapi(
		mutation(
			"notification_channel.create",
			createRoute({
				method: "post",
				path: "/notification-channels",
				tags,
				security,
				middleware: admin,
				request: body(
					z.object({
						kind: NotificationChannelKind,
						name: Name,
						config: Config,
					}),
				),
				responses: { 201: json(ChannelView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const { kind, name, config } = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const row = one(
				await db
					.insert(notificationChannel)
					.values({
						organizationId: requireActor(c).organizationId,
						kind,
						name,
						configEncrypted: await encrypt(
							masterKey,
							JSON.stringify(parseConfig(kind, config)),
						),
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(
				await channelView(c.var.deps.config.REDIS_URL, row, 0),
				201,
			);
		},
	)
	.openapi(
		mutation(
			"notification_channel.update",
			createRoute({
				method: "patch",
				path: "/notification-channels/{id}",
				tags,
				security,
				summary: "Rename a channel or replace its whole config",
				middleware: admin,
				request: {
					params: IdParam,
					...body(
						z.object({ name: Name.optional(), config: Config.optional() }),
					),
				},
				responses: { 200: json(ChannelView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db, masterKey, config } = c.var.deps;
			const current = await channelRow(db, requireActor(c).organizationId, id);
			const row = one(
				await db
					.update(notificationChannel)
					.set({
						...(input.name ? { name: input.name } : {}),
						...(input.config
							? {
									configEncrypted: await encrypt(
										masterKey,
										JSON.stringify(parseConfig(current.kind, input.config)),
									),
								}
							: {}),
					})
					.where(eq(notificationChannel.id, id))
					.returning(),
			);
			const rules = await db.$count(
				notificationRule,
				eq(notificationRule.channelId, id),
			);
			c.set("auditResourceId", id);
			return c.json(await channelView(config.REDIS_URL, row, rules), 200);
		},
	)
	.openapi(
		mutation(
			"notification_channel.test",
			createRoute({
				method: "post",
				path: "/notification-channels/{id}/test",
				tags,
				security,
				summary: "Send the test message through a saved channel",
				middleware: admin,
				request: { params: IdParam },
				responses: {
					200: json(z.object({ ok: z.literal(true) }), "Sent"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const row = await channelRow(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			const cfg = JSON.parse(await decrypt(masterKey, row.configEncrypted));
			await sendTest(await openChannel(db, row.kind, cfg));
			c.set("auditResourceId", row.id);
			return c.json({ ok: true as const }, 200);
		},
	)
	.openapi(
		mutation(
			"notification_channel.delete",
			createRoute({
				method: "delete",
				path: "/notification-channels/{id}",
				tags,
				security,
				description: "Deletes the channel's rules with it.",
				middleware: admin,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db, config } = c.var.deps;
			await channelRow(db, requireActor(c).organizationId, id);
			await db
				.delete(notificationChannel)
				.where(eq(notificationChannel.id, id));
			await redisFor(config.REDIS_URL)
				.del(channelStatusKey(id))
				.catch(() => {});
			c.set("auditResourceId", id);
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/notification-rules",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(Rule), "Rules"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(notificationRule)
				.where(
					eq(notificationRule.organizationId, requireActor(c).organizationId),
				)
				.orderBy(asc(notificationRule.createdAt));
			return c.json(rows.map(ruleView), 200);
		},
	)
	.openapi(
		mutation(
			"notification_rule.create",
			createRoute({
				method: "post",
				path: "/notification-rules",
				tags,
				security,
				middleware: admin,
				request: body(RuleInput),
				responses: { 201: json(Rule, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			await assertRuleOwned(db, organizationId, input);
			const row = one(
				await db
					.insert(notificationRule)
					.values({ organizationId, ...input })
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(ruleView(row), 201);
		},
	)
	.openapi(
		mutation(
			"notification_rule.update",
			createRoute({
				method: "put",
				path: "/notification-rules/{id}",
				tags,
				security,
				middleware: admin,
				request: { params: IdParam, ...body(RuleInput) },
				responses: { 200: json(Rule, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			await assertRuleOwned(db, organizationId, input);
			const row = one(
				await db
					.update(notificationRule)
					.set(input)
					.where(
						and(
							eq(notificationRule.id, id),
							eq(notificationRule.organizationId, organizationId),
						),
					)
					.returning(),
				"notification rule",
			);
			c.set("auditResourceId", id);
			return c.json(ruleView(row), 200);
		},
	)
	.openapi(
		mutation(
			"notification_rule.delete",
			createRoute({
				method: "delete",
				path: "/notification-rules/{id}",
				tags,
				security,
				middleware: admin,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const deleted = await c.var.deps.db
				.delete(notificationRule)
				.where(
					and(
						eq(notificationRule.id, id),
						eq(notificationRule.organizationId, requireActor(c).organizationId),
					),
				)
				.returning({ id: notificationRule.id });
			if (deleted.length === 0) throw notFound("notification rule");
			c.set("auditResourceId", id);
			return c.body(null, 204);
		},
	);
