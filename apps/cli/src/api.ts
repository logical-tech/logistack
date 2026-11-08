import type { Credentials } from "./config.ts";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

export type Api = ReturnType<typeof client>;

/** The LogiStack REST API under `<url>/api`, authenticated with an API key. */
export function client(c: Credentials, fetcher: typeof fetch = fetch) {
	const base = c.url.replace(/\/+$/, "");
	const request = async (
		method: string,
		path: string,
		body?: unknown,
		accept = "application/json",
	) => {
		const res = await fetcher(`${base}/api${path}`, {
			method,
			headers: {
				"x-api-key": c.apiKey,
				accept,
				...(body !== undefined && { "content-type": "application/json" }),
			},
			...(body !== undefined && { body: JSON.stringify(body) }),
		});
		const text = await res.text();
		const json = res.headers.get("content-type")?.includes("json")
			? JSON.parse(text)
			: undefined;
		if (!res.ok) {
			const e = json?.error;
			throw new ApiError(
				res.status,
				e?.message ?? `${method} ${path}: HTTP ${res.status}`,
				e?.details,
			);
		}
		return { json, text };
	};
	return {
		base,
		apiKey: c.apiKey,
		get: async <T>(path: string) => (await request("GET", path)).json as T,
		text: async (path: string) =>
			(await request("GET", path, undefined, "text/yaml")).text,
		post: async <T>(path: string, body?: unknown) =>
			(await request("POST", path, body ?? {})).json as T,
		/** `ws(s)://<host>/ws...` with the key in a header, never in the URL. */
		socket: (path: string) =>
			new WebSocket(`${base.replace(/^http/, "ws")}${path}`, {
				headers: { "x-api-key": c.apiKey },
			} as unknown as string[]),
	};
}
