export type Env = {
	PLUGIN_INDEX: D1Database;
	/** Secret: base64url PKCS#8 Ed25519 private key that signs index responses. */
	SIGNING_KEY: string;
	/** Secret: a Resend API key with sending access to EMAIL_FROM's domain. */
	RESEND_API_KEY?: string;
	/** Path prefix of the route, as `/plugins/api`; empty under `wrangler dev`. */
	BASE_PATH: string;
	/** Origin sign-in links point at. */
	PUBLIC_ORIGIN: string;
	EMAIL_FROM: string;
	/** "1" in the sandbox environment. */
	SANDBOX?: string;
	/** "1" in `.dev.vars` only: sign-in links go to the log instead of Resend. */
	DEV_LOGIN_LINKS?: string;
};

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly issues?: unknown,
	) {
		super(message);
	}
}

export const now = () => Math.floor(Date.now() / 1000);

export const b64u = (b: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(b)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

export const fromB64u = (s: string) =>
	Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
		c.charCodeAt(0),
	);

export const randomToken = (bytes = 32) =>
	b64u(crypto.getRandomValues(new Uint8Array(bytes)));

export const newId = (prefix: string) => `${prefix}_${randomToken(12)}`;

export async function sha256Hex(data: string | ArrayBuffer) {
	const bytes =
		typeof data === "string" ? new TextEncoder().encode(data) : data;
	const d = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(d)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** A request from an HTML form gets redirects and pages; anything else gets JSON. */
export const isForm = (req: Request) =>
	(req.headers.get("content-type") ?? "").startsWith(
		"application/x-www-form-urlencoded",
	);

/** JSON or form body as a plain object. Bodies over 512 KiB are refused. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (text.length > 512 * 1024) throw new HttpError(413, "body too large");
	if (isForm(req)) return Object.fromEntries(new URLSearchParams(text));
	if (!text) return {};
	try {
		const v = JSON.parse(text);
		if (v && typeof v === "object" && !Array.isArray(v)) return v;
	} catch {}
	throw new HttpError(400, "the body must be a JSON object");
}

export const str = (v: unknown, max: number): string =>
	typeof v === "string" ? v.trim().slice(0, max + 1) : "";

export function cookie(req: Request, name: string): string | null {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return null;
}

export const redirect = (to: string, headers: HeadersInit = {}) =>
	new Response(null, { status: 303, headers: { location: to, ...headers } });
