import type { ProxyInput, ProxyRoute } from "../src/index.ts";

export const settings: ProxyInput["settings"] = {
	adminListen: "0.0.0.0:2019",
	acmeEmail: "ops@example.com",
	storage: {
		redisUrl: "redis://:s3cret@ls-redis:6379/2",
		keyPrefix: "logistack/caddy",
	},
};

export const dashboard: ProxyInput["dashboard"] = {
	hostname: "ls.example.com",
	upstream: { host: "logistack-api", port: 3000 },
};

export const cf = {
	provider: "cloudflare",
	credentials: { api_token: "cf-token" },
} as const;

export const routes: ProxyRoute[] = [
	{
		domainId: "d1",
		hostname: "app.example.com",
		upstream: { host: "ls-svc-a1", port: 8080 },
		https: true,
		cert: "auto",
	},
	{
		domainId: "d2",
		hostname: "app.example.com",
		pathPrefix: "/api",
		upstream: { host: "ls-svc-b2", port: 3000 },
		https: true,
		cert: "auto",
	},
	{
		domainId: "d3",
		hostname: "*.preview.example.com",
		upstream: { host: "ls-svc-c3", port: 80 },
		https: true,
		cert: "auto",
		dnsChallenge: cf,
	},
	{
		domainId: "d4",
		hostname: "shop.example.org",
		upstream: { host: "ls-svc-d4", port: 80 },
		https: true,
		cert: "custom",
		customCert: { id: "c1", certPem: "CERT-PEM", keyPem: "KEY-PEM" },
	},
	{
		domainId: "d5",
		hostname: "www.example.com",
		upstream: { host: "ls-svc-a1", port: 8080 },
		https: true,
		cert: "auto",
		redirectTo: "https://app.example.com/",
	},
	{
		domainId: "d6",
		hostname: "legacy.internal.test",
		upstream: { host: "ls-svc-e5", port: 80 },
		https: false,
		cert: "none",
	},
	{
		domainId: "d7",
		hostname: "api.example.net",
		upstream: { host: "ls-svc-f6", port: 80 },
		https: true,
		cert: "auto",
		dnsChallenge: cf,
	},
];

export const input: ProxyInput = { settings, dashboard, routes };
