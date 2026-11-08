/** An external secret manager, read at deploy time. Errors are `ProviderError`s and never carry values. */
export type SecretSource = {
	/** Signs in and checks the configured scope is reachable. */
	test(): Promise<void>;
	/** The value of `key` at `path`, as the reference names them. */
	read(path: string[], key: string): Promise<string>;
};

/** Secrets are strings; a structured field (Vault allows JSON) is passed on as JSON. */
export const asString = (v: unknown) =>
	typeof v === "string" ? v : JSON.stringify(v);

/** Caches one promise per key for the instance's life (one deploy), dropping failures. */
export function memo<T>(fn: (key: string) => Promise<T>) {
	const cache = new Map<string, Promise<T>>();
	return (key: string) => {
		let p = cache.get(key);
		if (!p) {
			p = fn(key);
			p.catch(() => cache.delete(key));
			cache.set(key, p);
		}
		return p;
	};
}

export const trimUrl = (url: string) => url.replace(/\/+$/, "");
