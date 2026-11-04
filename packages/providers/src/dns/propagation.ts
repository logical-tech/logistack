import { type Fetch, ProviderError } from "../http.ts";
import { type DnsRecordType, normalizeName, unquoteTxt } from "./types.ts";

/** DNS-over-HTTPS JSON endpoints (`?name=&type=`, `accept: application/dns-json`). */
export const dohResolvers = {
	cloudflare: "https://cloudflare-dns.com/dns-query",
	google: "https://dns.google/resolve",
} as const;

const typeCodes: Record<DnsRecordType, number> = {
	A: 1,
	CNAME: 5,
	TXT: 16,
	AAAA: 28,
	NS: 2,
	MX: 15,
	SRV: 33,
	CAA: 257,
};

export type PropagationOptions = {
	fetch?: Fetch;
	/** Overall deadline. */
	timeoutMs?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

const normalizeAnswer = (type: DnsRecordType, data: string) =>
	type === "TXT"
		? unquoteTxt(data)
		: type === "CNAME"
			? normalizeName(data)
			: data.toLowerCase();

async function resolves(
	f: Fetch,
	resolver: string,
	hostname: string,
	type: DnsRecordType,
	expected: string,
): Promise<boolean> {
	const url = `${resolver}?name=${encodeURIComponent(hostname)}&type=${type}`;
	try {
		const res = await f(url, {
			headers: { accept: "application/dns-json" },
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as {
			Answer?: { type: number; data: string }[];
		};
		return (body.Answer ?? []).some(
			(a) =>
				a.type === typeCodes[type] &&
				normalizeAnswer(type, a.data) === expected,
		);
	} catch {
		return false;
	}
}

/**
 * Polls every resolver until each one answers `expected`, backing off exponentially.
 * Throws ProviderError when the deadline passes first.
 */
export async function waitForPropagation(
	hostname: string,
	expected: { type: DnsRecordType; content: string },
	resolvers: readonly string[] = Object.values(dohResolvers),
	opts: PropagationOptions = {},
): Promise<void> {
	const f = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? Bun.sleep;
	const now = opts.now ?? Date.now;
	const deadline = now() + (opts.timeoutMs ?? 300_000);
	const want = normalizeAnswer(expected.type, expected.content);
	const host = normalizeName(hostname);
	let delay = opts.initialDelayMs ?? 2_000;
	const pending = new Set(resolvers);
	while (true) {
		for (const r of [...pending])
			if (await resolves(f, r, host, expected.type, want)) pending.delete(r);
		if (pending.size === 0) return;
		if (now() + delay > deadline)
			throw new ProviderError(
				"dns",
				"waitForPropagation",
				`${host} ${expected.type} not visible on ${[...pending].join(", ")}`,
			);
		await sleep(delay);
		delay = Math.min(delay * 2, opts.maxDelayMs ?? 30_000);
	}
}
