import type { Fetch } from "../src/index.ts";

export type Call = {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
};

/** A fetch stand-in that records every request and answers through `handler`. */
export function mockFetch(
	handler: (call: Call) => Response | Promise<Response> = () =>
		Response.json({}),
) {
	const calls: Call[] = [];
	const fetch: Fetch = async (input, init) => {
		const req = new Request(input, init);
		const call: Call = {
			method: req.method,
			url: req.url,
			headers: Object.fromEntries(req.headers),
			body: await req.text(),
		};
		calls.push(call);
		return handler(call);
	};
	return { fetch, calls };
}

export const json = (call: Call) => JSON.parse(call.body) as unknown;
