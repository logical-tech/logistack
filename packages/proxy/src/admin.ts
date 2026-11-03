import type { CaddyConfig } from "./caddy.ts";

export type CaddyAdminFailure =
	| { kind: "http"; status: number; body: string }
	| { kind: "timeout"; timeoutMs: number }
	| { kind: "network"; message: string };

export class CaddyAdminError extends Error {
	constructor(
		readonly endpoint: string,
		readonly failure: CaddyAdminFailure,
	) {
		super(`caddy admin ${endpoint}: ${describe(failure)}`);
		this.name = "CaddyAdminError";
	}
}

function describe(f: CaddyAdminFailure): string {
	switch (f.kind) {
		case "http":
			return `HTTP ${f.status}: ${f.body}`;
		case "timeout":
			return `timed out after ${f.timeoutMs}ms`;
		case "network":
			return f.message;
	}
}

export const DEFAULT_ADMIN_TIMEOUT_MS = 30_000;

/** Client for one Caddy admin endpoint, e.g. `http://ls-caddy-node1:2019`. */
export class CaddyAdmin {
	constructor(
		readonly endpoint: string,
		readonly timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
	) {}

	/** Replaces the whole running config. Caddy keeps the old config if the new one fails to load. */
	async load(config: CaddyConfig): Promise<void> {
		await this.request("POST", "/load", JSON.stringify(config));
	}

	/** Returns the running config, or null when Caddy runs with an empty one. */
	async getConfig(): Promise<CaddyConfig | null> {
		const body = await this.request("GET", "/config/");
		return JSON.parse(body) as CaddyConfig | null;
	}

	private async request(
		method: string,
		path: string,
		body?: string,
	): Promise<string> {
		let res: Response;
		let text: string;
		try {
			res = await fetch(`${this.endpoint}${path}`, {
				method,
				body,
				headers:
					body === undefined ? {} : { "Content-Type": "application/json" },
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			text = await res.text();
		} catch (err) {
			if (err instanceof DOMException && err.name === "TimeoutError") {
				throw new CaddyAdminError(this.endpoint, {
					kind: "timeout",
					timeoutMs: this.timeoutMs,
				});
			}
			throw new CaddyAdminError(this.endpoint, {
				kind: "network",
				message: String(err),
			});
		}
		if (!res.ok)
			throw new CaddyAdminError(this.endpoint, {
				kind: "http",
				status: res.status,
				body: text,
			});
		return text;
	}
}
