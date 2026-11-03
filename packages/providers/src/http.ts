import { z } from "zod";

/** The subset of `fetch` providers use, so tests can inject a plain function. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Deps = { fetch?: Fetch; timeoutMs?: number };

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Every provider failure. Messages never carry credentials or request URLs (Telegram puts its token in the path). */
export class ProviderError extends Error {
	constructor(
		readonly provider: string,
		readonly op: string,
		message: string,
		readonly status?: number,
	) {
		super(`${provider} ${op}: ${message}`);
		this.name = "ProviderError";
	}
}

export type ProviderDef<S extends z.ZodType, T> = {
	configSchema: S;
	create(config: z.infer<S>, deps?: Deps): T;
};

export const defineProvider = <S extends z.ZodType, T>(
	def: ProviderDef<S, T>,
): ProviderDef<S, T> => def;

/** Parses untrusted config (form input, decrypted row) with the kind's schema, then builds the instance. */
export function instantiate<T>(
	def: ProviderDef<z.ZodType, T>,
	rawConfig: unknown,
	deps?: Deps,
): T {
	return def.create(def.configSchema.parse(rawConfig), deps);
}

/** A credential field: forms render it as a password input, and redaction can find it via `z.toJSONSchema`. */
export const secret = () => z.string().min(1).meta({ secret: true });

export class Http {
	readonly fetch: Fetch;
	readonly timeoutMs: number;

	constructor(
		readonly provider: string,
		deps: Deps = {},
	) {
		this.fetch = deps.fetch ?? fetch;
		this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Throws ProviderError on network failure, timeout or a non-2xx status. */
	async request(
		op: string,
		url: string,
		init: RequestInit = {},
	): Promise<Response> {
		let res: Response;
		try {
			res = await this.fetch(url, {
				...init,
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			const timedOut = err instanceof Error && err.name === "TimeoutError";
			throw new ProviderError(
				this.provider,
				op,
				timedOut
					? `timed out after ${this.timeoutMs}ms`
					: `network error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).slice(0, 500);
			throw new ProviderError(
				this.provider,
				op,
				`HTTP ${res.status}${body ? `: ${body}` : ""}`,
				res.status,
			);
		}
		return res;
	}

	async json<T = unknown>(
		op: string,
		url: string,
		init?: RequestInit,
	): Promise<T> {
		const res = await this.request(op, url, init);
		return (await res.json()) as T;
	}

	/** POSTs a JSON body and discards the response. */
	async postJson(
		op: string,
		url: string,
		body: unknown,
		headers: Record<string, string> = {},
	): Promise<void> {
		await this.request(op, url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	}
}

const encoder = new TextEncoder();
const bytes = (v: string | Uint8Array): Uint8Array<ArrayBuffer> =>
	typeof v === "string" ? encoder.encode(v) : new Uint8Array(v);

export async function hmacSha256(
	key: string | Uint8Array,
	data: string | Uint8Array,
): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey(
		"raw",
		bytes(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes(data)));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", bytes(data)),
	).toHex();
}

/** Constant-time for equal lengths; a length mismatch returns early, which leaks only the length. */
export function safeEqual(a: string, b: string): boolean {
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	if (x.length !== y.length) return false;
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}
