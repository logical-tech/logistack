import type { HomeDnsSettings } from "@logistack/contracts";

const hagezi = (name: string) =>
	`https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/${name}-onlydomains.txt`;

/** Block lists offered by name; the first is the recommended default. */
export const BLOCKLISTS = [
	{
		name: "Hagezi Pro",
		url: hagezi("pro"),
		description: "Ads, trackers and malware. Rarely breaks a site.",
	},
	{
		name: "Hagezi Light",
		url: hagezi("light"),
		description: "The essentials, almost no false positives.",
	},
	{
		name: "Hagezi Pro++",
		url: hagezi("pro.plus"),
		description: "Stricter. Expect to allow a site now and then.",
	},
	{
		name: "Hagezi Threat Intelligence",
		url: hagezi("tif"),
		description: "Malware, phishing and scams only.",
	},
	{
		name: "OISD big",
		url: "https://big.oisd.nl/domainswild2",
		description: "Broad, tuned not to break sites.",
	},
	{
		name: "StevenBlack hosts",
		url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
		description: "The classic unified hosts file.",
	},
] as const;

export const listName = (url: string) =>
	BLOCKLISTS.find((l) => l.url === url)?.name;

type Upstream = HomeDnsSettings["upstream"];

/** Resolvers over DNS-over-HTTPS, so the ISP sees neither the names nor the answers. */
export const UPSTREAMS: {
	id: string;
	name: string;
	description: string;
	upstream: Upstream;
}[] = [
	{
		id: "cloudflare",
		name: "Cloudflare",
		description: "1.1.1.1, fast almost everywhere.",
		upstream: {
			protocol: "Https",
			servers: [
				"https://cloudflare-dns.com/dns-query (1.1.1.1)",
				"https://cloudflare-dns.com/dns-query (1.0.0.1)",
			],
		},
	},
	{
		id: "quad9",
		name: "Quad9",
		description: "9.9.9.9, blocks known malicious domains, Swiss nonprofit.",
		upstream: {
			protocol: "Https",
			servers: [
				"https://dns.quad9.net/dns-query (9.9.9.9)",
				"https://dns.quad9.net/dns-query (149.112.112.112)",
			],
		},
	},
	{
		id: "google",
		name: "Google",
		description: "8.8.8.8, the widest anycast network.",
		upstream: {
			protocol: "Https",
			servers: [
				"https://dns.google/dns-query (8.8.8.8)",
				"https://dns.google/dns-query (8.8.4.4)",
			],
		},
	},
];

export const upstreamPreset = (u: Upstream | undefined) =>
	UPSTREAMS.find(
		(p) =>
			u &&
			p.upstream.protocol === u.protocol &&
			p.upstream.servers.join() === u.servers.join(),
	);

export const PROTOCOLS: Record<Upstream["protocol"], string> = {
	Https: "DNS-over-HTTPS",
	Tls: "DNS-over-TLS",
	Udp: "Plain DNS",
};
