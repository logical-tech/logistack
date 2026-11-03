import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { instanceSettings } from "@logistack/db";
import type { Ctx } from "./ctx.ts";

// shortcut: the address ranges of apps/server/src/ssrf.ts, copied because apps share code only through packages/*; move both there.
const blocked = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["100::", 64],
	["2001:db8::", 32],
	["2002::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	blocked.addSubnet(net, prefix, "ipv6");

const isPrivate = (a: string) => {
	const family = isIP(a);
	return family === 0 || blocked.check(a, family === 4 ? "ipv4" : "ipv6");
};

/**
 * The address a clone of a user-chosen host connects to: it must resolve, and to public
 * addresses only unless the instance allows private hosts. Callers pin the connection to it.
 */
export async function publicAddress(
	ctx: Ctx,
	hostname: string,
): Promise<string> {
	const host = hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host)
		? [host]
		: (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
	const first = addresses[0];
	if (!first) throw new Error(`${hostname} does not resolve`);
	const [s] = await ctx.db
		.select({ allow: instanceSettings.allowPrivateHosts })
		.from(instanceSettings);
	const bad = s?.allow ? undefined : addresses.find(isPrivate);
	if (bad)
		throw new Error(
			`${hostname} resolves to a private address (${bad}); an instance owner can allow private hosts in Settings`,
		);
	return first;
}
