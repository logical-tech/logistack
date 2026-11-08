import type { AiAgentPart } from "@logistack/contracts";
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";

const org = () =>
	text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" });

const owner = () =>
	text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

/** Gateway on/off and the free `auto` chain, one row per organization. */
export const aiSettings = pgTable("ai_settings", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	gatewayEnabled: boolean("gateway_enabled").notNull().default(false),
	/** `provider/model` refs `auto` tries in order; empty means each provider's default model. */
	autoChain: jsonb("auto_chain").$type<string[]>().notNull().default([]),
	...timestamps,
});

/** An upstream credential. Several per provider rotate and fail over. */
export const aiProviderKey = pgTable(
	"ai_provider_key",
	{
		id: id("aik"),
		organizationId: org(),
		/** An id from `aiProviders` in @logistack/core. */
		provider: text("provider").notNull(),
		label: text("label").notNull(),
		secretEncrypted: text("secret_encrypted").notNull(),
		/** Only for the `custom` provider. */
		baseUrl: text("base_url"),
		enabled: boolean("enabled").notNull().default(true),
		/** `unknown` until tested, then `healthy` or `unhealthy`. */
		status: text("status").notNull().default("unknown"),
		lastError: text("last_error"),
		lastCheckedAt: tstz("last_checked_at"),
		/** Model ids the key's `/models` listed at its last test, already filtered to its tier. */
		models: jsonb("models").$type<string[]>().notNull().default([]),
		...timestamps,
	},
	(t) => [index("ai_provider_key_org_idx").on(t.organizationId)],
);

/** A member's key for the gateway. Only its SHA-256 is stored. */
export const aiGatewayKey = pgTable(
	"ai_gateway_key",
	{
		id: id("agk"),
		organizationId: org(),
		userId: owner(),
		name: text("name").notNull(),
		/** First characters, shown so people can tell keys apart. */
		start: text("start").notNull(),
		hash: text("hash").notNull().unique(),
		lastUsedAt: tstz("last_used_at"),
		...timestamps,
	},
	(t) => [index("ai_gateway_key_org_idx").on(t.organizationId)],
);

/** Monthly caps in micro-dollars; null is unlimited. A member without a row may spend nothing. */
export const aiBudget = pgTable(
	"ai_budget",
	{
		id: id("aib"),
		organizationId: org(),
		userId: owner(),
		freeCapMicros: bigint("free_cap_micros", { mode: "number" }),
		paidCapMicros: bigint("paid_cap_micros", { mode: "number" }),
		...timestamps,
	},
	(t) => [unique("ai_budget_member_unique").on(t.organizationId, t.userId)],
);

/** One row per gateway call, the ledger behind budgets and stats. */
export const aiUsage = pgTable(
	"ai_usage",
	{
		id: id("aiu"),
		organizationId: org(),
		userId: owner(),
		gatewayKeyId: text("gateway_key_id").references(() => aiGatewayKey.id, {
			onDelete: "set null",
		}),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		/** `free` or `paid`: which cap the cost counts against. */
		tier: text("tier").notNull(),
		/** `chat`, `messages`, `responses` or `embeddings`. */
		endpoint: text("endpoint").notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cachedTokens: integer("cached_tokens").notNull().default(0),
		/** Real cost for paid calls, market-equivalent cost for free ones. */
		costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
		latencyMs: integer("latency_ms").notNull().default(0),
		/** Upstreams tried before this one answered. */
		fallbacks: integer("fallbacks").notNull().default(0),
		ok: boolean("ok").notNull().default(true),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("ai_usage_org_time_idx").on(t.organizationId, t.createdAt),
		index("ai_usage_user_time_idx").on(t.organizationId, t.userId, t.createdAt),
	],
);

/** A member's conversation with the Agent. The run lives in the api process; this row survives it. */
export const aiAgentConversation = pgTable(
	"ai_agent_conversation",
	{
		id: id("aac"),
		organizationId: org(),
		userId: owner(),
		title: text("title").notNull(),
		/** A gateway model ref: `auto` or `provider/model`. */
		model: text("model").notNull().default("auto"),
		/** `idle`, `running`, `waiting` (an operation awaits approval) or `failed`. */
		status: text("status").notNull().default("idle"),
		error: text("error"),
		/** Set by Stop; the run checks it between chunks and tool calls. */
		stopRequested: boolean("stop_requested").notNull().default(false),
		...timestamps,
	},
	(t) => [
		index("ai_agent_conversation_user_idx").on(
			t.organizationId,
			t.userId,
			t.updatedAt,
		),
	],
);

/** One message; `parts` follow the AI SDK UIMessage part shapes (`AiAgentPart` in contracts). */
export const aiAgentMessage = pgTable(
	"ai_agent_message",
	{
		id: id("aam"),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => aiAgentConversation.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		parts: jsonb("parts").$type<AiAgentPart[]>().notNull().default([]),
		model: text("model"),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		/** False while the assistant is still writing it. */
		done: boolean("done").notNull().default(true),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [index("ai_agent_message_conv_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Cost held for a gateway call in flight: checked and inserted under the member's lock, replaced by
 * its `ai_usage` row when the call ends. A crashed call's hold lapses at `expires_at`.
 */
export const aiBudgetReservation = pgTable(
	"ai_budget_reservation",
	{
		id: id("air"),
		organizationId: org(),
		userId: owner(),
		tier: text("tier").notNull(),
		micros: bigint("micros", { mode: "number" }).notNull(),
		expiresAt: tstz("expires_at").notNull(),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("ai_budget_reservation_member_idx").on(t.organizationId, t.userId),
	],
);
