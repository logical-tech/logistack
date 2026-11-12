/** Why the dashboard's new address does not answer from this browser, named so the page can say what to change. */
export type Diagnosis =
	/** The name points at the router's public IP and this browser is on the LAN: no hairpin NAT, or no port forward. */
	| { kind: "nat"; publicIp: string; lanIp: string }
	| { kind: "unresolved" }
	| { kind: "silent"; addresses: string[] };

/** After POST /setup: the browser stays on the bootstrap origin until it can reach the dashboard's own. */
export type Move =
	| { kind: "checking"; since: number }
	| { kind: "reachable" }
	| { kind: "unreachable"; diagnosis: Diagnosis };

const octets = (ip: string) => {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	const parts = m?.slice(1).map(Number);
	return parts?.every((n) => n <= 255) ? parts : null;
};

/** RFC 1918 and CGNAT: addresses a browser on the same network as the server would use. */
export function isPrivateIpv4(ip: string) {
	const o = octets(ip);
	if (!o) return false;
	const [a = 0, b = 0] = o;
	return (
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

/**
 * The server's LAN address when this page was opened through one: the raw IP, or the bootstrap
 * sslip.io / nip.io name that encodes it (`192-168-1-39.sslip.io`, `192.168.1.39.nip.io`).
 */
export function lanAddress(browserHostname: string): string | null {
	const m = /^(.+?)\.(?:sslip|nip)\.io$/.exec(browserHostname);
	const ip = (m?.[1] ?? browserHostname).replaceAll("-", ".");
	return isPrivateIpv4(ip) ? ip : null;
}

export function diagnose(facts: {
	resolvesTo: string[];
	publicIp: string | null;
	browserHostname: string;
}): Diagnosis {
	if (facts.resolvesTo.length === 0) return { kind: "unresolved" };
	const lanIp = lanAddress(facts.browserHostname);
	if (lanIp && facts.publicIp && facts.resolvesTo.includes(facts.publicIp))
		return { kind: "nat", publicIp: facts.publicIp, lanIp };
	return { kind: "silent", addresses: facts.resolvesTo };
}
