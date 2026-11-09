import type {
	CaddyAutomationPolicy,
	CaddyConfig,
	CaddyHandler,
	CaddyHeaderOps,
	CaddyIssuer,
	CaddyLoadedPem,
	CaddyMatcher,
	CaddyRedisStorage,
	CaddyRoute,
	CaddyServer,
} from "./caddy.ts";
import { WEB_ANALYTICS_SCRIPT } from "./web-analytics.ts";

export type Upstream = { host: string; port: number };

/** Credential keys are the JSON fields of each caddy-dns module. */
export type DnsChallenge =
	| { provider: "cloudflare"; credentials: { api_token: string } }
	| {
			provider: "route53";
			credentials: {
				access_key_id: string;
				secret_access_key: string;
				region: string;
			};
	  }
	| { provider: "hetzner"; credentials: { api_token: string } }
	| { provider: "digitalocean"; credentials: { auth_token: string } }
	| {
			provider: "ovh";
			credentials: {
				endpoint: string;
				application_key: string;
				application_secret: string;
				consumer_key: string;
			};
	  }
	| {
			provider: "porkbun";
			credentials: { api_key: string; api_secret_key: string };
	  }
	/** caddy-dns/acmeproxy: POSTs present/cleanup to our api, which asks a plugin's DNS provider. */
	| {
			provider: "acmeproxy";
			credentials: { endpoint: string; username: string; password: string };
	  };

export type CustomCert = { id: string; certPem: string; keyPem: string };

export type RouteTls =
	| { https: false; cert: "none" }
	| { https: true; cert: "auto"; dnsChallenge?: DnsChallenge }
	| { https: true; cert: "custom"; customCert: CustomCert };

export type ProxyRoute = RouteTls & {
	domainId: string;
	/** Exact host or a single-label wildcard (`*.app.example.com`); wildcards need `dnsChallenge`. */
	hostname: string;
	upstream: Upstream;
	pathPrefix?: string;
	/** Origin to redirect to (`https://example.com`); path and query are preserved. Replaces the upstream. */
	redirectTo?: string;
	/** Checks in front of the upstream, at most one per type. Not applied to a redirect. */
	access?: AccessRule[];
	/** Answer `<prefix>/_ls/a.js` (the analytics script) and `<prefix>/_ls/e` (its beacon) here. */
	webAnalytics?: boolean;
	/** Edge rules, run before `access`. None of them applies to a redirect. */
	edge?: EdgeRules;
	/** Set while the service is in maintenance: 503 with `page`, except for clients in `allowCidrs`. */
	maintenance?: { allowCidrs: string[]; page: string };
};

export type EdgeRules = {
	/** Requests per second per client IP with `burst` on top; over it, 429. `exemptCidrs` skip it. */
	rateLimit?: {
		requestsPerSecond: number;
		burst: number;
		exemptCidrs: string[];
	};
	/** 403 for a path matching a glob or a User-Agent containing a fragment (case-insensitive). */
	block?: { paths: string[]; userAgents: string[] };
	/** HTML served with the status when the proxy itself fails with 502, 503 or 504. */
	errorPage?: string;
};

/** Compiled in a fixed order whatever the input order: IP allowlist, then forward auth, then basic auth. */
export type AccessRule =
	| { type: "ip_allow"; cidrs: string[]; trustedProxies?: string[] }
	| { type: "forward_auth"; url: string; copyHeaders: string[] }
	/** `hash` is bcrypt, as Caddy checks it. */
	| { type: "basic_auth"; users: { username: string; hash: string }[] };

export type ProxySettings = {
	adminListen: string;
	acmeEmail: string;
	storage: { redisUrl: string; keyPrefix: string; encryptionKey?: string };
	/** Fallback issuer after Let's Encrypt, using ZeroSSL ACME with EAB credentials. */
	zerossl?: { keyId: string; macKey: string };
};

export type ProxyInput = {
	settings: ProxySettings;
	dashboard: { hostname: string; upstream: Upstream };
	routes: ProxyRoute[];
};

export const GRACE_PERIOD = "10s";
const ACCESS_LOGGER = "ls-access";
const LETSENCRYPT = "https://acme-v02.api.letsencrypt.org/directory";
const ZEROSSL = "https://acme.zerossl.com/v2/DV90";

const NOT_FOUND_BODY =
	'<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head>' +
	'<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#555">' +
	"<div><h1>404</h1><p>No application is configured for this address.</p></div></body></html>";

// @id must be unique across the whole config, so each server gets its own copy.
const notFound = (server: string): CaddyRoute => ({
	"@id": `ls-not-found-${server}`,
	handle: [
		{
			handler: "static_response",
			status_code: 404,
			headers: { "Content-Type": ["text/html; charset=utf-8"] },
			body: NOT_FOUND_BODY,
		},
	],
	terminal: true,
});

export const routeId = (domainId: string) => `ls-domain-${domainId}`;

export function compileProxy(input: ProxyInput): CaddyConfig {
	const { settings } = input;
	for (const r of input.routes) {
		if (isWildcard(r.hostname) && !(r.cert === "auto" && r.dnsChallenge)) {
			throw new Error(
				`domain ${r.domainId}: wildcard ${r.hostname} needs cert "auto" with a DNS challenge`,
			);
		}
	}
	const routes = [...input.routes].sort(compareRoutes);
	const httpsRoutes = routes.filter((r) => r.https);
	const httpRoutes = routes.filter((r) => !r.https);
	const httpsHosts = unique([
		input.dashboard.hostname,
		...httpsRoutes.map((r) => r.hostname),
	]);
	const certs = loadedCerts(httpsRoutes);

	const dashboardRoute: CaddyRoute = {
		"@id": "ls-dashboard",
		match: [{ host: [input.dashboard.hostname] }],
		// The connection's own address, overwriting anything the client sent: the api's sign-in
		// limit and audit log key on it, and X-Forwarded-For is client-controlled whenever any
		// domain on this shared server trusts a proxy.
		handle: [
			proxyTo(input.dashboard.upstream, {
				set: { [CLIENT_IP_HEADER]: ["{http.request.remote.host}"] },
			}),
		],
		terminal: true,
	};

	return {
		// No autosave: the worker pushes the whole config, and a file on disk is one more copy of its secrets.
		admin: { listen: settings.adminListen, config: { persist: false } },
		logging: {
			logs: {
				default: {
					writer: { output: "stderr" },
					encoder: { format: "json" },
					exclude: [`http.log.access.${ACCESS_LOGGER}`],
				},
				access: {
					writer: { output: "stdout" },
					encoder: { format: "json" },
					include: [`http.log.access.${ACCESS_LOGGER}`],
				},
			},
		},
		storage: redisStorage(settings.storage),
		apps: {
			http: {
				http_port: 80,
				https_port: 443,
				grace_period: GRACE_PERIOD,
				servers: {
					https: {
						listen: [":443"],
						routes: [
							dashboardRoute,
							...httpsRoutes.map(compileRoute),
							notFound("https"),
						],
						// Redirects are emitted on the http server; hosts with a loaded custom cert are
						// skipped by automatic HTTPS on their own.
						automatic_https: { disable_redirects: true },
						logs: { default_logger_name: ACCESS_LOGGER },
						...trustedProxies(httpsRoutes),
						...errorRoutes(httpsRoutes),
					},
					http: {
						listen: [":80"],
						routes: [
							{
								"@id": "ls-https-redirect",
								match: [{ host: httpsHosts }],
								handle: [
									redirect("https://{http.request.host}{http.request.uri}"),
								],
								terminal: true,
							},
							...httpRoutes.map(compileRoute),
							notFound("http"),
						],
						logs: { default_logger_name: ACCESS_LOGGER },
						...trustedProxies(httpRoutes),
						...errorRoutes(httpRoutes),
					},
				},
			},
			tls: {
				...(certs.length > 0 && { certificates: { load_pem: certs } }),
				automation: { policies: automationPolicies(httpsRoutes, settings) },
			},
		},
	};
}

function routeMatcher(r: ProxyRoute): CaddyMatcher {
	const match: CaddyMatcher = { host: [r.hostname] };
	const base = r.pathPrefix?.replace(/\/+$/, "");
	if (base) match.path = [base, `${base}/*`];
	return match;
}

function compileRoute(r: ProxyRoute): CaddyRoute {
	return {
		"@id": routeId(r.domainId),
		match: [routeMatcher(r)],
		handle: r.redirectTo
			? [redirect(`${r.redirectTo.replace(/\/+$/, "")}{http.request.uri}`)]
			: [
					// Blocking first so a blocked client never spends rate budget; the maintenance page is rate limited too.
					...(r.edge?.block ? blockHandler(r.edge.block) : []),
					...(r.edge?.rateLimit
						? [rateLimitHandler(r.domainId, r.edge.rateLimit)]
						: []),
					...(r.maintenance ? [maintenanceHandler(r.maintenance)] : []),
					...accessHandlers(r.access ?? []),
					...(r.webAnalytics
						? [webAnalytics(r.pathPrefix?.replace(/\/+$/, "") ?? "")]
						: []),
					proxyTo(r.upstream),
				],
		terminal: true,
	};
}

const regexpEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function blockHandler({
	paths,
	userAgents,
}: NonNullable<EdgeRules["block"]>): CaddyHandler[] {
	const match: CaddyMatcher[] = [];
	if (paths.length) match.push({ path: unique(paths) });
	if (userAgents.length)
		match.push({
			header_regexp: {
				"User-Agent": {
					pattern: `(?i)(?:${unique(userAgents).map(regexpEscape).join("|")})`,
				},
			},
		});
	if (!match.length) return [];
	return [
		{
			handler: "subroute",
			routes: [
				{
					match,
					handle: [
						{ handler: "static_response", status_code: 403, body: "Forbidden" },
					],
				},
			],
		},
	];
}

/**
 * A sliding window of `burst` requests over `burst / rate` seconds: a client may send `burst` at once
 * and then `rate` per second on average. Keyed on `client_ip`, which is the connection address unless
 * the server trusts proxies.
 */
function rateLimitHandler(
	domainId: string,
	{
		requestsPerSecond,
		burst,
		exemptCidrs,
	}: NonNullable<EdgeRules["rateLimit"]>,
): CaddyHandler {
	const limit: CaddyHandler = {
		handler: "rate_limit",
		rate_limits: {
			[`ls-${domainId}`]: {
				key: "{http.vars.client_ip}",
				window: `${Math.max(1, Math.round((burst * 1000) / requestsPerSecond))}ms`,
				max_events: burst,
			},
		},
	};
	if (!exemptCidrs.length) return limit;
	return {
		handler: "subroute",
		routes: [
			{
				match: [{ not: [{ client_ip: { ranges: unique(exemptCidrs) } }] }],
				handle: [limit],
			},
		],
	};
}

function maintenanceHandler({
	allowCidrs,
	page,
}: NonNullable<ProxyRoute["maintenance"]>): CaddyHandler {
	return {
		handler: "subroute",
		routes: [
			{
				...(allowCidrs.length && {
					match: [{ not: [{ client_ip: { ranges: unique(allowCidrs) } }] }],
				}),
				handle: [
					{
						handler: "static_response",
						status_code: 503,
						headers: {
							"Content-Type": ["text/html; charset=utf-8"],
							"Cache-Control": ["no-store"],
							"Retry-After": ["300"],
						},
						body: literal(page),
					},
				],
			},
		],
	};
}

const PROXY_ERRORS = "{http.error.status_code} in [502, 503, 504]";

/**
 * Pages for the proxy's own 502/503/504, such as an upstream that is down mid-deploy. Routes sharing a
 * page share one error route, so a logo inlined in it appears once. Other errors (401, 429) keep
 * Caddy's empty response.
 */
function errorRoutes(routes: ProxyRoute[]): Pick<CaddyServer, "errors"> {
	const byPage = new Map<string, CaddyMatcher[]>();
	for (const r of routes) {
		if (r.redirectTo || !r.edge?.errorPage) continue;
		const sets = byPage.get(r.edge.errorPage) ?? [];
		sets.push({ ...routeMatcher(r), expression: PROXY_ERRORS });
		byPage.set(r.edge.errorPage, sets);
	}
	if (!byPage.size) return {};
	return {
		errors: {
			routes: [...byPage.entries()].map(([page, match]) => ({
				match,
				handle: [
					{
						handler: "static_response",
						status_code: "{http.error.status_code}",
						headers: {
							"Content-Type": ["text/html; charset=utf-8"],
							"Cache-Control": ["no-store"],
						},
						body: literal(page),
					},
				],
				terminal: true,
			})),
		},
	};
}
/** Answers the script and the beacon itself; any other path falls through to the upstream. */
const webAnalytics = (base: string): CaddyHandler => ({
	handler: "subroute",
	routes: [
		{
			match: [{ path: [`${base}/_ls/a.js`] }],
			handle: [
				{
					handler: "static_response",
					status_code: 200,
					headers: {
						"Content-Type": ["application/javascript; charset=utf-8"],
						"Cache-Control": ["public, max-age=3600"],
					},
					body: WEB_ANALYTICS_SCRIPT,
				},
			],
		},
		{
			match: [{ path: [`${base}/_ls/e`] }],
			handle: [
				{
					handler: "static_response",
					status_code: 204,
					headers: { "Cache-Control": ["no-store"] },
				},
			],
		},
	],
});

const ACCESS_ORDER = { ip_allow: 0, forward_auth: 1, basic_auth: 2 } as const;

function accessHandlers(rules: AccessRule[]): CaddyHandler[] {
	return [...rules]
		.sort((a, b) => ACCESS_ORDER[a.type] - ACCESS_ORDER[b.type])
		.map((rule) =>
			rule.type === "ip_allow"
				? ipAllow(rule)
				: rule.type === "forward_auth"
					? forwardAuth(rule)
					: basicAuth(rule.users),
		);
}

function ipAllow(
	rule: Extract<AccessRule, { type: "ip_allow" }>,
): CaddyHandler {
	const allowed: CaddyMatcher[] = [{ remote_ip: { ranges: rule.cidrs } }];
	if (rule.trustedProxies?.length)
		allowed.push({
			remote_ip: { ranges: rule.trustedProxies },
			client_ip: { ranges: rule.cidrs },
		});
	return {
		handler: "subroute",
		routes: [
			{
				match: [{ not: allowed }],
				handle: [
					{ handler: "static_response", status_code: 403, body: "Forbidden" },
				],
			},
		],
	};
}

/** What Caddy's `forward_auth` directive expands to, with the copied headers scrubbed first so a client cannot forge them. */
function forwardAuth(
	rule: Extract<AccessRule, { type: "forward_auth" }>,
): CaddyHandler {
	const url = new URL(rule.url);
	const https = url.protocol === "https:";
	const headers = unique(rule.copyHeaders.map(canonicalHeader));
	const placeholder = (h: string) => `{http.reverse_proxy.header.${h}}`;
	return {
		handler: "reverse_proxy",
		upstreams: [{ dial: `${url.hostname}:${url.port || (https ? 443 : 80)}` }],
		...(https && { transport: { protocol: "http" as const, tls: {} } }),
		rewrite: { method: "GET", uri: `${url.pathname}${url.search}` },
		headers: {
			request: {
				set: {
					Host: ["{http.reverse_proxy.upstream.hostport}"],
					"X-Forwarded-Method": ["{http.request.method}"],
					"X-Forwarded-Uri": ["{http.request.uri}"],
				},
			},
		},
		handle_response: [
			{
				match: { status_code: [2] },
				// A matched response handler with no routes would send the auth response itself.
				routes: [
					{
						handle: [
							headers.length
								? { handler: "headers", request: { delete: headers } }
								: { handler: "vars" },
						],
					},
					...headers.map(
						(h): CaddyRoute => ({
							match: [{ not: [{ vars: { [placeholder(h)]: [""] } }] }],
							handle: [
								{
									handler: "headers",
									request: { set: { [h]: [placeholder(h)] } },
								},
							],
						}),
					),
				],
			},
		],
	};
}

function trustedProxies(
	routes: ProxyRoute[],
): Pick<CaddyServer, "trusted_proxies" | "trusted_proxies_strict"> {
	// shortcut: Caddy trusts proxies per server, so a rule's client_ip is derived with every rule's proxies; the remote_ip pin in ipAllow bounds that. Move to per-route trust if Caddy grows it.
	const ranges = unique(
		routes.flatMap((r) =>
			r.redirectTo
				? []
				: (r.access ?? []).flatMap((a) =>
						a.type === "ip_allow" ? (a.trustedProxies ?? []) : [],
					),
		),
	);
	return ranges.length
		? {
				trusted_proxies: { source: "static", ranges },
				trusted_proxies_strict: 1,
			}
		: {};
}

function automationPolicies(
	routes: ProxyRoute[],
	settings: ProxySettings,
): CaddyAutomationPolicy[] {
	// One policy per distinct DNS challenge, so a credential appears once however many domains share it.
	const byChallenge = new Map<
		string,
		{ challenge: DnsChallenge; subjects: string[] }
	>();
	for (const r of routes) {
		if (r.cert !== "auto" || !r.dnsChallenge) continue;
		const key = JSON.stringify([
			r.dnsChallenge.provider,
			sortedEntries(r.dnsChallenge.credentials),
		]);
		const group = byChallenge.get(key) ?? {
			challenge: r.dnsChallenge,
			subjects: [],
		};
		group.subjects.push(r.hostname);
		byChallenge.set(key, group);
	}
	const dnsPolicies = [...byChallenge.entries()]
		.sort(([a], [b]) => compareStrings(a, b))
		.map(([, { challenge, subjects }]) => ({
			subjects: unique(subjects),
			issuers: issuers(settings, {
				dns: {
					provider: {
						name: challenge.provider,
						...Object.fromEntries(sortedEntries(challenge.credentials)),
					},
				},
			}),
		}));
	return [...dnsPolicies, { issuers: issuers(settings) }];
}

function issuers(
	settings: ProxySettings,
	challenges?: Extract<CaddyIssuer, { module: "acme" }>["challenges"],
): CaddyIssuer[] {
	const list: CaddyIssuer[] = [
		{
			module: "acme",
			ca: LETSENCRYPT,
			email: settings.acmeEmail,
			...(challenges && { challenges }),
		},
	];
	if (settings.zerossl) {
		list.push({
			module: "acme",
			ca: ZEROSSL,
			email: settings.acmeEmail,
			external_account: {
				key_id: settings.zerossl.keyId,
				mac_key: settings.zerossl.macKey,
			},
			...(challenges && { challenges }),
		});
	}
	return list;
}

function loadedCerts(routes: ProxyRoute[]): CaddyLoadedPem[] {
	const byId = new Map<string, CustomCert>();
	for (const r of routes)
		if (r.cert === "custom") byId.set(r.customCert.id, r.customCert);
	return [...byId.values()]
		.sort((a, b) => compareStrings(a.id, b.id))
		.map((c) => ({
			certificate: c.certPem,
			key: c.keyPem,
			tags: [`ls-cert-${c.id}`],
		}));
}

function redisStorage({
	redisUrl,
	keyPrefix,
	encryptionKey,
}: ProxySettings["storage"]): CaddyRedisStorage {
	const url = new URL(redisUrl);
	return {
		module: "redis",
		address: [`${url.hostname}:${url.port || "6379"}`],
		...(url.username && { username: decodeURIComponent(url.username) }),
		...(url.password && { password: decodeURIComponent(url.password) }),
		db: Number(url.pathname.slice(1) || "0"),
		key_prefix: keyPrefix,
		tls_enabled: url.protocol === "rediss:",
		...(encryptionKey && { encryption_key: encryptionKey }),
	};
}

// Caddy evaluates routes in order: exact hosts before wildcards, then longest path prefix first.
function compareRoutes(a: ProxyRoute, b: ProxyRoute): number {
	return (
		Number(isWildcard(a.hostname)) - Number(isWildcard(b.hostname)) ||
		compareStrings(a.hostname, b.hostname) ||
		(b.pathPrefix?.length ?? 0) - (a.pathPrefix?.length ?? 0) ||
		compareStrings(a.domainId, b.domainId)
	);
}

/**
 * How long a request waits for its upstream to accept a connection. It covers the gap of a
 * stop-first redeploy, when the Swarm VIP has no task behind it. A request whose connection was
 * accepted is retried only when it is a GET, Caddy's default.
 */
export const UPSTREAM_TRY_DURATION = "30s";

/** Set by Caddy on every request to the dashboard; see `clientIp` in the api. */
export const CLIENT_IP_HEADER = "X-Logistack-Client-Ip";

const proxyTo = (u: Upstream, request?: CaddyHeaderOps): CaddyHandler => ({
	handler: "reverse_proxy",
	upstreams: [{ dial: `${u.host}:${u.port}` }],
	load_balancing: {
		try_duration: UPSTREAM_TRY_DURATION,
		try_interval: "250ms",
	},
	...(request && { headers: { request } }),
});
const basicAuth = (
	users: Extract<AccessRule, { type: "basic_auth" }>["users"],
): CaddyHandler => ({
	handler: "authentication",
	providers: {
		http_basic: {
			accounts: users.map((u) => ({ username: u.username, password: u.hash })),
			hash: { algorithm: "bcrypt" },
			realm: "restricted",
		},
	},
});
/**
 * Caddy expands `{env.*}`, `{file.*}` and other placeholders in response bodies, so tenant text
 * (error pages, maintenance messages, organization names) would read the proxy's environment and
 * files. Escaped braces stay literal.
 */
export const literal = (s: string) => s.replace(/[{}]/g, (b) => `\\${b}`);

const redirect = (location: string): CaddyHandler => ({
	handler: "static_response",
	status_code: 308,
	headers: { Location: [location] },
});
const isWildcard = (host: string) => host.startsWith("*.");
/** Go's CanonicalHeaderKey: Caddy names `http.reverse_proxy.header.*` placeholders this way. */
const canonicalHeader = (h: string) =>
	h
		.toLowerCase()
		.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (xs: string[]) => [...new Set(xs)].sort(compareStrings);
const sortedEntries = (o: Record<string, string>) =>
	Object.entries(o).sort(([a], [b]) => compareStrings(a, b));
