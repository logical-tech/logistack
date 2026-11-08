import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Server-side requests to user-provided hosts go through here: the name is resolved
 * once, every address must be public, and the connection is pinned to the checked
 * address so a second DNS answer (rebinding) cannot point it elsewhere.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8], // "this" network
	["10.0.0.0", 8],
	["100.64.0.0", 10], // carrier-grade NAT, incl. Alibaba's 100.100.100.200 metadata
	["127.0.0.0", 8],
	["169.254.0.0", 16], // link-local, incl. 169.254.169.254 metadata
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved and broadcast
] as const)
	blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 128], // unspecified
	["::1", 128],
	["64:ff9b::", 96], // NAT64 can reach any IPv4, private ones included
	["100::", 64], // discard
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4 embeds an arbitrary IPv4
	["fc00::", 7], // unique local, incl. fd00:ec2::254 metadata
	["fe80::", 10], // link-local
	["ff00::", 8], // multicast
] as const)
	blocked.addSubnet(net, prefix, "ipv6");

/** True for loopback, private, link-local, metadata and other non-public addresses (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return true;
	return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export class BlockedHostError extends Error {}

export type HostPolicy = { allowPrivateHosts: boolean };

export type Lookup = (hostname: string) => Promise<string[]>;

const systemLookup: Lookup = async (hostname) =>
	(await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * The address to connect to for `hostname`. Throws `BlockedHostError` when the name
 * does not resolve or any of its addresses is private, unless the policy allows it.
 */
export async function resolvePublic(
	hostname: string,
	policy: HostPolicy,
	resolve: Lookup = systemLookup,
): Promise<string> {
	const host = hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host)
		? [host]
		: await resolve(host).catch(() => {
				throw new BlockedHostError(`${hostname} does not resolve`);
			});
	const first = addresses[0];
	if (!first) throw new BlockedHostError(`${hostname} does not resolve`);
	if (!policy.allowPrivateHosts) {
		const bad = addresses.find(isPrivateAddress);
		if (bad)
			throw new BlockedHostError(
				`${hostname} resolves to a private address (${bad}); an instance owner can allow private hosts in Settings`,
			);
	}
	return first;
}

/**
 * `fetch` to a user-provided https URL, pinned to its checked address. Redirects are
 * not followed: a 3xx comes back as is, since its target was never checked.
 */
export async function guardedFetch(
	input: string | URL,
	init: RequestInit,
	policy: HostPolicy,
	resolve?: Lookup,
	/** Also allow http:// to a private address once private hosts are allowed (internal secret managers). */
	privateHttp = false,
): Promise<Response> {
	const url = new URL(input);
	const http =
		url.protocol === "http:" && privateHttp && policy.allowPrivateHosts;
	if (url.protocol !== "https:" && !http)
		throw new BlockedHostError("only https URLs are allowed");
	const address = await resolvePublic(url.hostname, policy, resolve);
	if (http && !isPrivateAddress(address))
		throw new BlockedHostError(
			"plain http is allowed only to a private address",
		);
	const pinned = new URL(url);
	pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
	const headers = new Headers(init.headers);
	headers.set("host", url.host);
	return fetch(pinned, {
		...init,
		headers,
		redirect: "manual",
		// Certificate and SNI stay those of the requested name, not of the IP.
		tls: { serverName: url.hostname },
	} as RequestInit);
}

/**
 * {@link guardedFetch} bound to a policy, as the `fetch` a provider takes: every request resolves,
 * checks and pins its own host, so no later DNS answer is ever dialled.
 */
export const pinnedFetch =
	(
		policy: HostPolicy,
		opts: { privateHttp?: boolean; resolve?: Lookup } = {},
	) =>
	(input: string | URL, init: RequestInit = {}): Promise<Response> =>
		guardedFetch(input, init, policy, opts.resolve, opts.privateHttp ?? false);
