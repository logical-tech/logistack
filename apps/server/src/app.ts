import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AGENT_WS_PATH } from "@logistack/contracts";
import { Scalar } from "@scalar/hono-api-reference";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { type Actor, authenticate } from "./actor.ts";
import { gateway } from "./ai/gateway.ts";
import { assertMutationsAudited } from "./audit.ts";
import type { Deps, Env } from "./env.ts";
import { onError, validationHook } from "./errors.ts";
import { terminal } from "./exec-ws.ts";
import { requestLogger } from "./log.ts";
import { mcpHandler } from "./mcp.ts";
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
import { databases } from "./routes/databases.ts";
import { dnsProviders } from "./routes/dns-providers.ts";
import { domainAccess } from "./routes/domain-access.ts";
import { domains } from "./routes/domains.ts";
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
import { tunnels } from "./routes/tunnels.ts";
import { updates } from "./routes/updates.ts";
import { usage } from "./routes/usage.ts";
import { vulnerabilities } from "./routes/vulnerabilities.ts";
import { webhooks } from "./routes/webhooks.ts";
import { realtime } from "./ws.ts";

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
	app.use(
		"/api/*",
		cors({ origin: deps.config.WEB_ORIGIN, credentials: true }),
	);
	app.use("/api/auth/*", limitCredentials);
	app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
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
		.route("/api", dnsProviders)
		.route("/api", certificates)
		.route("/api", notifications)
		.route("/api", secretProviderRoutes)
		.route("/api", logDrains)
		.route("/api", integrations)
		.route("/api", audit)
		.route("/api", organizationRoutes)
		.route("/api", metrics)
		.route("/api", autoscale)
		.route("/api", vulnerabilities)
		.route("/api", usage)
		.route("/api", nodes)
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
		.route("/api", migrations)
		.route("/api", ai)
		.route("/api", aiAgent)
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
			p.startsWith("/api/") ||
			p.startsWith("/v1/");
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
