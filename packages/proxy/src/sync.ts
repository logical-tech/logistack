import { CaddyAdmin, type CaddyAdminError } from "./admin.ts";
import type { CaddyConfig } from "./caddy.ts";

export type InstanceResult =
	| { endpoint: string; ok: true; ms: number }
	| { endpoint: string; ok: false; ms: number; error: CaddyAdminError };

/**
 * Pushes one compiled config to every Caddy instance.
 *
 * Run it only from the worker (behind `coalesce`), never inline in an HTTP request handler.
 * A request that reaches the API through Caddy and waits on /load is waiting on the proxy it
 * is passing through; when /load drains old servers before returning, that is a deadlock
 * (docs/PIANO.md §3.3). Caddy 2.11.7 drains in the background, so the hang does not reproduce
 * today, but the rule keeps us safe from that coupling, and each uncoalesced push is a reload
 * that drops a few new connections (docs/spikes/proxy.md).
 */
export class ProxySync {
	readonly admins: CaddyAdmin[];

	constructor(endpoints: string[], timeoutMs?: number) {
		this.admins = endpoints.map((e) => new CaddyAdmin(e, timeoutMs));
	}

	push(config: CaddyConfig): Promise<InstanceResult[]> {
		return Promise.all(
			this.admins.map(async (admin): Promise<InstanceResult> => {
				const start = performance.now();
				try {
					await admin.load(config);
					return {
						endpoint: admin.endpoint,
						ok: true,
						ms: performance.now() - start,
					};
				} catch (error) {
					return {
						endpoint: admin.endpoint,
						ok: false,
						ms: performance.now() - start,
						error: error as CaddyAdminError,
					};
				}
			}),
		);
	}
}

/**
 * Coalesces calls made within `windowMs` of the first one into a single `fn` call with the
 * last value; every caller in the window gets that call's result. Runs never overlap, so a
 * slow older push can never land after a newer one.
 */
export function coalesce<T, R>(
	fn: (value: T) => Promise<R>,
	windowMs: number,
): (value: T) => Promise<R> {
	let pending: { value: T; waiters: PromiseWithResolvers<R>[] } | null = null;
	let running: Promise<unknown> = Promise.resolve();

	return (value) => {
		const waiter = Promise.withResolvers<R>();
		if (pending) {
			pending.value = value;
			pending.waiters.push(waiter);
			return waiter.promise;
		}
		const batch = { value, waiters: [waiter] };
		pending = batch;
		const timer = new Promise((r) => setTimeout(r, windowMs));
		running = Promise.all([running, timer]).then(async () => {
			pending = null;
			try {
				const result = await fn(batch.value);
				for (const w of batch.waiters) w.resolve(result);
			} catch (err) {
				for (const w of batch.waiters) w.reject(err);
			}
		});
		return waiter.promise;
	};
}
