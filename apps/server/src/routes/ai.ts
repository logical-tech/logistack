import { createRoute, z } from "@hono/zod-openapi";
import {
	type AiProviderDef,
	aiProvider,
	aiProviderIds,
	aiProviders,
	can,
	dailyAllowance,
	encrypt,
	priceFor,
} from "@logistack/core";
import {
	aiBudget,
	aiGatewayKey,
	aiProviderKey,
	aiSettings,
	aiUsage,
	member,
	user,
} from "@logistack/db";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Context } from "hono";
import { grantsFor, requireActor } from "../actor.ts";
import { capsFor, monthSpend } from "../ai/budget.ts";
import { priceCatalog } from "../ai/catalog.ts";
import { AI_KEY_PREFIX, hashKey } from "../ai/gateway.ts";
import {
	type LiveLimits,
	liveKey,
	type ProviderKey,
	testKey,
} from "../ai/upstream.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { redisFor } from "../redis.ts";
import {
	actorCan,
	inOrganization,
	organizationResource,
	requirePermission,
} from "../scope.ts";

const tags = ["ai"];
const MICROS = 1_000_000;
const usd = (micros: number) => micros / MICROS;
const toMicros = (dollars: number | null) =>
	dollars === null ? null : Math.round(dollars * MICROS);

const Tier = z.enum(["free", "paid"]);

const ProviderDef = z
	.object({
		id: z.string(),
		name: z.string(),
		tier: Tier,
		keyUrl: z.string().nullable(),
		keyHint: z.string(),
		customBaseUrl: z.boolean(),
		keyless: z.boolean(),
		defaultModel: z.string().nullable(),
	})
	.openapi("AiProvider");

const Settings = z
	.object({
		gatewayEnabled: z.boolean(),
		autoChain: z.array(z.string()),
		/** Whether the caller manages providers, budgets and settings. */
		canAdmin: z.boolean(),
		providers: z.array(ProviderDef),
		/** This month, the caller's: USD, null = unlimited. */
		me: z.object({
			caps: z.object({
				free: z.number().nullable(),
				paid: z.number().nullable(),
			}),
			spent: z.object({ free: z.number(), paid: z.number() }),
		}),
	})
	.openapi("AiSettings");

const ProviderKeyView = z
	.object({
		id: z.string(),
		provider: z.string(),
		label: z.string(),
		baseUrl: z.string().nullable(),
		enabled: z.boolean(),
		status: z.enum(["unknown", "healthy", "unhealthy"]),
		lastError: z.string().nullable(),
		lastCheckedAt: z.string().nullable(),
		models: z.array(z.string()),
		createdAt: z.string(),
	})
	.openapi("AiProviderKey");

const GatewayKeyView = z
	.object({
		id: z.string(),
		name: z.string(),
		start: z.string(),
		userId: z.string(),
		userName: z.string(),
		lastUsedAt: z.string().nullable(),
		createdAt: z.string(),
	})
	.openapi("AiGatewayKey");

const ModelView = z
	.object({
		id: z.string(),
		provider: z.string(),
		model: z.string(),
		tier: Tier,
		/** USD per million tokens; for free models what the same model costs on the market. */
		price: z.object({ input: z.number(), output: z.number() }).nullable(),
	})
	.openapi("AiModel");

const BudgetView = z
	.object({
		userId: z.string(),
		name: z.string(),
		email: z.string(),
		role: z.string(),
		hasAi: z.boolean(),
		isAdmin: z.boolean(),
		/** USD per month, null = unlimited. */
		caps: z.object({
			free: z.number().nullable(),
			paid: z.number().nullable(),
		}),
		/** True when no budget row exists and the defaults apply. */
		inherited: z.boolean(),
		spent: z.object({ free: z.number(), paid: z.number() }),
	})
	.openapi("AiBudget");

export const aiUsageRanges = ["24h", "7d", "30d", "90d", "12m"] as const;
const UsageRange = z.enum(aiUsageRanges);

const RANGE: Record<
	(typeof aiUsageRanges)[number],
	{ ms: number; step: "hour" | "day" | "week" | "month" }
> = {
	"24h": { ms: 86_400_000, step: "hour" },
	"7d": { ms: 7 * 86_400_000, step: "day" },
	"30d": { ms: 30 * 86_400_000, step: "day" },
	"90d": { ms: 90 * 86_400_000, step: "week" },
	"12m": { ms: 365 * 86_400_000, step: "month" },
};

const Figures = z.object({
	requests: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	/** USD: real for paid, market-equivalent for free. */
	cost: z.number(),
});

const UsageView = z
	.object({
		range: UsageRange,
		step: z.enum(["hour", "day", "week", "month"]),
		from: z.string(),
		to: z.string(),
		buckets: z.array(z.object({ t: z.string(), free: Figures, paid: Figures })),
		totals: z.object({ free: Figures, paid: Figures, errors: z.number() }),
		byModel: z.array(
			Figures.extend({ provider: z.string(), model: z.string(), tier: Tier }),
		),
		byMember: z.array(
			z.object({
				userId: z.string(),
				name: z.string(),
				free: Figures,
				paid: Figures,
			}),
		),
	})
	.openapi("AiUsage");

const Allowance = z.object({
	amount: z.number(),
	unit: z.enum(["tokens", "requests", "neurons", "usd"]),
	per: z.enum(["minute", "hour", "day", "month"]),
	scope: z.enum(["account", "model", "ip"]).optional(),
});

const Live = z.object({
	model: z.string(),
	limitRequests: z.number().optional(),
	remainingRequests: z.number().optional(),
	limitTokens: z.number().optional(),
	remainingTokens: z.number().optional(),
	resetRequests: z.string().optional(),
	resetTokens: z.string().optional(),
	observedAt: z.string(),
});

const CapacityView = z
	.object({
		providers: z.array(
			z.object({
				provider: z.string(),
				name: z.string(),
				keys: z.number(),
				healthy: z.number(),
				/** Published free-tier limits, per key; empty when the provider publishes none. */
				limits: z.array(Allowance),
				note: z.string().nullable(),
				docsUrl: z.string().nullable(),
				/** Per-day equivalents across healthy keys (minute limits excluded). */
				daily: z.object({ tokens: z.number(), requests: z.number() }),
				usedToday: z.object({ tokens: z.number(), requests: z.number() }),
				/** What the provider's own rate-limit headers said on the last call. */
				live: z.array(Live),
			}),
		),
		totals: z.object({
			tokensPerDay: z.number(),
			requestsPerDay: z.number(),
			tokensUsedToday: z.number(),
			requestsUsedToday: z.number(),
			/** Connected free providers that publish no daily figure. */
			unpublished: z.number(),
		}),
		/** When today's counters started (00:00 UTC). */
		since: z.string(),
	})
	.openapi("AiCapacity");

const keyColumns = {
	id: aiProviderKey.id,
	provider: aiProviderKey.provider,
	label: aiProviderKey.label,
	baseUrl: aiProviderKey.baseUrl,
	enabled: aiProviderKey.enabled,
	status: aiProviderKey.status,
	lastError: aiProviderKey.lastError,
	lastCheckedAt: aiProviderKey.lastCheckedAt,
	models: aiProviderKey.models,
	createdAt: aiProviderKey.createdAt,
};

/** Picks the public columns: full rows carry the encrypted secret. */
function keyView(r: Pick<ProviderKey, keyof typeof keyColumns>) {
	return {
		id: r.id,
		provider: r.provider,
		label: r.label,
		baseUrl: r.baseUrl,
		enabled: r.enabled,
		lastError: r.lastError,
		models: r.models,
		status: r.status as "unknown" | "healthy" | "unhealthy",
		lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
		createdAt: r.createdAt.toISOString(),
	};
}

const defView = (d: AiProviderDef) => ({
	id: d.id,
	name: d.name,
	tier: d.tier,
	keyUrl: d.keyUrl ?? null,
	keyHint: d.keyHint,
	customBaseUrl: d.customBaseUrl ?? false,
	defaultModel: d.defaultModel ?? null,
	keyless: d.keyless ?? false,
});

const isAdmin = (c: Context<Env>) => {
	const actor = requireActor(c);
	return actorCan(actor, "admin", organizationResource(actor.organizationId));
};

async function settingsRow(c: Context<Env>) {
	const orgId = requireActor(c).organizationId;
	const [row] = await c.var.deps.db
		.select()
		.from(aiSettings)
		.where(eq(aiSettings.organizationId, orgId));
	return row ?? { gatewayEnabled: false, autoChain: [] as string[] };
}

async function ownKey(c: Context<Env>, id: string) {
	const [row] = await c.var.deps.db
		.select()
		.from(aiProviderKey)
		.where(
			and(
				eq(aiProviderKey.id, id),
				eq(aiProviderKey.organizationId, requireActor(c).organizationId),
			),
		);
	if (!row) throw new Failure("not_found", "provider key not found");
	return row;
}

const zero = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 });

const ProviderKeyInput = z.object({
	provider: z.enum(aiProviderIds),
	label: z.string().trim().min(1).max(64),
	/** Cloudflare: `account-id:api-token`. Optional for a custom server without auth. */
	key: z.string().trim().max(4096).default(""),
	baseUrl: z
		.url({ protocol: /^https?$/ })
		.max(2048)
		.optional(),
});

export const ai = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/settings",
			tags,
			security,
			summary:
				"AI gateway settings, the provider catalog and the caller's budget",
			middleware: [requirePermission("ai", inOrganization)],
			responses: { 200: json(Settings, "Settings"), ...errors },
		}),
		async (c) => {
			const actor = requireActor(c);
			const { db } = c.var.deps;
			const admin = isAdmin(c);
			const [row, caps, spend] = await Promise.all([
				settingsRow(c),
				capsFor(db, actor.organizationId, actor.userId, admin),
				monthSpend(db, actor.organizationId, actor.userId),
			]);
			const spent = spend.get(actor.userId) ?? { free: 0, paid: 0 };
			return c.json(
				{
					gatewayEnabled: row.gatewayEnabled,
					autoChain: row.autoChain,
					canAdmin: admin,
					providers: aiProviders.map(defView),
					me: {
						caps: {
							free: caps.free === null ? null : usd(caps.free),
							paid: caps.paid === null ? null : usd(caps.paid),
						},
						spent: { free: usd(spent.free), paid: usd(spent.paid) },
					},
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"ai_settings.update",
			createRoute({
				method: "put",
				path: "/ai/settings",
				tags,
				security,
				summary: "Turn the gateway on or off and set the auto chain",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(
					z.object({
						gatewayEnabled: z.boolean().optional(),
						autoChain: z
							.array(z.string().regex(/^[a-z0-9-]+\/.+$/, "provider/model"))
							.max(50)
							.optional(),
					}),
				),
				responses: { 204: { description: "Saved" }, ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const organizationId = requireActor(c).organizationId;
			await c.var.deps.db
				.insert(aiSettings)
				.values({ organizationId, ...input })
				.onConflictDoUpdate({ target: aiSettings.organizationId, set: input });
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/provider-keys",
			tags,
			security,
			summary: "Upstream provider keys (never their secrets)",
			middleware: [requirePermission("admin", inOrganization)],
			responses: { 200: json(z.array(ProviderKeyView), "Keys"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select(keyColumns)
				.from(aiProviderKey)
				.where(eq(aiProviderKey.organizationId, requireActor(c).organizationId))
				.orderBy(asc(aiProviderKey.createdAt));
			return c.json(rows.map(keyView), 200);
		},
	)
	.openapi(
		mutation(
			"ai_provider_key.create",
			createRoute({
				method: "post",
				path: "/ai/provider-keys",
				tags,
				security,
				summary: "Add a provider key and test it",
				description:
					"The key is encrypted at rest and never returned. The response carries the test result and the models the key serves.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(ProviderKeyInput),
				responses: { 201: json(ProviderKeyView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const def = aiProvider(input.provider);
			if (!def) throw new Failure("bad_request", "unknown provider");
			if (def.customBaseUrl && !input.baseUrl)
				throw new Failure("bad_request", "a custom server needs its base URL");
			if (!def.keyless && !input.key)
				throw new Failure("bad_request", `${def.name} needs an API key`);
			if (def.id === "cloudflare" && !/^[^:\s]+:\S+$/.test(input.key))
				throw new Failure(
					"bad_request",
					"Cloudflare keys are `account-id:api-token`",
				);
			const { db, masterKey } = c.var.deps;
			c.set("auditDiff", {
				input: {
					provider: input.provider,
					label: input.label,
					baseUrl: input.baseUrl,
				},
			});
			const row = one(
				await db
					.insert(aiProviderKey)
					.values({
						organizationId: requireActor(c).organizationId,
						provider: input.provider,
						label: input.label,
						baseUrl: def.customBaseUrl ? (input.baseUrl ?? null) : null,
						secretEncrypted: await encrypt(masterKey, input.key),
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(keyView(await testKey(db, masterKey, row)), 201);
		},
	)
	.openapi(
		mutation(
			"ai_provider_key.update",
			createRoute({
				method: "patch",
				path: "/ai/provider-keys/{id}",
				tags,
				security,
				summary: "Rename, enable, disable or replace a provider key",
				middleware: [requirePermission("admin", inOrganization)],
				request: {
					params: IdParam,
					...body(
						z.object({
							label: z.string().trim().min(1).max(64).optional(),
							enabled: z.boolean().optional(),
							key: z.string().trim().min(1).max(4096).optional(),
						}),
					),
				},
				responses: { 200: json(ProviderKeyView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { key, ...rest } = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			await ownKey(c, id);
			c.set("auditResourceId", id);
			c.set("auditDiff", {
				input: { ...rest, keyReplaced: key !== undefined },
			});
			const [row] = await db
				.update(aiProviderKey)
				.set({
					...rest,
					...(key
						? {
								secretEncrypted: await encrypt(masterKey, key),
								status: "unknown",
							}
						: {}),
				})
				.where(eq(aiProviderKey.id, id))
				.returning();
			if (!row) throw new Failure("not_found", "provider key not found");
			return c.json(
				keyView(key ? await testKey(db, masterKey, row) : row),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"ai_provider_key.test",
			createRoute({
				method: "post",
				path: "/ai/provider-keys/{id}/test",
				tags,
				security,
				summary: "Test a provider key and refresh its model list",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 200: json(ProviderKeyView, "Tested"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const { db, masterKey } = c.var.deps;
			return c.json(
				keyView(await testKey(db, masterKey, await ownKey(c, id))),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"ai_provider_key.delete",
			createRoute({
				method: "delete",
				path: "/ai/provider-keys/{id}",
				tags,
				security,
				summary: "Delete a provider key",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			await ownKey(c, id);
			await c.var.deps.db.delete(aiProviderKey).where(eq(aiProviderKey.id, id));
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/capacity",
			tags,
			security,
			summary:
				"Free capacity of the connected providers and how much of it is used today",
			description:
				"Daily figures are the providers' published free tiers, multiplied by healthy keys (each key is assumed to be its own account). `live` is what each provider reported in its rate-limit headers on the last call.",
			middleware: [requirePermission("ai", inOrganization)],
			responses: { 200: json(CapacityView, "Capacity"), ...errors },
		}),
		async (c) => {
			const orgId = requireActor(c).organizationId;
			const { db, config } = c.var.deps;
			const now = new Date();
			const since = new Date(
				Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
			);
			const [keys, used] = await Promise.all([
				db
					.select({
						id: aiProviderKey.id,
						provider: aiProviderKey.provider,
						enabled: aiProviderKey.enabled,
						status: aiProviderKey.status,
					})
					.from(aiProviderKey)
					.where(eq(aiProviderKey.organizationId, orgId)),
				db
					.select({
						provider: aiUsage.provider,
						requests: sql<string>`count(*)`,
						tokens: sql<string>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)`,
					})
					.from(aiUsage)
					.where(
						and(
							eq(aiUsage.organizationId, orgId),
							eq(aiUsage.tier, "free"),
							gte(aiUsage.createdAt, since),
						),
					)
					.groupBy(aiUsage.provider),
			]);
			const redis = redisFor(config.REDIS_URL);
			const providers: z.infer<typeof CapacityView>["providers"] = [];
			for (const def of aiProviders as readonly AiProviderDef[]) {
				if (def.tier !== "free") continue;
				const mine = keys.filter((k) => k.provider === def.id && k.enabled);
				if (!mine.length) continue;
				const healthy = mine.filter((k) => k.status !== "unhealthy").length;
				const limits = def.freeQuota?.limits ?? [];
				const per = dailyAllowance(limits);
				// Anonymous providers count per IP: more keys add nothing.
				const n = def.keyless ? Math.min(healthy, 1) : healthy;
				const live: LiveLimits[] = [];
				for (const k of mine) {
					const hash = (await redis.hgetall(liveKey(k.id))) as Record<
						string,
						string
					> | null;
					for (const v of Object.values(hash ?? {})) {
						try {
							live.push(JSON.parse(v) as LiveLimits);
						} catch {}
					}
				}
				const u = used.find((r) => r.provider === def.id);
				providers.push({
					provider: def.id,
					name: def.name,
					keys: mine.length,
					healthy,
					limits: [...limits],
					note: def.freeQuota?.note ?? null,
					docsUrl: def.freeQuota?.docsUrl ?? null,
					daily: { tokens: per.tokens * n, requests: per.requests * n },
					usedToday: {
						tokens: Number(u?.tokens ?? 0),
						requests: Number(u?.requests ?? 0),
					},
					live,
				});
			}
			const sum = (f: (p: (typeof providers)[number]) => number) =>
				providers.reduce((t, p) => t + f(p), 0);
			return c.json(
				{
					providers,
					totals: {
						tokensPerDay: sum((p) => p.daily.tokens),
						requestsPerDay: sum((p) => p.daily.requests),
						tokensUsedToday: sum((p) => p.usedToday.tokens),
						requestsUsedToday: sum((p) => p.usedToday.requests),
						unpublished: providers.filter(
							(p) => p.daily.tokens === 0 && p.daily.requests === 0,
						).length,
					},
					since: since.toISOString(),
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/models",
			tags,
			security,
			summary: "Models the gateway can route to, with per-token prices",
			middleware: [requirePermission("ai", inOrganization)],
			responses: { 200: json(z.array(ModelView), "Models"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select({
					provider: aiProviderKey.provider,
					models: aiProviderKey.models,
				})
				.from(aiProviderKey)
				.where(
					and(
						eq(aiProviderKey.organizationId, requireActor(c).organizationId),
						eq(aiProviderKey.enabled, true),
					),
				);
			const catalog = await priceCatalog();
			const seen = new Set<string>();
			const out: z.infer<typeof ModelView>[] = [];
			for (const r of rows) {
				const def = aiProvider(r.provider);
				if (!def) continue;
				for (const model of r.models) {
					const id = `${def.id}/${model}`;
					if (seen.has(id)) continue;
					seen.add(id);
					const p = priceFor(catalog, def.catalogId, model);
					out.push({
						id,
						provider: def.id,
						model,
						tier: def.tier,
						price: p ? { input: p.input, output: p.output } : null,
					});
				}
			}
			out.sort((a, b) => a.id.localeCompare(b.id));
			return c.json(out, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/gateway-keys",
			tags,
			security,
			summary: "Gateway keys: your own, or everyone's for admins",
			middleware: [requirePermission("ai", inOrganization)],
			responses: { 200: json(z.array(GatewayKeyView), "Keys"), ...errors },
		}),
		async (c) => {
			const actor = requireActor(c);
			const rows = await c.var.deps.db
				.select({
					id: aiGatewayKey.id,
					name: aiGatewayKey.name,
					start: aiGatewayKey.start,
					userId: aiGatewayKey.userId,
					userName: user.name,
					lastUsedAt: aiGatewayKey.lastUsedAt,
					createdAt: aiGatewayKey.createdAt,
				})
				.from(aiGatewayKey)
				.innerJoin(user, eq(user.id, aiGatewayKey.userId))
				.where(
					and(
						eq(aiGatewayKey.organizationId, actor.organizationId),
						isAdmin(c) ? undefined : eq(aiGatewayKey.userId, actor.userId),
					),
				)
				.orderBy(desc(aiGatewayKey.createdAt));
			return c.json(
				rows.map((r) => ({
					...r,
					lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
					createdAt: r.createdAt.toISOString(),
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"ai_gateway_key.create",
			createRoute({
				method: "post",
				path: "/ai/gateway-keys",
				tags,
				security,
				summary: "Create a gateway key for yourself; the secret is shown once",
				middleware: [requirePermission("ai", inOrganization)],
				request: body(z.object({ name: z.string().trim().min(1).max(64) })),
				responses: {
					201: json(GatewayKeyView.extend({ key: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { name } = c.req.valid("json");
			const actor = requireActor(c);
			const raw = `${AI_KEY_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
			const row = one(
				await c.var.deps.db
					.insert(aiGatewayKey)
					.values({
						organizationId: actor.organizationId,
						userId: actor.userId,
						name,
						start: raw.slice(0, AI_KEY_PREFIX.length + 6),
						hash: hashKey(raw),
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			c.set("auditDiff", { input: { name } });
			const [owner] = await c.var.deps.db
				.select({ name: user.name })
				.from(user)
				.where(eq(user.id, actor.userId));
			return c.json(
				{
					id: row.id,
					name: row.name,
					start: row.start,
					userId: row.userId,
					userName: owner?.name ?? "",
					lastUsedAt: null,
					createdAt: row.createdAt.toISOString(),
					key: raw,
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"ai_gateway_key.delete",
			createRoute({
				method: "delete",
				path: "/ai/gateway-keys/{id}",
				tags,
				security,
				summary: "Revoke a gateway key (your own, or any for admins)",
				middleware: [requirePermission("ai", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Revoked" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const actor = requireActor(c);
			c.set("auditResourceId", id);
			one(
				await c.var.deps.db
					.delete(aiGatewayKey)
					.where(
						and(
							eq(aiGatewayKey.id, id),
							eq(aiGatewayKey.organizationId, actor.organizationId),
							isAdmin(c) ? undefined : eq(aiGatewayKey.userId, actor.userId),
						),
					)
					.returning({ id: aiGatewayKey.id }),
				"gateway key",
			);
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/budgets",
			tags,
			security,
			summary: "Every member's monthly AI caps and spend",
			middleware: [requirePermission("admin", inOrganization)],
			responses: { 200: json(z.array(BudgetView), "Budgets"), ...errors },
		}),
		async (c) => {
			const orgId = requireActor(c).organizationId;
			const { db } = c.var.deps;
			const [members, budgets, spend] = await Promise.all([
				db
					.select({
						userId: member.userId,
						name: user.name,
						email: user.email,
						role: member.role,
					})
					.from(member)
					.innerJoin(user, eq(user.id, member.userId))
					.where(eq(member.organizationId, orgId))
					.orderBy(asc(user.name)),
				db.select().from(aiBudget).where(eq(aiBudget.organizationId, orgId)),
				monthSpend(db, orgId),
			]);
			const org = organizationResource(orgId);
			const out = await Promise.all(
				members.map(async (m) => {
					const grants = (await grantsFor(db, m.userId, m.userId, orgId)) ?? [];
					const who = { id: m.userId };
					const admin = can(who, "admin", org, grants);
					const row = budgets.find((b) => b.userId === m.userId);
					const caps = row
						? { free: row.freeCapMicros, paid: row.paidCapMicros }
						: admin
							? { free: null, paid: null }
							: { free: 0, paid: 0 };
					const s = spend.get(m.userId) ?? { free: 0, paid: 0 };
					return {
						...m,
						hasAi: can(who, "ai", org, grants),
						isAdmin: admin,
						caps: {
							free: caps.free === null ? null : usd(caps.free),
							paid: caps.paid === null ? null : usd(caps.paid),
						},
						inherited: !row,
						spent: { free: usd(s.free), paid: usd(s.paid) },
					};
				}),
			);
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"ai_budget.update",
			createRoute({
				method: "put",
				path: "/ai/budgets/{userId}",
				tags,
				security,
				summary: "Set a member's monthly caps in USD (null = unlimited)",
				middleware: [requirePermission("admin", inOrganization)],
				request: {
					params: z.object({ userId: z.string() }),
					...body(
						z.object({
							free: z.number().min(0).max(1_000_000).nullable(),
							paid: z.number().min(0).max(1_000_000).nullable(),
						}),
					),
				},
				responses: { 204: { description: "Saved" }, ...errors },
			}),
		),
		async (c) => {
			const { userId } = c.req.valid("param");
			const { free, paid } = c.req.valid("json");
			const orgId = requireActor(c).organizationId;
			const { db } = c.var.deps;
			const [m] = await db
				.select({ id: member.id })
				.from(member)
				.where(
					and(eq(member.organizationId, orgId), eq(member.userId, userId)),
				);
			if (!m) throw new Failure("not_found", "member not found");
			c.set("auditResourceId", userId);
			const caps = {
				freeCapMicros: toMicros(free),
				paidCapMicros: toMicros(paid),
			};
			await db
				.insert(aiBudget)
				.values({ organizationId: orgId, userId, ...caps })
				.onConflictDoUpdate({
					target: [aiBudget.organizationId, aiBudget.userId],
					set: caps,
				});
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/usage",
			tags,
			security,
			summary: "Requests, tokens and cost over time; members see their own",
			middleware: [requirePermission("ai", inOrganization)],
			request: {
				query: z.object({
					range: UsageRange.default("7d"),
					userId: z.string().optional(),
				}),
			},
			responses: { 200: json(UsageView, "Usage"), ...errors },
		}),
		async (c) => {
			const { range, userId } = c.req.valid("query");
			const actor = requireActor(c);
			const admin = isAdmin(c);
			// Members only ever see their own calls.
			const who = admin ? userId : actor.userId;
			const { step, ms } = RANGE[range];
			const to = new Date();
			const from = new Date(to.getTime() - ms);
			const where = and(
				eq(aiUsage.organizationId, actor.organizationId),
				who ? eq(aiUsage.userId, who) : undefined,
				gte(aiUsage.createdAt, from),
			);
			const figures = {
				requests: sql<string>`count(*)`,
				inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
				outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
				cost: sql<string>`coalesce(sum(${aiUsage.costMicros}), 0)`,
			};
			const fig = (r: {
				requests: string;
				inputTokens: string;
				outputTokens: string;
				cost: string;
			}) => ({
				requests: Number(r.requests),
				inputTokens: Number(r.inputTokens),
				outputTokens: Number(r.outputTokens),
				cost: usd(Number(r.cost)),
			});
			const bucket = sql<Date>`date_trunc(${sql.raw(`'${step}'`)}, ${aiUsage.createdAt}, 'UTC')`;
			const { db } = c.var.deps;
			const [series, models, members, failed] = await Promise.all([
				db
					.select({ t: bucket, tier: aiUsage.tier, ...figures })
					.from(aiUsage)
					.where(and(where, eq(aiUsage.ok, true)))
					.groupBy(bucket, aiUsage.tier)
					.orderBy(bucket),
				db
					.select({
						provider: aiUsage.provider,
						model: aiUsage.model,
						tier: aiUsage.tier,
						...figures,
					})
					.from(aiUsage)
					.where(and(where, eq(aiUsage.ok, true)))
					.groupBy(aiUsage.provider, aiUsage.model, aiUsage.tier)
					.orderBy(desc(sql`sum(${aiUsage.costMicros})`))
					.limit(50),
				admin
					? db
							.select({
								userId: aiUsage.userId,
								name: user.name,
								tier: aiUsage.tier,
								...figures,
							})
							.from(aiUsage)
							.innerJoin(user, eq(user.id, aiUsage.userId))
							.where(and(where, eq(aiUsage.ok, true)))
							.groupBy(aiUsage.userId, user.name, aiUsage.tier)
					: Promise.resolve([]),
				db.$count(aiUsage, and(where, eq(aiUsage.ok, false))),
			]);
			// Every step in the window, so charts show quiet periods as zeros.
			const keys: string[] = [];
			const cursor = new Date(from);
			const trunc = (d: Date) => {
				const x = new Date(d);
				if (step === "month")
					return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
				x.setUTCMinutes(0, 0, 0);
				if (step === "hour") return x;
				x.setUTCHours(0);
				if (step === "week")
					x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
				return x;
			};
			for (let t = trunc(cursor); t <= to; ) {
				keys.push(t.toISOString());
				if (step === "hour") t = new Date(t.getTime() + 3_600_000);
				else if (step === "day") t = new Date(t.getTime() + 86_400_000);
				else if (step === "week") t = new Date(t.getTime() + 7 * 86_400_000);
				else t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
			}
			const buckets = new Map(
				keys.map((t) => [t, { t, free: zero(), paid: zero() }]),
			);
			const totals = { free: zero(), paid: zero(), errors: failed };
			for (const r of series) {
				const t = new Date(r.t).toISOString();
				const tier = r.tier === "paid" ? "paid" : "free";
				const f = fig(r);
				const b = buckets.get(t) ?? { t, free: zero(), paid: zero() };
				b[tier] = f;
				buckets.set(t, b);
				const tot = totals[tier];
				tot.requests += f.requests;
				tot.inputTokens += f.inputTokens;
				tot.outputTokens += f.outputTokens;
				tot.cost += f.cost;
			}
			const byMember = new Map<
				string,
				{
					userId: string;
					name: string;
					free: ReturnType<typeof zero>;
					paid: ReturnType<typeof zero>;
				}
			>();
			for (const r of members) {
				const m = byMember.get(r.userId) ?? {
					userId: r.userId,
					name: r.name,
					free: zero(),
					paid: zero(),
				};
				m[r.tier === "paid" ? "paid" : "free"] = fig(r);
				byMember.set(r.userId, m);
			}
			return c.json(
				{
					range,
					step,
					from: from.toISOString(),
					to: to.toISOString(),
					buckets: [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t)),
					totals,
					byModel: models.map((r) => ({
						provider: r.provider,
						model: r.model,
						tier: r.tier === "paid" ? ("paid" as const) : ("free" as const),
						...fig(r),
					})),
					byMember: [...byMember.values()].sort(
						(a, b) => b.free.cost + b.paid.cost - (a.free.cost + a.paid.cost),
					),
				},
				200,
			);
		},
	);
