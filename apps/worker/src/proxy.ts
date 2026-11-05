import { createPrivateKey, X509Certificate } from "node:crypto";
import type { AccessRule } from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import {
	certificate,
	dnsProvider,
	domain,
	environment,
	instanceSettings,
	project,
	registry,
	service,
	serviceBasicAuth,
} from "@logistack/db";
import type { Task } from "@logistack/docker";
import {
	caddyDnsChallenge,
	type DnsConfig,
	type DnsKind,
	dnsProviders,
	findZoneForHostname,
} from "@logistack/providers";
import {
	type CaddyConfig,
	compileProxy,
	type DnsChallenge,
	type ProxyInput,
	type ProxyRoute,
	ProxySync,
} from "@logistack/proxy";
import { RedisClient } from "bun";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { log } from "./bus.ts";
import { refreshCertSnapshot } from "./certs.ts";
import type { Ctx } from "./ctx.ts";
import type { DomainRow } from "./load.ts";
import { svcName } from "./load.ts";
import { localRegistryName, ZOT_PORT } from "./local-registry.ts";
import { enqueueProxySync, enqueueReconcile } from "./queues.ts";

const ADMIN_PORT = 2019;

/** Same channel as apps/server/src/redis.ts: the API asks for a sync after a domain change. */
export const PROXY_SYNC_CHANNEL = "ls:proxy:sync";
/** Same channel as apps/server/src/redis.ts: the API asks for a pass after a desired-state change. */
export const RECONCILE_CHANNEL = "ls:reconcile:request";

type TaskWithNetworks = Task & {
	NetworksAttachments?: {
		Network: { Spec: { Name: string } };
		Addresses: string[];
	}[];
};

/** ls-control addresses of the running Caddy tasks; each gets its own config (its admin listen). */
export async function caddyAddresses(ctx: Ctx): Promise<string[]> {
	const tasks = (await ctx.docker.tasks.list({
		service: [ctx.cfg.LS_CADDY_SERVICE],
		"desired-state": ["running"],
	})) as TaskWithNetworks[];
	return tasks
		.filter((t) => t.Status.State === "running")
		.flatMap((t) =>
			(t.NetworksAttachments ?? [])
				.filter((a) => a.Network.Spec.Name === ctx.cfg.LS_CONTROL_NETWORK)
				.flatMap((a) =>
					a.Addresses.map((addr) => addr.split("/")[0] as string),
				),
		)
		.sort();
}

type RouteOrError =
	| { ok: true; route: ProxyRoute }
	| { ok: false; error: string };

/** A DNS provider's stored config as the `dns` challenge its caddy-dns module reads. */
export function dnsChallengeFor(kind: string, config: unknown): DnsChallenge {
	if (!(kind in dnsProviders))
		throw new Error(`${kind} has no DNS-01 support yet`);
	const k = kind as DnsKind;
	const parsed = dnsProviders[k].configSchema.parse(config) as DnsConfig<
		typeof k
	>;
	const { name, ...credentials } = caddyDnsChallenge(k, parsed);
	return { provider: name, credentials } as DnsChallenge;
}

/** Why Caddy would refuse this pair, or null. A bad upload must not fail every other route's /load. */
export function customCertProblem(certPem: string, keyPem: string) {
	try {
		const ok = new X509Certificate(certPem).checkPrivateKey(
			createPrivateKey(keyPem),
		);
		return ok ? null : "the private key does not match the certificate";
	} catch (e) {
		return `unreadable certificate: ${e instanceof Error ? e.message : String(e)}`;
	}
}

/** Pure: one domain row (with its decrypted cert or DNS challenge) to a Caddy route. */
export function domainRoute(
	d: DomainRow,
	upstreamHost: string,
	extra: {
		customCert?: { certPem: string; keyPem: string };
		dnsChallenge?: DnsChallenge;
	},
): RouteOrError {
	const base = {
		domainId: d.id,
		hostname: d.hostname,
		upstream: { host: upstreamHost, port: d.port },
		...(d.pathPrefix ? { pathPrefix: d.pathPrefix } : {}),
		...(d.redirectTo ? { redirectTo: `https://${d.redirectTo}` } : {}),
	};
	if (!d.https)
		return { ok: true, route: { ...base, https: false, cert: "none" } };
	if (d.cert === "custom") {
		if (!extra.customCert)
			return { ok: false, error: "custom certificate not found" };
		const problem = customCertProblem(
			extra.customCert.certPem,
			extra.customCert.keyPem,
		);
		if (problem) return { ok: false, error: problem };
		return {
			ok: true,
			route: {
				...base,
				https: true,
				cert: "custom",
				customCert: {
					id: d.customCertificateId as string,
					...extra.customCert,
				},
			},
		};
	}
	if (d.hostname.startsWith("*.") && !extra.dnsChallenge)
		return { ok: false, error: "a wildcard domain needs a DNS provider" };
	return {
		ok: true,
		route: {
			...base,
			https: true,
			cert: "auto",
			...(extra.dnsChallenge ? { dnsChallenge: extra.dnsChallenge } : {}),
		},
	};
}

/**
 * The domain's rules plus the service-wide basic auth. Both user lists pass the one basic
 * auth check (a browser sends one Authorization header); the domain's entry wins a shared name.
 */
export function routeAccess(
	rules: AccessRule[],
	serviceUsers: { username: string; hash: string }[] | null | undefined,
): AccessRule[] {
	if (!serviceUsers?.length) return rules;
	const own = rules.find((r) => r.type === "basic_auth")?.users ?? [];
	const users = [
		...own,
		...serviceUsers.filter((u) => !own.some((o) => o.username === u.username)),
	];
	return [
		...rules.filter((r) => r.type !== "basic_auth"),
		{ type: "basic_auth", users },
	];
}

/**
 * Splits routes into those compileProxy accepts and those it throws on, by compiling each
 * alone. The API rejects such rows up front; this keeps one that slipped through (an old
 * row, a hand edit) from blocking the sync of every other domain.
 */
export function isolateRoutes(
	routes: ProxyRoute[],
	input: Omit<ProxyInput, "routes">,
): { routes: ProxyRoute[]; errors: Map<string, string> } {
	const ok: ProxyRoute[] = [];
	const errors = new Map<string, string>();
	for (const r of routes) {
		try {
			compileProxy({ ...input, routes: [r] });
			ok.push(r);
		} catch (e) {
			errors.set(r.domainId, e instanceof Error ? e.message : String(e));
		}
	}
	return { routes: ok, errors };
}

/**
 * Has Caddy manage one `*.base` certificate over DNS-01. Caddy then serves every exact host
 * under the base (generated domains, the dashboard) from it and issues none of their own.
 */
export function withInstanceWildcard(
	config: CaddyConfig,
	wildcard: string,
	challenge: DnsChallenge,
): CaddyConfig {
	const tls = config.apps.tls as CaddyConfig["apps"]["tls"] & {
		certificates?: { automate?: string[] };
	};
	const policies = tls.automation.policies;
	const catchAll = policies.find((p) => !p.subjects);
	const taken = policies.some((p) => p.subjects?.includes(wildcard));
	return {
		...config,
		apps: {
			...config.apps,
			tls: {
				...tls,
				certificates: {
					...tls.certificates,
					automate: [...(tls.certificates?.automate ?? []), wildcard],
				},
				automation: {
					policies: taken
						? policies
						: [
								{
									subjects: [wildcard],
									issuers: (catchAll?.issuers ?? []).map((i) =>
										i.module === "acme"
											? {
													...i,
													challenges: {
														dns: {
															provider: {
																name: challenge.provider,
																...challenge.credentials,
															},
														},
													},
												}
											: i,
									),
								},
								...policies,
							],
				},
			},
		},
	} as CaddyConfig;
}

export const acmeDirectories = [
	"letsencrypt",
	"letsencrypt-staging",
	"zerossl",
	"internal",
] as const;
export type AcmeDirectory = (typeof acmeDirectories)[number];

const LE_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
const ACME_URLS: Partial<Record<AcmeDirectory, string>> = {
	"letsencrypt-staging":
		"https://acme-staging-v02.api.letsencrypt.org/directory",
	// Caddy fetches ZeroSSL's EAB credentials itself from the account email.
	zerossl: "https://acme.zerossl.com/v2/DV90",
};

/**
 * Points every Let's Encrypt issuer compileProxy emits at the instance's chosen directory
 * (`instance_settings.acme_directory`). `internal` is Caddy's own CA: air-gapped installs,
 * local trials and tests, where browsers will not trust the certificates.
 */
export function withAcmeDirectory(
	config: CaddyConfig,
	directory: AcmeDirectory,
): CaddyConfig {
	if (directory === "letsencrypt") return config;
	const policies = config.apps.tls.automation.policies.map((p) => ({
		...p,
		issuers:
			directory === "internal"
				? [{ module: "internal" as const }]
				: p.issuers.map((i) =>
						i.module === "acme" && (i.ca ?? LE_PRODUCTION) === LE_PRODUCTION
							? { ...i, ca: ACME_URLS[directory] }
							: i,
					),
	}));
	return {
		...config,
		apps: {
			...config.apps,
			tls: { ...config.apps.tls, automation: { policies } },
			...(directory === "internal" && {
				pki: { certificate_authorities: { local: { install_trust: false } } },
			}),
		},
	} as CaddyConfig;
}

const ZoneList = z.array(z.object({ id: z.string(), name: z.string() }));

/** Compiles one config per Caddy task and pushes it; records each domain's outcome on change. */
export async function syncProxy(ctx: Ctx): Promise<void> {
	const [settings] = await ctx.db.select().from(instanceSettings);
	const dashboardHost =
		settings?.primaryDomain ??
		(settings?.publicUrl ? new URL(settings.publicUrl).hostname : undefined);
	if (!settings || !dashboardHost) {
		log("info", "proxy sync skipped: no dashboard hostname configured");
		return;
	}
	const rows = await ctx.db
		.select({
			domain,
			organizationId: project.organizationId,
			projectId: project.id,
			basicAuth: serviceBasicAuth.users,
		})
		.from(domain)
		.innerJoin(service, eq(service.id, domain.serviceId))
		.leftJoin(serviceBasicAuth, eq(serviceBasicAuth.serviceId, service.id))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(eq(service.desiredState, "running"));

	const certIds = rows.flatMap((r) => r.domain.customCertificateId ?? []);
	const certs = certIds.length
		? await ctx.db
				.select()
				.from(certificate)
				.where(inArray(certificate.id, certIds))
		: [];
	// Every provider: domains name theirs, and the instance wildcard is matched by zone.
	const providers = await ctx.db.select().from(dnsProvider);
	const open = (v: string) => decrypt(ctx.masterKey, v);
	const challenges = new Map<string, Promise<DnsChallenge>>();
	const challengeOf = (p: (typeof providers)[number]) => {
		let c = challenges.get(p.id);
		if (!c) {
			c = open(p.credentialsEncrypted).then((s) =>
				dnsChallengeFor(p.kind, JSON.parse(s)),
			);
			challenges.set(p.id, c);
		}
		return c;
	};

	const candidates: ProxyRoute[] = [];
	const outcome = new Map<string, string | null>();
	for (const { domain: d, basicAuth } of rows) {
		try {
			const c = certs.find((x) => x.id === d.customCertificateId);
			const p = providers.find((x) => x.id === d.dnsProviderId);
			const r = domainRoute(d, svcName(ctx, d.serviceId), {
				...(c
					? {
							customCert: {
								certPem: c.certPem,
								keyPem: await open(c.keyPemEncrypted),
							},
						}
					: {}),
				...(p && d.cert === "auto"
					? { dnsChallenge: await challengeOf(p) }
					: {}),
			});
			if (r.ok)
				candidates.push({
					...r.route,
					access: routeAccess(d.access, basicAuth),
				});
			else outcome.set(d.id, r.error);
		} catch (e) {
			outcome.set(d.id, e instanceof Error ? e.message : String(e));
		}
	}

	const [local] = settings.localRegistryEnabled
		? await ctx.db
				.select({ url: registry.url })
				.from(registry)
				.where(eq(registry.kind, "local"))
				.limit(1)
		: [];
	if (local)
		candidates.push({
			domainId: "local-registry",
			hostname: local.url,
			upstream: { host: localRegistryName(ctx), port: ZOT_PORT },
			https: true,
			cert: "auto",
		});
	// The setup wizard's `*.base` with a DNS provider: one wildcard certificate for the base.
	let wildcard: { hostname: string; challenge: DnsChallenge } | undefined;
	if (settings.customWildcard) {
		const p = providers.find((x) =>
			findZoneForHostname(
				settings.customWildcard as string,
				ZoneList.catch([]).parse(x.zonesCache),
			),
		);
		if (p)
			wildcard = await challengeOf(p).then(
				(challenge) => ({
					hostname: settings.customWildcard as string,
					challenge,
				}),
				(e: unknown) => {
					log("warn", "instance wildcard skipped", { error: String(e) });
					return undefined;
				},
			);
	}

	const addresses = await caddyAddresses(ctx);
	if (!addresses.length) {
		log("warn", "proxy sync: no running Caddy task", {
			service: ctx.cfg.LS_CADDY_SERVICE,
		});
		return;
	}
	const [apiHost, apiPort] = ctx.cfg.LS_API_UPSTREAM.split(":");
	const common = (ip: string): Omit<ProxyInput, "routes"> => ({
		settings: {
			adminListen: `${ip}:${ADMIN_PORT}`,
			acmeEmail: settings.letsencryptEmail ?? "",
			storage: { redisUrl: ctx.cfg.REDIS_URL, keyPrefix: "caddy" },
		},
		dashboard: {
			hostname: dashboardHost,
			upstream: { host: apiHost as string, port: Number(apiPort ?? 3000) },
		},
	});
	const isolated = isolateRoutes(candidates, common(addresses[0] as string));
	for (const [id, error] of isolated.errors) outcome.set(id, error);
	const routes = isolated.routes;

	const failures: string[] = [];
	for (const ip of addresses) {
		let config = compileProxy({ ...common(ip), routes });
		if (wildcard)
			config = withInstanceWildcard(
				config,
				wildcard.hostname,
				wildcard.challenge,
			);
		config = withAcmeDirectory(
			config,
			z
				.enum(acmeDirectories)
				.catch("letsencrypt")
				.parse(settings.acmeDirectory),
		);
		const [result] = await new ProxySync([`http://${ip}:${ADMIN_PORT}`]).push(
			config,
		);
		if (result && !result.ok) failures.push(result.error.message);
	}
	for (const r of routes) outcome.set(r.domainId, failures[0] ?? null);

	for (const { domain: d, organizationId, projectId } of rows) {
		const error = outcome.get(d.id) ?? null;
		const status = error ? "error" : "active";
		if (d.status === status && d.statusMessage === error) continue;
		await ctx.db
			.update(domain)
			.set({ status, statusMessage: error })
			.where(eq(domain.id, d.id));
		await ctx.bus.publish(
			error ? "domain.error" : "domain.active",
			organizationId,
			{ type: "domain", id: d.id },
			{
				hostname: d.hostname,
				serviceId: d.serviceId,
				projectId,
				...(error ? { error } : {}),
			},
		);
	}
	await refreshCertSnapshot(ctx).catch((e: unknown) =>
		log("warn", "certificate snapshot failed", { error: String(e) }),
	);
	log("info", "proxy synced", {
		instances: addresses.length,
		routes: routes.length,
		skipped: isolated.errors.size,
		failed: failures.length,
	});
}

/** Enqueues a proxy sync or a reconcile pass whenever the API asks on their channels. Returns the closer. */
export async function listenForSyncRequests(ctx: Ctx): Promise<() => void> {
	const sub = new RedisClient(ctx.cfg.REDIS_URL);
	await sub.subscribe(PROXY_SYNC_CHANNEL, (reason: string) => {
		enqueueProxySync(ctx.queues, `api: ${reason}`).catch((e: unknown) =>
			log("warn", "proxy sync enqueue failed", { error: String(e) }),
		);
	});
	await sub.subscribe(RECONCILE_CHANNEL, (reason: string) => {
		enqueueReconcile(ctx.queues, `api: ${reason}`).catch((e: unknown) =>
			log("warn", "reconcile enqueue failed", { error: String(e) }),
		);
	});
	return () => sub.close();
}
