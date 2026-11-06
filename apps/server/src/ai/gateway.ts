import {
	type AiTier,
	type AnthropicRequest,
	AnthropicStreamEncoder,
	anthropicToChat,
	anthropicUsage,
	type ChatRequest,
	type ChatResponse,
	can,
	chatToAnthropic,
	chatToResponses,
	costMicros,
	parseChunk,
	parseModelRef,
	priceFor,
	type ResponsesRequest,
	ResponsesStreamEncoder,
	responsesToChat,
	responsesUsage,
	SseLines,
	type TokenUsage,
	usageOf,
} from "@logistack/core";
import {
	aiGatewayKey,
	aiProviderKey,
	aiSettings,
	aiUsage,
	type Db,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { grantsFor } from "../actor.ts";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { organizationResource } from "../scope.ts";
import { BlockedHostError } from "../ssrf.ts";
import { openTiers } from "./budget.ts";
import { priceCatalog } from "./catalog.ts";
import {
	type Candidate,
	candidates,
	coolDown,
	endpointFor,
	failureText,
	isCooling,
} from "./upstream.ts";

export const AI_KEY_PREFIX = "lsai_";

export const hashKey = (raw: string) =>
	new Bun.CryptoHasher("sha256").update(raw).digest("hex");

type Dialect = "openai" | "anthropic";
type Endpoint = "chat" | "messages" | "responses" | "embeddings";

/** An error in the dialect the client speaks, so its SDK surfaces the message. */
class GatewayError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 429 | 502 | 503,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function errorBody(dialect: Dialect, e: GatewayError) {
	if (dialect === "anthropic") {
		const type =
			e.status === 401
				? "authentication_error"
				: e.status === 403
					? "permission_error"
					: e.status === 404
						? "not_found_error"
						: e.status === 429
							? "rate_limit_error"
							: e.status >= 500
								? "api_error"
								: "invalid_request_error";
		return { type: "error", error: { type, message: e.message } };
	}
	return { error: { message: e.message, type: e.code, code: e.code } };
}

type Caller = {
	organizationId: string;
	userId: string;
	keyId: string;
	isAdmin: boolean;
	autoChain: string[];
};

/** Resolves a gateway key to its member, refusing when the gateway is off or the member lost `ai`. */
async function caller(db: Db, headers: Headers): Promise<Caller> {
	const raw =
		headers.get("x-api-key") ??
		headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
	if (!raw?.startsWith(AI_KEY_PREFIX))
		throw new GatewayError(
			401,
			"invalid_api_key",
			"Missing or invalid LogiStack AI key. Create one on the AI page.",
		);
	const [row] = await db
		.select({
			keyId: aiGatewayKey.id,
			organizationId: aiGatewayKey.organizationId,
			userId: aiGatewayKey.userId,
			enabled: aiSettings.gatewayEnabled,
			autoChain: aiSettings.autoChain,
		})
		.from(aiGatewayKey)
		.leftJoin(
			aiSettings,
			eq(aiSettings.organizationId, aiGatewayKey.organizationId),
		)
		.where(eq(aiGatewayKey.hash, hashKey(raw)));
	if (!row) throw new GatewayError(401, "invalid_api_key", "Unknown AI key.");
	if (!row.enabled)
		throw new GatewayError(
			403,
			"gateway_disabled",
			"The AI gateway is turned off for this organization.",
		);
	const grants = await grantsFor(
		db,
		row.userId,
		row.userId,
		row.organizationId,
	);
	const org = organizationResource(row.organizationId);
	const actor = { id: row.userId };
	if (!grants || !can(actor, "ai", org, grants))
		throw new GatewayError(
			403,
			"permission_denied",
			"This key's owner no longer has the AI permission.",
		);
	return {
		organizationId: row.organizationId,
		userId: row.userId,
		keyId: row.keyId,
		isAdmin: can(actor, "admin", org, grants),
		autoChain: row.autoChain ?? [],
	};
}

type Attempt = { res: Response; cand: Candidate; fallbacks: number };

/** Statuses that say "try elsewhere": rate limits, outages, a bad key, a model this provider lacks. */
const RETRY = new Set([401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 504]);

/** Calls candidates in order until one answers with something other than a retryable failure. */
async function route(
	c: Context<Env>,
	who: Caller,
	model: string,
	path: (cand: Candidate) => string,
	body: (cand: Candidate) => unknown,
	timeoutMs: number,
): Promise<Attempt> {
	const { db, masterKey, config } = c.var.deps;
	const tiers = await openTiers(
		db,
		who.organizationId,
		who.userId,
		who.isAdmin,
	);
	const ref = parseModelRef(model);
	if (ref.kind === "auto") tiers.delete("paid");
	const keys = await db
		.select()
		.from(aiProviderKey)
		.where(eq(aiProviderKey.organizationId, who.organizationId));
	const all = candidates(
		keys,
		ref,
		new Set<AiTier>(["free", "paid"]),
		who.autoChain,
	);
	const list = all.filter((x) => tiers.has(x.tier));
	if (list.length === 0) {
		if (all.length > 0)
			throw new GatewayError(
				429,
				"quota_exceeded",
				"Your monthly AI budget for this model is used up. Ask an admin to raise it.",
			);
		throw new GatewayError(
			404,
			"model_not_found",
			ref.kind === "auto"
				? "No free provider is configured. Add one on the AI page."
				: `No configured provider serves '${model}'. GET /v1/models lists what is available.`,
		);
	}
	const trail: string[] = [];
	let fallbacks = 0;
	for (const cand of list) {
		if (await isCooling(config.REDIS_URL, cand)) continue;
		const label = `${cand.def.id}/${cand.model}`;
		try {
			const { baseUrl, headers } = await endpointFor(
				db,
				masterKey,
				cand.key,
				cand.def,
			);
			// The timeout covers the wait for headers only; a stream may then run as long as it needs.
			const ctl = new AbortController();
			const timer = setTimeout(() => ctl.abort(), timeoutMs);
			const res = await fetch(`${baseUrl}${path(cand)}`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify(body(cand)),
				signal: AbortSignal.any([ctl.signal, c.req.raw.signal]),
			}).finally(() => clearTimeout(timer));
			if (res.ok) return { res, cand, fallbacks };
			if (!RETRY.has(res.status)) return { res, cand, fallbacks };
			const why = await failureText(res);
			trail.push(`${label}: ${why}`);
			if (res.status === 401 || res.status === 403) {
				// A dead key: take it out until someone tests it again.
				await db
					.update(aiProviderKey)
					.set({
						status: "unhealthy",
						lastError: why,
						lastCheckedAt: new Date(),
					})
					.where(eq(aiProviderKey.id, cand.key.id));
			} else if (res.status !== 404) {
				const after = Number(res.headers.get("retry-after"));
				await coolDown(
					config.REDIS_URL,
					cand,
					Number.isFinite(after) && after > 0
						? after
						: res.status === 429
							? 60
							: 30,
				);
			}
		} catch (err) {
			if (c.req.raw.signal.aborted) throw err;
			trail.push(
				`${label}: ${err instanceof BlockedHostError ? err.message : "unreachable"}`,
			);
			await coolDown(config.REDIS_URL, cand, 30);
		}
		fallbacks++;
	}
	log("warn", "ai gateway: every upstream failed", { model, trail });
	throw new GatewayError(
		503,
		"upstream_unavailable",
		`Every provider for '${model}' failed or is rate limited: ${trail.slice(0, 3).join("; ") || "all cooling down"}`,
	);
}

/** Writes the ledger row once; called when a response or stream ends. */
async function record(
	db: Db,
	who: Caller,
	a: Attempt,
	endpoint: Endpoint,
	usage: TokenUsage,
	started: number,
	ok: boolean,
) {
	try {
		const price = priceFor(
			await priceCatalog(),
			a.cand.def.catalogId,
			a.cand.model,
		);
		await db.insert(aiUsage).values({
			organizationId: who.organizationId,
			userId: who.userId,
			gatewayKeyId: who.keyId,
			provider: a.cand.def.id,
			model: a.cand.model,
			tier: a.cand.tier,
			endpoint,
			inputTokens: usage.input,
			outputTokens: usage.output,
			cachedTokens: usage.cached,
			costMicros: ok ? costMicros(price, usage) : 0,
			latencyMs: Date.now() - started,
			fallbacks: a.fallbacks,
			ok,
		});
		await db
			.update(aiGatewayKey)
			.set({ lastUsedAt: new Date() })
			.where(eq(aiGatewayKey.id, who.keyId));
	} catch (err) {
		log("error", "ai usage not recorded", { error: String(err) });
	}
}

/**
 * Pipes an upstream SSE body to the client. With `encode` each payload is re-encoded for the
 * client's dialect; without it bytes pass through untouched. `see` observes every payload.
 */
function relay(
	c: Context<Env>,
	body: ReadableStream<Uint8Array>,
	see: (data: string) => void,
	end: () => void,
	encode?: { push(data: string): string[]; finish(): string[] },
) {
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	const lines = new SseLines();
	let ended = false;
	const once = () => {
		if (ended) return;
		ended = true;
		end();
	};
	c.req.raw.signal.addEventListener("abort", once);
	const out = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, ctl) {
				for (const data of lines.push(dec.decode(chunk, { stream: true }))) {
					see(data);
					if (encode)
						for (const s of encode.push(data)) ctl.enqueue(enc.encode(s));
				}
				if (!encode) ctl.enqueue(chunk);
			},
			flush(ctl) {
				if (encode) for (const s of encode.finish()) ctl.enqueue(enc.encode(s));
				once();
			},
		}),
	);
	return new Response(out, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

function routeHeaders(res: Response, a: Attempt) {
	res.headers.set("x-logistack-route", `${a.cand.def.id}/${a.cand.model}`);
	res.headers.set("x-logistack-fallbacks", String(a.fallbacks));
	return res;
}

/** Chat requests always ask for the usage chunk; we need it to bill. */
function upstreamChat(req: ChatRequest, model: string): ChatRequest {
	return {
		...req,
		model,
		...(req.stream
			? { stream_options: { ...req.stream_options, include_usage: true } }
			: {}),
	};
}

/** A non-2xx the client should see, passed on in its dialect. */
async function upstreamFailure(a: Attempt): Promise<never> {
	throw new GatewayError(
		a.res.status === 400 ? 400 : 502,
		"upstream_error",
		`${a.cand.def.name}: ${await failureText(a.res)}`,
	);
}

const Loose = z.looseObject({ model: z.string().max(300).default("auto") });
const ChatBody = Loose.extend({ messages: z.array(z.unknown()).min(1) });
const MessagesBody = Loose.extend({
	messages: z.array(z.unknown()).min(1),
	max_tokens: z.number().int().positive().optional(),
});
const ResponsesBody = Loose.extend({
	input: z.union([z.string(), z.array(z.unknown())]),
});
const EmbeddingsBody = z.looseObject({
	model: z.string().min(1).max(300),
	input: z.unknown(),
});

async function parse<T extends z.ZodType>(c: Context<Env>, schema: T) {
	const raw = await c.req.json().catch(() => undefined);
	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		throw new GatewayError(
			400,
			"invalid_request",
			`Invalid request body: ${parsed.error.issues[0]?.message ?? "not JSON"}`,
		);
	return parsed.data as z.infer<T>;
}

/** Streams can sit idle while a model thinks; lift Bun's 10 s idle timeout for this request. */
function keepOpen(c: Context<Env>) {
	c.env?.timeout?.(c.req.raw, 0);
}

export const gateway = new Hono<Env>()
	.use(
		"*",
		cors({
			origin: "*",
			allowHeaders: ["*"],
			exposeHeaders: ["x-logistack-route", "x-logistack-fallbacks"],
		}),
	)
	.use(
		"*",
		bodyLimit({
			maxSize: 32 * 1024 * 1024,
			onError: (c) =>
				c.json(
					{ error: { message: "request body too large", code: "too_large" } },
					413,
				),
		}),
	)
	.onError((err, c) => {
		const dialect: Dialect = c.req.path.endsWith("/messages")
			? "anthropic"
			: "openai";
		if (err instanceof GatewayError)
			return c.json(errorBody(dialect, err), err.status);
		log("error", "ai gateway failed", { error: String(err) });
		return c.json(
			errorBody(
				dialect,
				new GatewayError(
					502,
					"gateway_error",
					"The AI gateway failed to reach a provider.",
				),
			),
			502,
		);
	})
	.get("/models", async (c) => {
		const who = await caller(c.var.deps.db, c.req.raw.headers);
		const keys = await c.var.deps.db
			.select({
				provider: aiProviderKey.provider,
				models: aiProviderKey.models,
				enabled: aiProviderKey.enabled,
			})
			.from(aiProviderKey)
			.where(eq(aiProviderKey.organizationId, who.organizationId));
		const ids = new Set<string>(["auto"]);
		for (const k of keys)
			if (k.enabled) for (const m of k.models) ids.add(`${k.provider}/${m}`);
		return c.json({
			object: "list",
			data: [...ids].map((id) => ({
				id,
				object: "model",
				created: 0,
				owned_by: id === "auto" ? "logistack" : id.slice(0, id.indexOf("/")),
			})),
		});
	})
	.post("/chat/completions", async (c) => {
		const { db } = c.var.deps;
		const who = await caller(db, c.req.raw.headers);
		const req = (await parse(c, ChatBody)) as unknown as ChatRequest;
		const started = Date.now();
		const a = await route(
			c,
			who,
			req.model,
			() => "/chat/completions",
			(cand) => upstreamChat(req, cand.model),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		if (!req.stream || !a.res.body) {
			const body = (await a.res.json()) as ChatResponse;
			await record(db, who, a, "chat", usageOf(body.usage), started, true);
			return routeHeaders(c.json(body), a);
		}
		keepOpen(c);
		let usage = usageOf(undefined);
		return routeHeaders(
			relay(
				c,
				a.res.body,
				(data) => {
					const u = parseChunk(data)?.usage;
					if (u) usage = usageOf(u);
				},
				() => void record(db, who, a, "chat", usage, started, true),
			),
			a,
		);
	})
	.post("/messages", async (c) => {
		const { db } = c.var.deps;
		const who = await caller(db, c.req.raw.headers);
		const req = (await parse(c, MessagesBody)) as unknown as AnthropicRequest;
		const native = (cand: Candidate) => cand.def.id === "anthropic";
		const chat = anthropicToChat(req);
		const started = Date.now();
		const a = await route(
			c,
			who,
			req.model,
			(cand) => (native(cand) ? "/messages" : "/chat/completions"),
			(cand) =>
				native(cand)
					? { ...req, model: cand.model, max_tokens: req.max_tokens ?? 4096 }
					: upstreamChat(chat, cand.model),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		const isNative = native(a.cand);
		if (!req.stream || !a.res.body) {
			const body = (await a.res.json()) as Record<string, unknown>;
			if (isNative) {
				await record(
					db,
					who,
					a,
					"messages",
					anthropicUsage((body.usage ?? {}) as object),
					started,
					true,
				);
				return routeHeaders(c.json(body), a);
			}
			const res = body as unknown as ChatResponse;
			await record(db, who, a, "messages", usageOf(res.usage), started, true);
			return routeHeaders(c.json(chatToAnthropic(res, req.model)), a);
		}
		keepOpen(c);
		let usage = usageOf(undefined);
		if (isNative) {
			let input = {};
			return routeHeaders(
				relay(
					c,
					a.res.body,
					(data) => {
						try {
							const ev = JSON.parse(data);
							if (ev.type === "message_start") input = ev.message?.usage ?? {};
							if (ev.type === "message_delta")
								usage = anthropicUsage({ ...input, ...ev.usage });
						} catch {}
					},
					() => void record(db, who, a, "messages", usage, started, true),
				),
				a,
			);
		}
		const enc = new AnthropicStreamEncoder(req.model);
		return routeHeaders(
			relay(
				c,
				a.res.body,
				(data) => {
					const u = parseChunk(data)?.usage;
					if (u) usage = usageOf(u);
				},
				() => void record(db, who, a, "messages", usage, started, true),
				{
					push: (data) => {
						const chunk = parseChunk(data);
						return chunk ? enc.push(chunk) : [];
					},
					finish: () => enc.finish(),
				},
			),
			a,
		);
	})
	.post("/responses", async (c) => {
		const { db } = c.var.deps;
		const who = await caller(db, c.req.raw.headers);
		const req = (await parse(c, ResponsesBody)) as unknown as ResponsesRequest;
		const native = (cand: Candidate) => cand.def.id === "openai";
		const chat = responsesToChat(req);
		const started = Date.now();
		const a = await route(
			c,
			who,
			req.model,
			(cand) => (native(cand) ? "/responses" : "/chat/completions"),
			// Stored responses would live on OpenAI, out of the gateway's reach.
			(cand) =>
				native(cand)
					? { ...req, model: cand.model, store: false }
					: upstreamChat(chat, cand.model),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		const isNative = native(a.cand);
		if (!req.stream || !a.res.body) {
			const body = (await a.res.json()) as Record<string, unknown>;
			if (isNative) {
				await record(
					db,
					who,
					a,
					"responses",
					responsesUsage((body.usage ?? {}) as object),
					started,
					true,
				);
				return routeHeaders(c.json(body), a);
			}
			const res = body as unknown as ChatResponse;
			await record(db, who, a, "responses", usageOf(res.usage), started, true);
			return routeHeaders(c.json(chatToResponses(res, req.model)), a);
		}
		keepOpen(c);
		let usage = usageOf(undefined);
		if (isNative)
			return routeHeaders(
				relay(
					c,
					a.res.body,
					(data) => {
						try {
							const ev = JSON.parse(data);
							if (ev.response?.usage) usage = responsesUsage(ev.response.usage);
						} catch {}
					},
					() => void record(db, who, a, "responses", usage, started, true),
				),
				a,
			);
		const enc = new ResponsesStreamEncoder(req.model);
		return routeHeaders(
			relay(
				c,
				a.res.body,
				(data) => {
					const u = parseChunk(data)?.usage;
					if (u) usage = usageOf(u);
				},
				() => void record(db, who, a, "responses", usage, started, true),
				{
					push: (data) => {
						const chunk = parseChunk(data);
						return chunk ? enc.push(chunk) : [];
					},
					finish: () => enc.finish(),
				},
			),
			a,
		);
	})
	.post("/embeddings", async (c) => {
		const { db } = c.var.deps;
		const who = await caller(db, c.req.raw.headers);
		const req = await parse(c, EmbeddingsBody);
		if (parseModelRef(req.model).kind === "auto")
			throw new GatewayError(
				400,
				"invalid_request",
				"Embeddings need an explicit model; vectors from different models don't mix.",
			);
		const started = Date.now();
		const a = await route(
			c,
			who,
			req.model,
			() => "/embeddings",
			(cand) => ({ ...req, model: cand.model }),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		const body = (await a.res.json()) as { usage?: { prompt_tokens?: number } };
		await record(
			db,
			who,
			a,
			"embeddings",
			{ input: body.usage?.prompt_tokens ?? 0, output: 0, cached: 0 },
			started,
			true,
		);
		return routeHeaders(c.json(body), a);
	});
