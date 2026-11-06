/** USD per million tokens, as models.dev publishes them. */
export type ModelPrice = { input: number; output: number; cacheRead?: number };

/** The parts of the models.dev `api.json` document we read. */
export type PriceCatalog = Record<
	string,
	{
		models?: Record<
			string,
			{ cost?: { input?: number; output?: number; cache_read?: number } }
		>;
	}
>;

export type TokenUsage = { input: number; output: number; cached: number };

const SUFFIXES =
	/(-instruct|-versatile|-fp8-fast|-fp8|-latest|-preview|-chat)+$/;

/** One spelling for the same model across providers: `meta/Llama-3.3-70B-Instruct` → `llama-3.3-70b`. */
export function normalizeModelId(id: string): string {
	const last = id.toLowerCase().split(":")[0]?.split("/").at(-1) ?? "";
	return last.replace(SUFFIXES, "");
}

function toPrice(cost: {
	input?: number;
	output?: number;
	cache_read?: number;
}): ModelPrice | undefined {
	const input = cost.input ?? 0;
	const output = cost.output ?? 0;
	if (input <= 0 && output <= 0) return undefined;
	return { input, output, cacheRead: cost.cache_read };
}

/**
 * The price of `model` on `catalogId`, else the cheapest paid listing of the same model on any
 * provider: what a free call would have cost on the market. Undefined when nobody sells it.
 */
export function priceFor(
	catalog: PriceCatalog,
	catalogId: string | undefined,
	model: string,
): ModelPrice | undefined {
	const own = catalogId ? catalog[catalogId]?.models : undefined;
	const exact = own?.[model]?.cost ?? own?.[model.replace(/:free$/, "")]?.cost;
	const direct = exact && toPrice(exact);
	if (direct) return direct;
	const want = normalizeModelId(model);
	let best: ModelPrice | undefined;
	for (const provider of Object.values(catalog))
		for (const [id, m] of Object.entries(provider.models ?? {})) {
			if (!m.cost || normalizeModelId(id) !== want) continue;
			const p = toPrice(m.cost);
			if (p && (!best || p.input + p.output < best.input + best.output))
				best = p;
		}
	return best;
}

/** Cost in micro-dollars, rounded up so a call is never free by rounding. Cached input is billed at its own rate. */
export function costMicros(
	price: ModelPrice | undefined,
	usage: TokenUsage,
): number {
	if (!price) return 0;
	const cached = Math.min(usage.cached, usage.input);
	const usd =
		(usage.input - cached) * price.input +
		cached * (price.cacheRead ?? price.input) +
		usage.output * price.output;
	// usd is per million tokens, and a micro-dollar is a millionth: the scales cancel.
	return Math.ceil(usd);
}
