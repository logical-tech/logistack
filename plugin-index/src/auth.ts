import {
	cookie,
	type Env,
	HttpError,
	newId,
	now,
	randomToken,
	sha256Hex,
} from "./http.ts";

// Publishers sign in with a magic link sent through Resend (as the sponsors Worker mails keys),
// so there is no password to store and no OAuth app to register. The CLI and CI use API tokens
// a publisher creates from the dashboard. Every secret is stored as its SHA-256 only.

const LOGIN_TTL = 15 * 60;
const SESSION_TTL = 30 * 86_400;
export const SESSION_COOKIE = "lspi_session";
const TOKEN_PREFIX = "lspi_";

export type Publisher = {
	id: string;
	email: string;
	name: string;
	suspended_at: number | null;
};
export type Who = { publisher: Publisher; admin: boolean; viaToken: boolean };

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Mails a sign-in link. Answers the same whether or not the address has an account. */
export async function startLogin(env: Env, rawEmail: string) {
	const email = rawEmail.trim().toLowerCase();
	if (email.length > 254 || !EMAIL.test(email))
		throw new HttpError(400, "enter a valid email address");
	const db = env.PLUGIN_INDEX;
	const t = now();
	await db
		.prepare("DELETE FROM login_tokens WHERE expires_at < ?")
		.bind(t)
		.run();
	// One link a minute per address, so the form cannot be used to flood an inbox.
	const recent = await db
		.prepare("SELECT 1 FROM login_tokens WHERE email = ? AND expires_at > ?")
		.bind(email, t + LOGIN_TTL - 60)
		.first();
	if (recent) return;
	const token = randomToken();
	await db
		.prepare(
			"INSERT INTO login_tokens (hash, email, expires_at) VALUES (?, ?, ?)",
		)
		.bind(await sha256Hex(token), email, t + LOGIN_TTL)
		.run();
	const link = `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/auth/callback?token=${token}`;
	if (env.DEV_LOGIN_LINKS === "1") {
		console.log(`sign-in link for ${email}: ${link}`);
		return;
	}
	if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
	const sandbox = env.SANDBOX === "1" ? "[Sandbox] " : "";
	const text = `Sign in to the LogiStack plugin index:\n\n${link}\n\nThe link works once, for 15 minutes. If you did not ask for it, ignore this email.`;
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: `LogiStack <${env.EMAIL_FROM}>`,
			to: [email],
			subject: `${sandbox}Sign in to the LogiStack plugin index`,
			text,
		}),
	});
	if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/** Trades a link token for a session, creating the publisher on first sign-in. Returns the session token. */
export async function finishLogin(env: Env, token: string): Promise<string> {
	const db = env.PLUGIN_INDEX;
	const t = now();
	const row = await db
		.prepare(
			"DELETE FROM login_tokens WHERE hash = ? AND expires_at > ? RETURNING email",
		)
		.bind(await sha256Hex(token), t)
		.first<{ email: string }>();
	if (!row)
		throw new HttpError(
			400,
			"this sign-in link is used or expired; ask for a new one",
		);
	await db
		.prepare(
			"INSERT INTO publishers (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING",
		)
		.bind(newId("pub"), row.email, t)
		.run();
	const pub = await db
		.prepare("SELECT id FROM publishers WHERE email = ?")
		.bind(row.email)
		.first<{ id: string }>();
	const session = randomToken();
	await db.batch([
		db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
		db
			.prepare(
				"INSERT INTO sessions (hash, publisher_id, expires_at) VALUES (?, ?, ?)",
			)
			.bind(await sha256Hex(session), pub?.id, t + SESSION_TTL),
	]);
	return session;
}

export const sessionCookie = (env: Env, value: string, maxAge = SESSION_TTL) =>
	`${SESSION_COOKIE}=${value}; Path=${env.BASE_PATH || "/"}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

export async function logout(env: Env, req: Request) {
	const s = cookie(req, SESSION_COOKIE);
	if (s)
		await env.PLUGIN_INDEX.prepare("DELETE FROM sessions WHERE hash = ?")
			.bind(await sha256Hex(s))
			.run();
}

/** The caller, from `Authorization: Bearer lspi_…` or the session cookie. */
export async function who(env: Env, req: Request): Promise<Who | null> {
	const db = env.PLUGIN_INDEX;
	const bearer = /^Bearer\s+(\S+)$/i.exec(
		req.headers.get("authorization") ?? "",
	)?.[1];
	let publisherId: string | undefined;
	if (bearer) {
		const hash = await sha256Hex(bearer);
		const row = await db
			.prepare(
				"UPDATE api_tokens SET last_used_at = ? WHERE hash = ? RETURNING publisher_id",
			)
			.bind(now(), hash)
			.first<{ publisher_id: string }>();
		if (!row) return null;
		publisherId = row.publisher_id;
	} else {
		const s = cookie(req, SESSION_COOKIE);
		if (!s) return null;
		const row = await db
			.prepare(
				"SELECT publisher_id FROM sessions WHERE hash = ? AND expires_at > ?",
			)
			.bind(await sha256Hex(s), now())
			.first<{ publisher_id: string }>();
		if (!row) return null;
		// A cookie request that changes state must come from our own pages.
		if (req.method !== "GET") {
			const origin = req.headers.get("origin");
			if (origin !== new URL(req.url).origin)
				throw new HttpError(403, "cross-site request refused");
		}
		publisherId = row.publisher_id;
	}
	const publisher = await db
		.prepare(
			"SELECT id, email, name, suspended_at FROM publishers WHERE id = ?",
		)
		.bind(publisherId)
		.first<Publisher>();
	if (!publisher) return null;
	const admin =
		!publisher.suspended_at &&
		!!(await db
			.prepare("SELECT 1 FROM admins WHERE email = ?")
			.bind(publisher.email)
			.first());
	return { publisher, admin, viaToken: !!bearer };
}

export async function requireWho(env: Env, req: Request): Promise<Who> {
	const w = await who(env, req);
	if (!w) throw new HttpError(401, "sign in first");
	return w;
}

export async function requireAdmin(env: Env, req: Request): Promise<Who> {
	const w = await requireWho(env, req);
	if (!w.admin) throw new HttpError(403, "admins only");
	return w;
}

export async function createApiToken(
	env: Env,
	publisherId: string,
	name: string,
) {
	if (!name) throw new HttpError(400, "name the token, as `laptop` or `ci`");
	const token = `${TOKEN_PREFIX}${randomToken()}`;
	await env.PLUGIN_INDEX.prepare(
		"INSERT INTO api_tokens (hash, publisher_id, name, created_at) VALUES (?, ?, ?, ?)",
	)
		.bind(await sha256Hex(token), publisherId, name, now())
		.run();
	return token;
}

export async function deleteApiToken(
	env: Env,
	publisherId: string,
	hash: string,
) {
	await env.PLUGIN_INDEX.prepare(
		"DELETE FROM api_tokens WHERE hash = ? AND publisher_id = ?",
	)
		.bind(hash, publisherId)
		.run();
}
