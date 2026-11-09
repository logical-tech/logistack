import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AGENT_WS_PATH } from "@logistack/contracts";
import { Scalar } from "@scalar/hono-api-reference";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { acmeProxy } from "./acme-proxy.ts";
import { type Actor, authenticate } from "./actor.ts";
import { gateway } from "./ai/gateway.ts";
import { assertMutationsAudited } from "./audit.ts";
import { apiKeyFrom, trustedOrigins } from "./auth.ts";
import type { Deps, Env } from "./env.ts";
import { Failure, onError, validationHook } from "./errors.ts";
import { terminal } from "./exec-ws.ts";
import { requestLogger } from "./log.ts";
import { mcpHandler } from "./mcp.ts";
import { pluginProxy } from "./plugin-proxy.ts";
import { limitCredentials } from "./rate-limit.ts";
import { ai } from "./routes/ai.ts";
import { aiAgent } from "./routes/ai-agent.ts";
import { apiKeys } from "./routes/api-keys.ts";
import { audit } from "./routes/audit-log.ts";
import { autoscale } from "./routes/autoscale.ts";
import { backupDestinations } from "./routes/backup-destinations.ts";
import { backups } from "./routes/backups.ts";
import { buildPlatforms } from "./routes/build-platforms.ts";
import { certificates } from "./routes/certificates.ts";
import { containerFiles } from "./routes/container-files.ts";
import { databaseAccessRoutes } from "./routes/database-access.ts";
import { databases } from "./routes/databases.ts";
import { dnsProviders } from "./routes/dns-providers.ts";
import { domainAccess } from "./routes/domain-access.ts";
import { domains } from "./routes/domains.ts";
import { edge } from "./routes/edge.ts";
import { envVars } from "./routes/env-vars.ts";
import { files } from "./routes/files.ts";
import { folders } from "./routes/folders.ts";
import { games } from "./routes/games.ts";
import { git } from "./routes/git.ts";
import { gitops } from "./routes/gitops.ts";
import { health } from "./routes/health.ts";
import { instance } from "./routes/instance-settings.ts";
import { integrations } from "./routes/integrations.ts";
import { logDrains } from "./routes/log-drains.ts";
import { manifests } from "./routes/manifest.ts";
import { members } from "./routes/members.ts";
import { metrics } from "./routes/metrics.ts";
import { migrations } from "./routes/migrations.ts";
import { networkMapRoutes } from "./routes/network-map.ts";
import { nodes } from "./routes/nodes.ts";
import { notifications } from "./routes/notifications.ts";
import { organizationRoutes } from "./routes/organization.ts";
import { patching } from "./routes/patching.ts";
import { plugins } from "./routes/plugins.ts";
import { previews } from "./routes/previews.ts";
import { projects } from "./routes/projects.ts";
import { registries } from "./routes/registries.ts";
import { s3Destinations } from "./routes/s3-destinations.ts";
import { schedules } from "./routes/schedules.ts";
import { secretProviderRoutes } from "./routes/secret-providers.ts";
import { secrets } from "./routes/secrets.ts";
import { serviceAuth } from "./routes/service-auth.ts";
import { serviceOps } from "./routes/service-ops.ts";
import { services } from "./routes/services.ts";
import { setup } from "./routes/setup.ts";
import { sponsor } from "./routes/sponsor.ts";
import { sshKeys } from "./routes/ssh-keys.ts";
import { sso } from "./routes/sso.ts";
import { stacks } from "./routes/stacks.ts";
import { storage } from "./routes/storage.ts";
import { tailscale } from "./routes/tailscale.ts";
import { templates } from "./routes/templates.ts";
import { traffic } from "./routes/traffic.ts";
import { tunnels } from "./routes/tunnels.ts";
import { updates } from "./routes/updates.ts";
import { uptime } from "./routes/uptime.ts";
import { usage } from "./routes/usage.ts";
import { vulnerabilities } from "./routes/vulnerabilities.ts";
import { webhooks } from "./routes/webhooks.ts";
import { workCollab } from "./routes/work/collab.ts";
import { workExtrasA } from "./routes/work/extras-a.ts";
import { workImportsSharesGuests } from "./routes/work/imports-shares-guests.ts";
import { workRoutes } from "./routes/work/index.ts";
import { push, statusBySlug, statusHostRouter } from "./status-pages.ts";
import { realtime } from "./ws.ts";

/**
 * better-auth endpoints of these families act on organizations, users and keys outside LogiStack's
 * permission checks, two-factor rule and audit log (creating an organization, a role named
 * "x,owner", an API key that skips two-factor, impersonation). LogiStack calls what it needs
 * through `auth.api`, which this list does not touch; browsers reach only the endpoints below.
 */
const AUTH_GATED = ["/organization/", "/admin/", "/api-key/"];
const AUTH_OPEN = new Set([
	"/organization/accept-invitation",
	"/organization/reject-invitation",
	"/organization/get-invitation",
	"/organization/list",
	"/organization/list-user-invitations",
	"/organization/set-active",
]);
export function authPathAllowed(path: string): boolean {
	let p = path.slice("/api/auth".length);
	try {
		p = decodeURIComponent(p);
	} catch {
		return false;
	}
	p = p.toLowerCase().replace(/\/+$/, "");
	return !AUTH_GATED.some((f) => p.startsWith(f)) || AUTH_OPEN.has(p);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie-authenticated changes and WebSocket upgrades must come from the dashboard's own origin.
 * SameSite=Lax still sends the cookie from any same-site page: every *.sslip.io host on a default
 * install, or a tenant app on a sibling subdomain. API keys carry no ambient authority.
 */
export const sameOriginOnly: MiddlewareHandler<Env> = async (c, next) => {
	const h = c.req.raw.headers;
	const upgrade = h.get("upgrade")?.toLowerCase() === "websocket";
	if (
		(upgrade || !SAFE_METHODS.has(c.req.method)) &&
		h.has("cookie") &&
		!apiKeyFrom(h) &&
		!h.has("authorization")
	) {
		const site = h.get("sec-fetch-site");
		const origin = h.get("origin");
		// Neither header: not a browser, so no ambient cookie to ride on.
		if (site !== "same-origin" && (site || origin)) {
			const { config, db } = c.var.deps;
			const trusted = await trustedOrigins(config, db)();
			if (!origin || !trusted.includes(origin))
				throw new Failure("forbidden", "cross-site request refused");
		}
	}
	await next();
};

/** Paths whose own handlers decide framing and policy (public status pages, plugin pages). */
const OWN_HEADERS = /^\/(status|plugins|share)\//;

const securityHeaders: MiddlewareHandler<Env> = async (c, next) => {
	await next();
	if (c.req.header("upgrade")) return;
	try {
		const h = c.res.headers;
		h.set("x-content-type-options", "nosniff");
		// A route's own, stricter policy (share pages send no-referrer) stays.
		if (!h.has("referrer-policy"))
			h.set("referrer-policy", "strict-origin-when-cross-origin");
		if (!OWN_HEADERS.test(c.req.path) && !h.has("x-frame-options"))
			h.set("x-frame-options", "SAMEORIGIN");
		if (c.req.header("x-forwarded-proto") === "https")
			h.set("strict-transport-security", "max-age=31536000");
	} catch {
		// An immutable response (a proxied stream): it keeps its own headers.
	}
};

/** The app shell's CSP: its one inline script (the theme bootstrap) by hash, everything else from this origin. */
function shellPolicy(indexHtml: string): string {
	const hashes = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
		(m) =>
			`'sha256-${createHash("sha256")
				.update(m[1] ?? "")
				.digest("base64")}'`,
	);
	return [
		"default-src 'self'",
		`script-src 'self' ${hashes.join(" ")}`.trim(),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"worker-src 'self' blob:",
		"frame-src 'self'",
		"frame-ancestors 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
	].join("; ");
}

/**
 * Builds the HTTP app over injected dependencies (real ones in index.ts, containers in tests).
 * `actor` replaces authentication for in-process callers (scripts): every request runs as it.
 */
export function createApp(deps: Deps, opts: { actor?: Actor } = {}) {
	const { actor } = opts;
	const identify: MiddlewareHandler<Env> = actor
		? async (c, next) => {
				c.set("actor", actor);
				await next();
			}
		: authenticate;
	const app = new OpenAPIHono<Env>({ defaultHook: validationHook });
	app.onError(onError);
	app.notFound((c) =>
		c.json({ error: { code: "not_found", message: "route not found" } }, 404),
	);
	app.use(requestId());
	app.use(securityHeaders);
	app.use(async (c, next) => {
		c.set("deps", deps);
		await next();
	});
	app.use(requestLogger);
	// Bun.serve allows object-sized bodies for storage uploads and database restores; everything else keeps the old ceiling.
	const limited = bodyLimit({
		maxSize: 128 * 1024 * 1024,
		onError: (c) =>
			c.json(
				{ error: { code: "bad_request", message: "request body too large" } },
				413,
			),
	});
	const streamed = (c: Context<Env>) =>
		(c.req.method === "PUT" &&
			/^\/api\/storage\/[^/]+\/buckets\/[^/]+\/upload$/.test(c.req.path)) ||
		(c.req.method === "POST" &&
			/^\/api\/databases\/[^/]+\/restore$/.test(c.req.path));
	app.use("/api/*", (c, next) => (streamed(c) ? next() : limited(c, next)));
	// A status page's own hostname serves that page only, before any session or API handling.
	app.use("*", statusHostRouter(deps));
	app.route("/status/:slug", statusBySlug);
	app.use(
		"/api/*",
		cors({ origin: deps.config.WEB_ORIGIN, credentials: true }),
	);
	app.use("*", (c, next) =>
		// better-auth checks the origin of its own endpoints; webhooks, heartbeats and keys carry no cookie authority.
		/^\/(api\/auth|api\/webhooks|push|acme-proxy|v1|mcp|plugins)(\/|$)/.test(
			c.req.path,
		)
			? next()
			: sameOriginOnly(c, next),
	);
	app.use("/api/auth/*", limitCredentials);
	app.on(["GET", "POST"], "/api/auth/*", (c) => {
		if (!authPathAllowed(c.req.path))
			throw new Failure("not_found", "route not found");
		return deps.auth.handler(c.req.raw);
	});
	// Health must answer even when the session store is unreachable; agents present node tokens.
	app.use("/api/*", async (c, next) =>
		c.req.path.startsWith("/api/auth/") ||
		c.req.path === "/api/health" ||
		// Authenticated by the provider's signature instead of a session.
		c.req.path.startsWith("/api/webhooks/") ||
		// The sealed token in the path is the credential.
		c.req.path.startsWith("/api/storage/shared/") ||
		c.req.path === AGENT_WS_PATH
			? next()
			: identify(c, next),
	);
	app.use("/ws", identify);

	app.openAPIRegistry.registerComponent("securitySchemes", "session", {
		type: "apiKey",
		in: "cookie",
		// `__Secure-better-auth.session_token` when BETTER_AUTH_URL is https (SECURE_COOKIES).
		name: "better-auth.session_token",
	});
	app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
		type: "apiKey",
		in: "header",
		name: "x-api-key",
	});
	app.doc31("/api/openapi.json", {
		openapi: "3.1.0",
		info: { title: "LogiStack API", version: "0.1.0" },
	});
	app.get("/api/docs", Scalar({ url: "/api/openapi.json" }));

	// Heartbeats from cron jobs, outside /api: the token is the credential, and a ping is
	// telemetry like a metric sample, not an audited change.
	app.route("/push", push);
	// Plugin pages: no session here (an opaque-origin page sends no cookies); see plugin-proxy.ts.
	app.route("/plugins", pluginProxy);
	// DNS-01 for plugin DNS providers, called by Caddy with a per-provider basic-auth secret.
	app.route("/acme-proxy", acmeProxy);

	// Work paths come from the contracts route table (plain strings), so they stay out of AppType.
	app.route("/", workCollab);
	app.route("/api", workExtrasA);
	const routes = app
		.route("/api", health)
		.route("/api", setup)
		.route("/api", folders)
		.route("/api", projects)
		.route("/api", services)
		.route("/api", stacks)
		.route("/api", manifests)
		.route("/api", gitops)
		.route("/api", previews)
		.route("/api", envVars)
		.route("/api", secrets)
		.route("/api", domains)
		.route("/api", domainAccess)
		.route("/api", edge)
		.route("/api", dnsProviders)
		.route("/api", certificates)
		.route("/api", notifications)
		.route("/api", secretProviderRoutes)
		.route("/api", logDrains)
		.route("/api", integrations)
		.route("/api", audit)
		.route("/api", organizationRoutes)
		.route("/api", metrics)
		.route("/api", traffic)
		.route("/api", autoscale)
		.route("/api", vulnerabilities)
		.route("/api", usage)
		.route("/api", nodes)
		.route("/api", patching)
		.route("/api", networkMapRoutes)
		.route("/api", members)
		.route("/api", apiKeys)
		.route("/api", sshKeys)
		.route("/api", sso)
		.route("/api", serviceOps)
		.route("/api", instance)
		.route("/api", sponsor)
		.route("/api", buildPlatforms)
		.route("/api", updates)
		.route("/api", git)
		.route("/api", registries)
		.route("/api", webhooks)
		.route("/api", s3Destinations)
		.route("/api", backupDestinations)
		.route("/api", tunnels)
		.route("/api", tailscale)
		.route("/api", serviceAuth)
		.route("/api", backups)
		.route("/api", schedules)
		.route("/api", templates)
		.route("/api", files)
		.route("/api", containerFiles)
		.route("/api", storage)
		.route("/api", games)
		.route("/api", databases)
		.route("/api", databaseAccessRoutes)
		.route("/api", migrations)
		.route("/api", ai)
		.route("/api", aiAgent)
		.route("/api", uptime)
		.route("/api", plugins)
		.route("/api", workRoutes)
		.route("/", workImportsSharesGuests)
		.route("/", realtime)
		.route("/", terminal);

	app.on(["GET", "POST", "DELETE"], "/mcp", mcpHandler(app));
	// OpenAI- and Anthropic-compatible AI gateway, authenticated by its own keys.
	app.route("/v1", gateway);

	const web = deps.config.WEB_DIST_DIR;
	if (existsSync(join(web, "index.html"))) {
		const isApi = (p: string) =>
			p === "/ws" ||
			p === "/mcp" ||
			p === "/api" ||
			p.startsWith("/status/") ||
			p.startsWith("/push/") ||
			p.startsWith("/plugins/") ||
			p.startsWith("/api/") ||
			p.startsWith("/v1/");
		const policy = shellPolicy(readFileSync(join(web, "index.html"), "utf8"));
		app.get("*", async (c, next) => {
			await next();
			if (c.res.headers.get("content-type")?.startsWith("text/html"))
				c.res.headers.set("content-security-policy", policy);
		});
		// A file when one matches, else the app shell for client-side routes.
		for (const handler of [
			serveStatic({ root: web }),
			serveStatic({ root: web, path: "index.html" }),
		])
			app.get("*", (c, next) =>
				isApi(c.req.path) ? next() : handler(c, next),
			);
	}

	assertMutationsAudited(app);
	return routes;
}

export type AppType = ReturnType<typeof createApp>;
