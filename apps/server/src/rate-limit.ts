import type { Context, MiddlewareHandler } from "hono";
import { clientIp } from "./audit.ts";
import type { Env } from "./env.ts";
import { Failure } from "./errors.ts";
import { log } from "./log.ts";
import { redisFor } from "./redis.ts";

/**
 * Fixed one-minute windows counted in Redis, so every api replica shares the count. INCR is atomic:
 * concurrent requests can never all read "under the limit". Redis down fails open (logged), since
 * locking everyone out is worse than a minute without the limit.
 */
export async function overLimit(
	redisUrl: string,
	bucket: string,
	perMinute: number,
): Promise<number | undefined> {
	const window = Math.floor(Date.now() / 60_000);
	const key = `ls:rl:${bucket}:${window}`;
	try {
		const redis = redisFor(redisUrl);
		const count = await redis.incr(key);
		if (count === 1) await redis.expire(key, 60);
		if (count <= perMinute) return undefined;
		return 60 - Math.floor((Date.now() / 1000) % 60);
	} catch (error) {
		log("error", "rate limit check failed", { bucket, error: String(error) });
		return undefined;
	}
}

function refuse(c: Context<Env>, retryAfter: number, what: string): never {
	c.header("retry-after", String(retryAfter));
	throw new Failure(
		"rate_limited",
		`too many ${what}; try again in ${retryAfter}s`,
	);
}

/** Credential endpoints (sign-in, sign-up, second factor, password reset), per client address. */
const CREDENTIAL_PATH =
	/^\/api\/auth\/(sign-in|sign-up|two-factor|passkey\/verify-authentication|request-password-reset|reset-password|forget-password)/;

export const limitCredentials: MiddlewareHandler<Env> = async (c, next) => {
	if (c.req.method === "POST" && CREDENTIAL_PATH.test(c.req.path)) {
		const { config } = c.var.deps;
		const wait = await overLimit(
			config.REDIS_URL,
			`login:${clientIp(c) ?? "unknown"}`,
			config.RATE_LIMIT_LOGIN_PER_MINUTE,
		);
		if (wait !== undefined) refuse(c, wait, "sign-in attempts");
		// Per account too: guessing one person's password from many addresses stays slow.
		const email = await c.req.raw
			.clone()
			.json()
			.then((b: unknown) => {
				const email = (b as { email?: unknown } | null)?.email;
				return typeof email === "string"
					? email.trim().toLowerCase()
					: undefined;
			})
			.catch(() => undefined);
		if (email) {
			const byAccount = await overLimit(
				config.REDIS_URL,
				`login-account:${Bun.hash(email).toString(16)}`,
				config.RATE_LIMIT_LOGIN_PER_MINUTE,
			);
			if (byAccount !== undefined)
				refuse(c, byAccount, "sign-in attempts for this account");
		}
	}
	await next();
};

/** Requests made with one API key, MCP and Agent calls included (they replay through REST). */
export async function limitApiKey(c: Context<Env>, keyId: string) {
	const { config } = c.var.deps;
	const wait = await overLimit(
		config.REDIS_URL,
		`key:${keyId}`,
		config.RATE_LIMIT_API_KEY_PER_MINUTE,
	);
	if (wait !== undefined) refuse(c, wait, "requests with this API key");
}
