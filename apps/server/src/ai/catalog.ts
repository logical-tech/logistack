import type { PriceCatalog } from "@logistack/core";
import { log } from "../log.ts";

/** Open model catalog with per-token prices; refreshed daily, no paid feed. */
const CATALOG_URL = "https://models.dev/api.json";
const TTL_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;

let cache: { at: number; data: PriceCatalog } | undefined;
let pending: Promise<PriceCatalog> | undefined;

/** Test seam: prices without the network. */
export function setPriceCatalog(data: PriceCatalog) {
	cache = { at: Date.now(), data };
}

/** The models.dev catalog, from memory when fresh. A failed refresh keeps the old copy and retries in an hour. */
export function priceCatalog(): Promise<PriceCatalog> {
	if (cache && Date.now() - cache.at < TTL_MS)
		return Promise.resolve(cache.data);
	pending ??= fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) })
		.then(async (res) => {
			if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
			const data = (await res.json()) as PriceCatalog;
			cache = { at: Date.now(), data };
			return data;
		})
		.catch((err) => {
			log("warn", "ai price catalog unavailable", { error: String(err) });
			const data = cache?.data ?? {};
			cache = { at: Date.now() - TTL_MS + RETRY_MS, data };
			return data;
		})
		.finally(() => {
			pending = undefined;
		});
	return pending;
}
