import { PLUGIN_HEADERS } from "@logistack/contracts";
import { pluginInstall } from "@logistack/db";
import { pluginHeaders } from "@logistack/providers";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { devFetch, pluginTarget, verifySession } from "./plugins.ts";

// Plugin pages (docs/plans/plugins.md, "UI pages"): `/plugins/{installId}/ui/*` is proxied to
// the plugin's `/ui/*`. Every response runs in an opaque origin (CSP sandbox), so a page cannot
// read our cookies, storage or DOM even when opened directly in a tab. Requests under `/ui/api/`
// must carry the page's session token; the proxy verifies it and forwards the claims, signed.

/** Forces an opaque origin whatever the plugin sends, and keeps it embeddable by us only. */
export const PAGE_CSP =
	"sandbox allow-scripts allow-forms; frame-ancestors 'self'";

/** Request headers never forwarded: our credentials, and anything that would pass as ours. */
const DROP_REQUEST = new Set([
	"cookie",
	"authorization",
	"x-api-key",
	"host",
	"connection",
	"content-length",
	"accept-encoding",
	PLUGIN_HEADERS.session,
	PLUGIN_HEADERS.user,
	PLUGIN_HEADERS.signature,
	PLUGIN_HEADERS.timestamp,
	PLUGIN_HEADERS.install,
]);

/** Response headers never passed back: cookies, and framing or security policy we set ourselves. */
const DROP_RESPONSE = new Set([
	"set-cookie",
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
	"access-control-allow-origin",
	"access-control-allow-credentials",
	"strict-transport-security",
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
]);

const MAX_BODY = 1024 * 1024;

const cors = {
	// Pages have an opaque origin (`null`); the token, not a cookie, authenticates, so `*` is safe.
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	"access-control-allow-headers": `content-type, ${PLUGIN_HEADERS.session}`,
	"access-control-max-age": "600",
};

const failure = (status: number, message: string, api: boolean) =>
	new Response(message, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"content-security-policy": PAGE_CSP,
			"x-content-type-options": "nosniff",
			...(api ? cors : {}),
		},
	});

export const pluginProxy = new Hono<Env>().all(
	"/:installId/ui/*",
	async (c) => {
		const { db, masterKey, config } = c.var.deps;
		const installId = c.req.param("installId");
		const url = new URL(c.req.url);
		const rest = url.pathname.slice(`/plugins/${installId}`.length);
		const api = rest === "/ui/api" || rest.startsWith("/ui/api/");
		if (api && c.req.method === "OPTIONS")
			return new Response(null, { status: 204, headers: cors });
		if (!api && c.req.method !== "GET" && c.req.method !== "HEAD")
			return failure(405, "pages are read-only; call /ui/api/", api);

		const [row] = await db
			.select()
			.from(pluginInstall)
			.where(eq(pluginInstall.id, installId));
		if (!row?.enabled) return failure(404, "no such plugin page", api);

		let user: string | undefined;
		if (api) {
			const token = c.req.header(PLUGIN_HEADERS.session) ?? "";
			const claims = await verifySession(
				config.BETTER_AUTH_SECRET,
				token,
				installId,
			);
			if (!claims)
				return failure(401, "the session token is invalid or expired", api);
			user = JSON.stringify(claims);
		}

		let body = "";
		if (c.req.method !== "GET" && c.req.method !== "HEAD") {
			const buf = await c.req.arrayBuffer();
			if (buf.byteLength > MAX_BODY)
				return failure(413, "request body too large", api);
			body = new TextDecoder().decode(buf);
		}

		const target = await pluginTarget({ masterKey }, row);
		const headers = new Headers();
		for (const [k, v] of c.req.raw.headers)
			if (!DROP_REQUEST.has(k.toLowerCase())) headers.set(k, v);
		for (const [k, v] of Object.entries(
			await pluginHeaders(target, body, user),
		))
			headers.set(k, v);

		const f = row.devUrl ? await devFetch(db) : fetch;
		let res: Response;
		try {
			res = await f(`${target.baseUrl}${rest}${url.search}`, {
				method: c.req.method,
				headers,
				...(body ? { body } : {}),
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch (e) {
			log("warn", "plugin page request failed", {
				installId,
				error: e instanceof Error ? e.message : String(e),
			});
			return failure(502, "the plugin did not answer", api);
		}

		const out = new Headers();
		for (const [k, v] of res.headers)
			if (!DROP_RESPONSE.has(k.toLowerCase())) out.set(k, v);
		// A redirect may only stay inside the plugin's own pages.
		const location = res.headers.get("location");
		if (location) {
			const to = new URL(location, `${target.baseUrl}${rest}`);
			if (`${to.protocol}//${to.host}` !== new URL(target.baseUrl).origin)
				out.delete("location");
			else
				out.set("location", `/plugins/${installId}${to.pathname}${to.search}`);
		}
		out.set("content-security-policy", PAGE_CSP);
		out.set("x-content-type-options", "nosniff");
		out.set("referrer-policy", "no-referrer");
		if (api) for (const [k, v] of Object.entries(cors)) out.set(k, v);
		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers: out,
		});
	},
);
