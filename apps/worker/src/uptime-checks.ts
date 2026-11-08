import { Resolver } from "node:dns/promises";
import { isIP, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type {
	DnsConfig,
	HttpConfig,
	MonitorConfig,
	TcpConfig,
	TlsConfig,
} from "@logistack/contracts";
import { jsonPathGet, jsonText, statusMatches } from "@logistack/core";
import {
	BlockedHostError,
	type HostPolicy,
	isPrivateAddress,
	type Lookup,
	resolvePublic,
} from "@logistack/providers";
import type { CheckResult } from "./uptime-record.ts";

// The network side of uptime checks. Every target host goes through `resolvePublic` and the
// connection is pinned to the checked address (TLS keeps the requested name for SNI), so a
// monitor cannot be pointed at internal addresses unless the instance allows private hosts.

export type CheckEnv = { policy: HostPolicy; resolve?: Lookup };

const MAX_BODY = 1 << 20;
const MAX_REDIRECTS = 5;
const UA = "LogiStack-Uptime/1";

const message = (e: unknown) =>
	e instanceof Error
		? e.name === "TimeoutError" || e.name === "AbortError"
			? "timed out"
			: e.message
		: String(e);

const pin = (address: string) =>
	isIP(address) === 6 ? `[${address}]` : address;

async function readCapped(res: Response): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
		if (size >= MAX_BODY) {
			await reader.cancel();
			break;
		}
	}
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY));
}

export async function httpCheck(
	cfg: HttpConfig,
	timeoutMs: number,
	env: CheckEnv,
): Promise<CheckResult> {
	const signal = AbortSignal.timeout(timeoutMs);
	const start = performance.now();
	let url = new URL(cfg.url);
	let method = cfg.method;
	let body = cfg.body;
	let res: Response;
	for (let hop = 0; ; hop++) {
		if (url.protocol !== "http:" && url.protocol !== "https:")
			return { ok: false, error: `redirect to ${url.protocol} refused` };
		const address = await resolvePublic(url.hostname, env.policy, env.resolve);
		const pinned = new URL(url);
		pinned.hostname = pin(address);
		const headers = new Headers(cfg.headers.map((h) => [h.name, h.value]));
		headers.set("host", url.host);
		if (!headers.has("user-agent")) headers.set("user-agent", UA);
		res = await fetch(pinned, {
			method,
			headers,
			...(body !== undefined &&
				method !== "GET" &&
				method !== "HEAD" && { body }),
			redirect: "manual",
			signal,
			tls: { serverName: url.hostname },
		} as RequestInit);
		const location = res.headers.get("location");
		if (
			!cfg.followRedirects ||
			res.status < 300 ||
			res.status >= 400 ||
			!location ||
			hop >= MAX_REDIRECTS
		)
			break;
		await res.body?.cancel();
		// Each hop is resolved and checked again: its target was never vetted.
		url = new URL(location, url);
		if (res.status !== 307 && res.status !== 308) {
			method = method === "HEAD" ? "HEAD" : "GET";
			body = undefined;
		}
	}
	const latencyMs = Math.round(performance.now() - start);
	const fail = (error: string): CheckResult => ({
		ok: false,
		latencyMs,
		error,
	});
	if (!statusMatches(res.status, cfg.statusCodes)) {
		await res.body?.cancel();
		return fail(`HTTP ${res.status}, expected ${cfg.statusCodes.join(", ")}`);
	}
	if (cfg.keyword || cfg.jsonPath) {
		const text = await readCapped(res);
		if (cfg.keyword) {
			const { value, invert, caseSensitive } = cfg.keyword;
			const found = caseSensitive
				? text.includes(value)
				: text.toLowerCase().includes(value.toLowerCase());
			if (found === invert)
				return fail(
					invert
						? `body contains "${value}"`
						: `body does not contain "${value}"`,
				);
		}
		if (cfg.jsonPath) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return fail("body is not JSON");
			}
			const got = jsonText(jsonPathGet(parsed, cfg.jsonPath.path));
			if (got !== cfg.jsonPath.equals)
				return fail(
					`${cfg.jsonPath.path} is "${got.slice(0, 80)}", expected "${cfg.jsonPath.equals}"`,
				);
		}
	} else await res.body?.cancel();
	if (cfg.maxLatencyMs !== undefined && latencyMs > cfg.maxLatencyMs)
		return fail(`answered in ${latencyMs} ms, limit ${cfg.maxLatencyMs} ms`);
	return { ok: true, latencyMs };
}

function withTimeout<T>(
	timeoutMs: number,
	run: (done: (v: T) => void, fail: (e: unknown) => void) => () => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let cleanup = () => {};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("timed out"));
		}, timeoutMs);
		cleanup = run(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

export async function tcpCheck(
	cfg: TcpConfig,
	timeoutMs: number,
	env: CheckEnv,
): Promise<CheckResult> {
	const address = await resolvePublic(cfg.host, env.policy, env.resolve);
	const start = performance.now();
	await withTimeout<void>(timeoutMs, (done, fail) => {
		const s = netConnect({ host: address, port: cfg.port });
		s.once("connect", () => {
			s.end();
			done();
		});
		s.once("error", fail);
		return () => s.destroy();
	});
	return { ok: true, latencyMs: Math.round(performance.now() - start) };
}

export async function dnsCheck(
	cfg: DnsConfig,
	timeoutMs: number,
	env: CheckEnv,
): Promise<CheckResult> {
	const r = new Resolver({ timeout: timeoutMs, tries: 1 });
	if (cfg.resolver) {
		if (!env.policy.allowPrivateHosts && isPrivateAddress(cfg.resolver))
			throw new BlockedHostError(
				`resolver ${cfg.resolver} is a private address; an instance owner can allow private hosts in Settings`,
			);
		r.setServers([cfg.resolver]);
	}
	const start = performance.now();
	const h = cfg.hostname;
	const answers: string[] = await (async () => {
		switch (cfg.recordType) {
			case "A":
				return r.resolve4(h);
			case "AAAA":
				return r.resolve6(h);
			case "CNAME":
				return r.resolveCname(h);
			case "NS":
				return r.resolveNs(h);
			case "MX":
				return (await r.resolveMx(h)).map((m) => `${m.priority} ${m.exchange}`);
			case "TXT":
				return (await r.resolveTxt(h)).map((t) => t.join(""));
		}
	})();
	const latencyMs = Math.round(performance.now() - start);
	if (answers.length === 0) return { ok: false, latencyMs, error: "no answer" };
	if (cfg.expected && !answers.some((a) => a.includes(cfg.expected as string)))
		return {
			ok: false,
			latencyMs,
			error: `answers ${answers.slice(0, 3).join(", ")} lack "${cfg.expected}"`,
		};
	return { ok: true, latencyMs };
}

export async function tlsCheck(
	cfg: TlsConfig,
	timeoutMs: number,
	env: CheckEnv,
	now = new Date(),
): Promise<CheckResult> {
	const address = await resolvePublic(cfg.host, env.policy, env.resolve);
	const start = performance.now();
	const peer = await withTimeout<{
		validTo: string;
		authorized: boolean;
		error?: string;
	}>(timeoutMs, (done, fail) => {
		const s = tlsConnect({
			host: address,
			port: cfg.port,
			// SNI and verification use the monitored name, not the pinned IP.
			servername: isIP(cfg.host) ? undefined : cfg.host,
			rejectUnauthorized: false,
		});
		s.once("secureConnect", () => {
			const cert = s.getPeerCertificate();
			done({
				validTo: cert.valid_to,
				authorized: s.authorized,
				...(s.authorizationError && {
					error: String(s.authorizationError),
				}),
			});
			s.end();
		});
		s.once("error", fail);
		return () => s.destroy();
	});
	const latencyMs = Math.round(performance.now() - start);
	const certExpiresAt = new Date(peer.validTo);
	if (Number.isNaN(certExpiresAt.getTime()))
		return { ok: false, latencyMs, error: "no certificate" };
	if (certExpiresAt <= now)
		return {
			ok: false,
			latencyMs,
			certExpiresAt,
			error: `certificate expired on ${certExpiresAt.toISOString().slice(0, 10)}`,
		};
	if (!peer.authorized)
		return {
			ok: false,
			latencyMs,
			certExpiresAt,
			error: `certificate not trusted: ${peer.error ?? "unknown"}`,
		};
	return { ok: true, latencyMs, certExpiresAt };
}

/** Runs one check; every error, a blocked host included, is a failed result. */
export async function runCheck(
	config: MonitorConfig,
	timeoutMs: number,
	env: CheckEnv,
): Promise<CheckResult> {
	try {
		switch (config.kind) {
			case "http":
				return await httpCheck(config.http, timeoutMs, env);
			case "tcp":
				return await tcpCheck(config.tcp, timeoutMs, env);
			case "dns":
				return await dnsCheck(config.dns, timeoutMs, env);
			case "tls":
				return await tlsCheck(config.tls, timeoutMs, env);
			case "push":
				return { ok: false, error: "no ping received in time" };
		}
	} catch (e) {
		return { ok: false, error: message(e) };
	}
}
