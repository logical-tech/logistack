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
	classifyFailure,
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
import { openTiers, reserve, settle } from "./budget.ts";
import { priceCatalog } from "./catalog.ts";
import {
	backOff,
	type Candidate,
	candidates,
	coolDown,
	endpointFor,
	failureText,
	isCooling,
	observeLimits,
	recovered,
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
	/** Null for in-process calls (the Agent), which use no key. */
	keyId: string | null;
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
	return member(
		db,
		row.organizationId,
		row.userId,
		row.keyId,
		row.autoChain ?? [],
	);
}

async function member(
	db: Db,
	organizationId: string,
	userId: string,
	keyId: string | null,
	autoChain: string[],
): Promise<Caller> {
	const grants = await grantsFor(db, userId, userId, organizationId);
	const org = organizationResource(organizationId);
	const actor = { id: userId };
	if (!grants || !can(actor, "ai", org, grants))
		throw new GatewayError(
			403,
			"permission_denied",
			keyId
				? "This key's owner no longer has the AI permission."
				: "Your role no longer includes the AI permission.",
		);
	return {
		organizationId,
		userId,
		keyId,
		isAdmin: can(actor, "admin", org, grants),
		autoChain,
	};
}

/** One-time tokens of requests the api makes to the gateway in-process, mapped to their member. */
const inProcess = new Map<string, Caller>();
const IN_PROCESS_HEADER = "x-logistack-member";

/**
 * Marks `req` as made by a member without a gateway key: budgets, the `ai` permission and the
 * ledger apply as for a key; the gateway switch does not, since nothing is exposed. The token is
 * random, lives only in this process and works once.
 */
export async function asMember(
	db: Db,
	organizationId: string,
	userId: string,
	req: Request,
): Promise<Request> {
	const [row] = await db
		.select({ autoChain: aiSettings.autoChain })
		.from(aiSettings)
		.where(eq(aiSettings.organizationId, organizationId));
	const token = crypto.randomUUID();
	inProcess.set(
		token,
		await member(db, organizationId, userId, null, row?.autoChain ?? []),
	);
	setTimeout(() => inProcess.delete(token), 60_000).unref();
	req.headers.set(IN_PROCESS_HEADER, token);
	return req;
}

function callerOf(c: Context<Env>) {
	const token = c.req.header(IN_PROCESS_HEADER);
	const who = token ? inProcess.get(token) : undefined;
	if (token) inProcess.delete(token);
	return who ?? caller(c.var.deps.db, c.req.raw.headers);
}

/** `reservation` holds the call's estimated cost until `record` settles it. */
type Attempt = {
	res: Response;
	cand: Candidate;
	fallbacks: number;
	reservation?: string;
};

/** Output a call may produce when it names no limit; used only to size the budget hold. */
const DEFAULT_OUTPUT_TOKENS = 4096;

/** The most this call can cost: its prompt at about 4 bytes a token, plus its output ceiling. */
async function estimate(cand: Candidate, payload: string, embeddings: boolean) {
	const parsed = JSON.parse(payload) as Record<string, unknown>;
	const limit = [
		parsed.max_tokens,
		parsed.max_completion_tokens,
		parsed.max_output_tokens,
	].find((v): v is number => typeof v === "number");
	const price = priceFor(await priceCatalog(), cand.def.catalogId, cand.model);
	return costMicros(price, {
		input: Math.ceil(payload.length / 4),
		output: embeddings ? 0 : (limit ?? DEFAULT_OUTPUT_TOKENS),
		cached: 0,
	});
}

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
	let overBudget = 0;
	for (const cand of list) {
		if (await isCooling(config.REDIS_URL, cand)) continue;
		const label = `${cand.def.id}/${cand.model}`;
		const payload = JSON.stringify(body(cand));
		// Held before the call so racing calls cannot all pass the cap; `record` settles it.
		const reservation = await reserve(
			db,
			who,
			cand.tier,
			await estimate(cand, payload, path(cand).includes("embeddings")),
		);
		if (!reservation) {
			overBudget++;
			continue;
		}
		const release = () =>
			settle(db, reservation, who).catch((error: unknown) =>
				log("error", "ai budget hold not released", { error: String(error) }),
			);
		try {
			const { baseUrl, headers, fetch } = await endpointFor(
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
				body: payload,
				signal: AbortSignal.any([ctl.signal, c.req.raw.signal]),
			}).finally(() => clearTimeout(timer));
			void observeLimits(config.REDIS_URL, cand, res.headers).catch(() => {});
			if (res.ok) {
				void recovered(config.REDIS_URL, cand).catch(() => {});
				return { res, cand, fallbacks, reservation };
			}
			const why = await failureText(res);
			await release();
			const kind = classifyFailure(res.status, why);
			// The client's own mistake: every provider would refuse it, so say so now.
			if (kind === "request")
				return {
					res: new Response(why, { status: res.status }),
					cand,
					fallbacks,
				};
			trail.push(`${label}: ${why}`);
			if (kind === "auth")
				// A dead key: take it out until someone tests it again.
				await db
					.update(aiProviderKey)
					.set({
						status: "unhealthy",
						lastError: why,
						lastCheckedAt: new Date(),
					})
					.where(eq(aiProviderKey.id, cand.key.id));
			else if (kind === "quota")
				await backOff(config.REDIS_URL, cand, res.headers);
			else if (kind === "transient") await coolDown(config.REDIS_URL, cand, 30);
		} catch (err) {
			await release();
			if (c.req.raw.signal.aborted) throw err;
			trail.push(
				`${label}: ${err instanceof BlockedHostError ? err.message : "unreachable"}`,
			);
			await coolDown(config.REDIS_URL, cand, 30);
		}
		fallbacks++;
	}
	if (overBudget > 0 && trail.length === 0)
		throw new GatewayError(
			429,
			"quota_exceeded",
			"Your monthly AI budget for this model is used up, counting calls still running. Ask an admin to raise it.",
		);
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
	/** Request and response sizes, for providers that report no usage: about 4 bytes a token. */
	bytes?: { req: number; res: number },
) {
	try {
		if (bytes && usage.input === 0 && usage.output === 0)
			usage = {
				input: Math.ceil(bytes.req / 4),
				output: Math.ceil(bytes.res / 4),
				cached: 0,
			};
		const price = priceFor(
			await priceCatalog(),
			a.cand.def.catalogId,
			a.cand.model,
		);
		const row = {
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
		};
		if (a.reservation) await settle(db, a.reservation, who, row);
		else await db.insert(aiUsage).values(row);
		if (who.keyId)
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
	end: (bytes: number) => void,
	encode?: { push(data: string): string[]; finish(): string[] },
) {
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	const lines = new SseLines();
	let ended = false;
	let seen = 0;
	const once = () => {
		if (ended) return;
		ended = true;
		end(seen);
	};
	c.req.raw.signal.addEventListener("abort", once);
	const out = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, ctl) {
				for (const data of lines.push(dec.decode(chunk, { stream: true }))) {
					seen += data.length;
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

/** JSON Schema keywords some providers refuse inside tool parameters. */
const STRICT_KEYS = new Set(["additionalProperties", "$schema"]);

function plainSchema(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(plainSchema);
	if (!v || typeof v !== "object") return v;
	return Object.fromEntries(
		Object.entries(v)
			.filter(([k]) => !STRICT_KEYS.has(k))
			.map(([k, x]) => [k, plainSchema(x)]),
	);
}

/** The body sent upstream: the routed model, the usage chunk on streams (we bill from it), provider quirks. */
function upstreamChat(req: ChatRequest, cand: Candidate): ChatRequest {
	return {
		...req,
		model: cand.model,
		...(req.stream
			? { stream_options: { ...req.stream_options, include_usage: true } }
			: {}),
		...(cand.def.plainToolSchemas && req.tools
			? {
					tools: req.tools.map((t) => ({
						...t,
						function: {
							...t.function,
							parameters: plainSchema(t.function.parameters),
						},
					})),
				}
			: {}),
	};
}

/** A request every provider would refuse, passed on in the client's dialect. */
async function upstreamFailure(a: Attempt): Promise<never> {
	throw new GatewayError(
		400,
		"upstream_error",
		`${a.cand.def.name}: ${await a.res.text()}`,
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
		const who = await callerOf(c);
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
		const who = await callerOf(c);
		const req = (await parse(c, ChatBody)) as unknown as ChatRequest;
		const started = Date.now();
		const reqBytes = JSON.stringify(req).length;
		const a = await route(
			c,
			who,
			req.model,
			() => "/chat/completions",
			(cand) => upstreamChat(req, cand),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		if (!req.stream || !a.res.body) {
			const raw = await a.res.text();
			const body = JSON.parse(raw) as ChatResponse;
			await record(db, who, a, "chat", usageOf(body.usage), started, true, {
				req: reqBytes,
				res: raw.length,
			});
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
				(res) =>
					void record(db, who, a, "chat", usage, started, true, {
						req: reqBytes,
						res,
					}),
			),
			a,
		);
	})
	.post("/messages", async (c) => {
		const { db } = c.var.deps;
		const who = await callerOf(c);
		const req = (await parse(c, MessagesBody)) as unknown as AnthropicRequest;
		const native = (cand: Candidate) => cand.def.id === "anthropic";
		const chat = anthropicToChat(req);
		const started = Date.now();
		const reqBytes = JSON.stringify(req).length;
		const a = await route(
			c,
			who,
			req.model,
			(cand) => (native(cand) ? "/messages" : "/chat/completions"),
			(cand) =>
				native(cand)
					? { ...req, model: cand.model, max_tokens: req.max_tokens ?? 4096 }
					: upstreamChat(chat, cand),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		const isNative = native(a.cand);
		if (!req.stream || !a.res.body) {
			const raw = await a.res.text();
			const body = JSON.parse(raw) as Record<string, unknown>;
			if (isNative) {
				await record(
					db,
					who,
					a,
					"messages",
					anthropicUsage((body.usage ?? {}) as object),
					started,
					true,
					{ req: reqBytes, res: raw.length },
				);
				return routeHeaders(c.json(body), a);
			}
			const res = body as unknown as ChatResponse;
			await record(db, who, a, "messages", usageOf(res.usage), started, true, {
				req: reqBytes,
				res: raw.length,
			});
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
					(res) =>
						void record(db, who, a, "messages", usage, started, true, {
							req: reqBytes,
							res,
						}),
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
				(res) =>
					void record(db, who, a, "messages", usage, started, true, {
						req: reqBytes,
						res,
					}),
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
		const who = await callerOf(c);
		const req = (await parse(c, ResponsesBody)) as unknown as ResponsesRequest;
		const native = (cand: Candidate) => cand.def.id === "openai";
		const chat = responsesToChat(req);
		const started = Date.now();
		const reqBytes = JSON.stringify(req).length;
		const a = await route(
			c,
			who,
			req.model,
			(cand) => (native(cand) ? "/responses" : "/chat/completions"),
			// Stored responses would live on OpenAI, out of the gateway's reach.
			(cand) =>
				native(cand)
					? { ...req, model: cand.model, store: false }
					: upstreamChat(chat, cand),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		const isNative = native(a.cand);
		if (!req.stream || !a.res.body) {
			const raw = await a.res.text();
			const body = JSON.parse(raw) as Record<string, unknown>;
			if (isNative) {
				await record(
					db,
					who,
					a,
					"responses",
					responsesUsage((body.usage ?? {}) as object),
					started,
					true,
					{ req: reqBytes, res: raw.length },
				);
				return routeHeaders(c.json(body), a);
			}
			const res = body as unknown as ChatResponse;
			await record(db, who, a, "responses", usageOf(res.usage), started, true, {
				req: reqBytes,
				res: raw.length,
			});
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
					(res) =>
						void record(db, who, a, "responses", usage, started, true, {
							req: reqBytes,
							res,
						}),
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
				(res) =>
					void record(db, who, a, "responses", usage, started, true, {
						req: reqBytes,
						res,
					}),
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
		const who = await callerOf(c);
		const req = await parse(c, EmbeddingsBody);
		if (parseModelRef(req.model).kind === "auto")
			throw new GatewayError(
				400,
				"invalid_request",
				"Embeddings need an explicit model; vectors from different models don't mix.",
			);
		const started = Date.now();
		const reqBytes = JSON.stringify(req).length;
		const a = await route(
			c,
			who,
			req.model,
			() => "/embeddings",
			(cand) => ({ ...req, model: cand.model }),
			60_000,
		);
		if (!a.res.ok) return upstreamFailure(a);
		const raw = await a.res.text();
		const body = JSON.parse(raw) as { usage?: { prompt_tokens?: number } };
		await record(
			db,
			who,
			a,
			"embeddings",
			{ input: body.usage?.prompt_tokens ?? 0, output: 0, cached: 0 },
			started,
			true,
			{ req: reqBytes, res: raw.length },
		);
		return routeHeaders(c.json(body), a);
	});
