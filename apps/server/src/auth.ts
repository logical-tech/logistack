import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { type Db, instanceSettings, schema } from "@logistack/db";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { Config } from "./config.ts";
import { joinOrganization } from "./sso.ts";
import {
	blockedOnOrganizationEndpoint,
	TWO_FACTOR_REQUIRED_MESSAGE,
} from "./two-factor.ts";

export const API_KEY_PREFIX = "lsk_";

/** `x-api-key: lsk_...` or `Authorization: Bearer lsk_...`. */
export function apiKeyFrom(headers: Headers): string | null {
	const header = headers.get("x-api-key");
	if (header) return header;
	const bearer = headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
	return bearer?.startsWith(API_KEY_PREFIX) ? bearer : null;
}

/** Origins of the public URL (http and https: Caddy redirects the dashboard to https) and of the primary domain. */
export function settingsOrigins(settings: {
	publicUrl: string | null;
	primaryDomain: string | null;
}): string[] {
	const hosts = new Set<string>();
	if (settings.publicUrl)
		try {
			hosts.add(new URL(settings.publicUrl).host);
		} catch {}
	if (settings.primaryDomain) hosts.add(settings.primaryDomain);
	return [...hosts].flatMap((h) => [`https://${h}`, `http://${h}`]);
}

async function readOrigins(config: Config, db: Db) {
	const [row] = await db
		.select({
			publicUrl: instanceSettings.publicUrl,
			primaryDomain: instanceSettings.primaryDomain,
		})
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return {
		publicUrl: row?.publicUrl ?? null,
		trusted: [
			config.WEB_ORIGIN,
			...(config.LOGISTACK_TUNNEL_ORIGIN
				? [config.LOGISTACK_TUNNEL_ORIGIN]
				: []),
			...(row ? settingsOrigins(row) : []),
		],
	};
}

/**
 * WEB_ORIGIN plus the instance settings' origins, read on every call so a settings change applies
 * at once. better-auth asks only on its own endpoints (sign-in and the like), not on every API call.
 */
export function trustedOrigins(config: Config, db: Db) {
	return async () => (await readOrigins(config, db)).trusted;
}

const hostname = (url: string) => {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
};

/**
 * The WebAuthn RP ID: the host the browser is on (its Origin, or Host on a same-origin GET) when
 * a trusted origin has it, else the public URL's. Never BETTER_AUTH_URL: it keeps the installer's
 * generated bootstrap host after the dashboard moves to its own domain.
 */
export async function passkeyRpId(
	config: Config,
	db: Db,
	headers: Headers | undefined,
): Promise<string> {
	const { publicUrl, trusted } = await readOrigins(config, db);
	const origin = headers?.get("origin");
	const host = hostname(origin || `http://${headers?.get("host")}`);
	if (host && trusted.some((o) => hostname(o) === host)) return host;
	return (
		(publicUrl && hostname(publicUrl)) ||
		(hostname(config.WEB_ORIGIN) as string)
	);
}

// Plugin list and user fields must match packages/db/auth.config.ts (the schema source).
export function createAuth(config: Config, db: Db) {
	const social = {
		...(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
			? {
					github: {
						clientId: config.GITHUB_CLIENT_ID,
						clientSecret: config.GITHUB_CLIENT_SECRET,
					},
				}
			: {}),
		...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
			? {
					google: {
						clientId: config.GOOGLE_CLIENT_ID,
						clientSecret: config.GOOGLE_CLIENT_SECRET,
					},
				}
			: {}),
	};
	return betterAuth({
		baseURL: config.BETTER_AUTH_URL,
		basePath: "/api/auth",
		// The TOTP issuer and the passkey RP name authenticator apps show.
		appName: "LogiStack",
		secret: config.BETTER_AUTH_SECRET,
		trustedOrigins: trustedOrigins(config, db),
		logger: { disabled: config.LOG_LEVEL === "silent" },
		database: drizzleAdapter(db, { provider: "pg", schema }),
		emailAndPassword: { enabled: true },
		// Provider mutations go through /api/sso, which checks LogiStack permissions and audits them.
		disabledPaths: [
			"/sso/register",
			"/sso/update-provider",
			"/sso/delete-provider",
			"/sso/request-domain-verification",
			"/sso/verify-domain",
		],
		socialProviders: social,
		hooks: {
			// The passkey plugin takes its RP ID from options.baseURL, so these requests see the
			// browser's host there. The hook's context is a per-request copy; the shared options stay.
			before: createAuthMiddleware(async (ctx) => {
				// better-auth's organization endpoints act on an organization outside requireActor.
				if (ctx.path.startsWith("/organization/")) {
					const session = await getSessionFromCtx(ctx);
					if (!session) return;
					const blocked = await blockedOnOrganizationEndpoint(db, {
						path: ctx.path,
						body: ctx.body,
						query: ctx.query,
						userId: session.user.id,
						activeOrganizationId: (
							session.session as { activeOrganizationId?: string | null }
						).activeOrganizationId,
					});
					if (blocked)
						throw new APIError("FORBIDDEN", {
							code: "two_factor_required",
							message: TWO_FACTOR_REQUIRED_MESSAGE,
							deadline: blocked.deadline.toISOString(),
						});
					return;
				}
				if (!ctx.path.startsWith("/passkey/")) return;
				const rpId = await passkeyRpId(config, db, ctx.headers);
				return {
					context: { context: { options: { baseURL: `https://${rpId}` } } },
				};
			}),
		},
		user: {
			additionalFields: {
				kind: {
					type: ["human", "machine"],
					required: true,
					defaultValue: "human",
					input: false,
				},
			},
		},
		databaseHooks: {
			user: {
				create: {
					// The first-run wizard creates the owner; until then nobody may sign up,
					// or a stranger could claim the instance before its operator does.
					before: async () => {
						const [row] = await db
							.select({ done: instanceSettings.setupCompleted })
							.from(instanceSettings)
							.where(eq(instanceSettings.id, "singleton"));
						if (!row?.done)
							throw new APIError("FORBIDDEN", {
								message: "instance setup is not completed",
							});
					},
				},
			},
		},
		plugins: [
			organization({
				teams: { enabled: false },
				dynamicAccessControl: { enabled: true },
			}),
			twoFactor(),
			passkey(),
			apiKey({
				defaultPrefix: API_KEY_PREFIX,
				enableMetadata: true,
				rateLimit: { enabled: false },
				customAPIKeyGetter: (ctx) =>
					ctx.headers ? apiKeyFrom(ctx.headers) : null,
			}),
			sso({
				// better-auth's own provisioning only knows member/admin and joins any user of the
				// provider; LogiStack joins by email domain with the role chosen in the wizard.
				organizationProvisioning: { disabled: true },
				provisionUserOnEveryLogin: true,
				provisionUser: async ({ user, provider }) => {
					await joinOrganization(db, user, provider);
				},
			}),
			admin(),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;
