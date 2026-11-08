import {
	type EventEnvelope,
	type PermissionAction,
	PLUGIN_HEADERS,
	PluginManifest,
	type PluginManifestInput,
	PluginUserClaims,
} from "@logistack/contracts";
import { Hono, type MiddlewareHandler } from "hono";

// @logistack/plugin-sdk: the plugin side of the contract in docs/plans/plugins.md.
// shortcut: imports types from the private @logistack/contracts workspace; bundle them in before publishing to npm.

export type { EventEnvelope, PluginManifest, PluginUserClaims };

/** Checks and fills a manifest; use the result for the image label and for `createPlugin`. */
export const defineManifest = (m: PluginManifestInput): PluginManifest =>
	PluginManifest.parse(m);

/** Requests whose timestamp is further than this from our clock are refused (replays). */
export const REPLAY_WINDOW_S = 300;

const enc = new TextEncoder();

async function hmacHex(key: string, data: string): Promise<string> {
	const k = await crypto.subtle.importKey(
		"raw",
		enc.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", k, enc.encode(data)),
	);
	return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The signature LogiStack sends: HMAC-SHA256 over `<timestamp>.<user claims>\n<body>` (claims only on page requests). */
export async function sign(
	secret: string,
	timestamp: number,
	body: string,
	user?: string | null,
): Promise<string> {
	const payload = user ? `${user}\n${body}` : body;
	return `sha256=${await hmacHex(secret, `${timestamp}.${payload}`)}`;
}

/** True when the request came from LogiStack: valid signature, fresh timestamp. */
export async function verifyRequest(
	secret: string,
	headers: Headers,
	body: string,
	nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	const sig = headers.get(PLUGIN_HEADERS.signature);
	const ts = Number(headers.get(PLUGIN_HEADERS.timestamp));
	if (!sig || !Number.isInteger(ts)) return false;
	if (Math.abs(nowS - ts) > REPLAY_WINDOW_S) return false;
	return safeEqual(
		sig,
		await sign(secret, ts, body, headers.get(PLUGIN_HEADERS.user)),
	);
}

/** A small client for the LogiStack API, with the plugin's own scoped token. */
export type LogiStack = {
	/** `fetch` against `<LOGISTACK_URL>/api<path>` with the plugin's key; throws on non-2xx. */
	request<T = unknown>(path: string, init?: RequestInit): Promise<T>;
	/** The install's settings, secrets in clear; cached for 30 s. */
	config<T = Record<string, unknown>>(): Promise<T>;
};

export function logistackClient(opts: {
	url: string;
	token: string;
	fetch?: typeof fetch;
}): LogiStack {
	const f = opts.fetch ?? fetch;
	let cached: { at: number; value: Record<string, unknown> } | undefined;
	const request = async <T>(path: string, init: RequestInit = {}) => {
		const res = await f(`${opts.url.replace(/\/+$/, "")}/api${path}`, {
			...init,
			headers: {
				"content-type": "application/json",
				...(init.headers as Record<string, string>),
				"x-api-key": opts.token,
			},
		});
		const text = await res.text();
		if (!res.ok)
			throw new Error(
				`LogiStack answered ${res.status}: ${text.slice(0, 300)}`,
			);
		return (text ? JSON.parse(text) : undefined) as T;
	};
	return {
		request,
		async config<T>() {
			if (!cached || Date.now() - cached.at > 30_000)
				cached = {
					at: Date.now(),
					value: (
						await request<{ config: Record<string, unknown> }>("/plugins/self")
					).config,
				};
			return cached.value as T;
		},
	};
}

export type PluginContext = { logistack: LogiStack; installId: string };

export type PluginHandlers = {
	manifest: PluginManifest;
	/** Each subscribed event, once per delivery; throw to have LogiStack retry it. */
	onEvent?: (
		event: EventEnvelope,
		ctx: PluginContext,
	) => unknown | Promise<unknown>;
	/** "Test connection" in the install wizard; return an error message to refuse. */
	validateConfig?: (
		config: Record<string, unknown>,
	) => string | undefined | Promise<string | undefined>;
	/** Named operations from `contributes.tools`. */
	tools?: Record<
		string,
		(input: unknown, ctx: PluginContext) => unknown | Promise<unknown>
	>;
	/**
	 * Your pages and their backend, mounted at `/ui`. Requests under `/ui/api` are verified and
	 * carry the viewer in `c.get("user")`.
	 */
	ui?: Hono<PluginEnv>;
	/** Defaults from `LOGISTACK_URL`, `LOGISTACK_TOKEN`, `LOGISTACK_SIGNING_SECRET`, `LOGISTACK_INSTALL_ID`. */
	env?: Partial<Record<string, string | undefined>>;
};

export type PluginEnv = {
	Variables: { user: PluginUserClaims; ctx: PluginContext };
};

/** Refuses a page request unless the viewer holds `action` on the page's context. */
export const requirePermission =
	(action: PermissionAction): MiddlewareHandler<PluginEnv> =>
	async (c, next) => {
		if (!c.get("user")?.permissions.includes(action))
			return c.json({ error: `missing permission '${action}'` }, 403);
		await next();
	};

/**
 * The plugin's HTTP app. Serve it with `Bun.serve({ port: manifest.port, fetch: app.fetch })`
 * or any runtime that speaks `fetch`.
 */
export function createPlugin(h: PluginHandlers): Hono<PluginEnv> {
	// Read per request, so `logistack-plugin dev` and tests can set credentials after start.
	const env = () => h.env ?? process.env;
	let memo: { key: string; ctx: PluginContext } | undefined;
	const context = (): PluginContext => {
		const e = env();
		const key = `${e.LOGISTACK_URL}|${e.LOGISTACK_TOKEN}|${e.LOGISTACK_INSTALL_ID}`;
		if (memo?.key !== key)
			memo = {
				key,
				ctx: {
					installId: e.LOGISTACK_INSTALL_ID ?? "",
					logistack: logistackClient({
						url: e.LOGISTACK_URL ?? "http://localhost:3000",
						token: e.LOGISTACK_TOKEN ?? "",
					}),
				},
			};
		return memo.ctx;
	};
	const app = new Hono<PluginEnv>();

	// The manifest is public: LogiStack reads it before installing a dev-URL plugin.
	app.get("/v1/manifest", (c) => c.json(h.manifest));

	const signed: MiddlewareHandler<PluginEnv> = async (c, next) => {
		const secret = env().LOGISTACK_SIGNING_SECRET;
		if (!secret)
			return c.json({ error: "LOGISTACK_SIGNING_SECRET is not set" }, 500);
		const body = await c.req.raw.clone().text();
		if (!(await verifyRequest(secret, c.req.raw.headers, body)))
			return c.json({ error: "bad signature" }, 401);
		c.set("ctx", context());
		const user = c.req.header(PLUGIN_HEADERS.user);
		if (user) {
			const claims = PluginUserClaims.safeParse(JSON.parse(user));
			if (claims.success) c.set("user", claims.data);
		}
		await next();
	};

	app.use("/v1/*", async (c, next) =>
		c.req.path === "/v1/manifest" ? next() : signed(c, next),
	);
	app.get("/v1/health", (c) => c.json({ ok: true }));
	app.post("/v1/events", async (c) => {
		const { event } = await c.req.json<{ event: EventEnvelope }>();
		await h.onEvent?.(event, context());
		return c.json({ ok: true });
	});
	if (h.validateConfig) {
		const validate = h.validateConfig;
		app.post("/v1/config/validate", async (c) => {
			const { config } = await c.req.json<{
				config: Record<string, unknown>;
			}>();
			const error = await validate(config);
			return c.json(error ? { ok: false, error } : { ok: true });
		});
	}
	app.post("/v1/tools/:name", async (c) => {
		const tool = h.tools?.[c.req.param("name")];
		if (!tool) return c.json({ error: "no such tool" }, 404);
		const { input } = await c.req.json<{ input: unknown }>();
		return c.json({ output: (await tool(input, context())) ?? null });
	});

	app.use("/ui/api/*", signed);
	app.use("/ui/api/*", async (c, next) => {
		if (!c.get("user")) return c.json({ error: "no viewer" }, 401);
		await next();
	});
	if (h.ui) app.route("/ui", h.ui);
	return app;
}
