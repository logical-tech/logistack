import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createRoute, z } from "@hono/zod-openapi";
import { GeneratedDomainBase, Hostname } from "@logistack/contracts";
import {
	account,
	type Db,
	dnsProvider,
	instanceSettings,
	member,
	organization,
	user,
} from "@logistack/db";
import {
	type DnsKind,
	type DnsProvider,
	type DnsZone,
	findZoneForHostname,
} from "@logistack/providers";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import {
	BuiltinDnsKindSchema,
	connect,
	parseCredentials,
	sealCredentials,
	viaProvider,
} from "../dns.ts";
import type { Env } from "../env.ts";
import { Failure } from "../errors.ts";
import {
	body,
	errors,
	json,
	Name,
	router,
	Slug,
	security,
	slugify,
} from "../openapi.ts";
import { publicIp, resolveHost } from "../probe.ts";
import { requestProxySync } from "../redis.ts";
import { check, organizationResource } from "../scope.ts";

const DnsProviderInput = z.object({
	kind: BuiltinDnsKindSchema,
	credentials: z.record(z.string(), z.unknown()),
});

const SetupStatus = z
	.object({
		setupCompleted: z.boolean(),
		hasUsers: z.boolean(),
		/** install.sh --public-setup: the setup routes need the `x-setup-token` header until setup completes. */
		setupTokenRequired: z.boolean(),
		/** Seeds generated sslip.io / nip.io hostnames in the wizard; null when undetectable. */
		publicIp: z.string().nullable(),
		/** The server's own address from install.sh; the wizard offers it for the records when it differs from `publicIp` (NAT). */
		lanAddress: z.string().nullable(),
		/** The dashboard URL once setup is done; null before. install.sh prints it on re-runs. */
		publicUrl: z.string().nullable(),
		/** Social sign-in providers with credentials configured; the sign-in screen shows only these. */
		authProviders: z.object({ github: z.boolean(), google: z.boolean() }),
	})
	.openapi("SetupStatus");

const Ip = z.union([z.ipv4(), z.ipv6()]);

const DnsCheck = z
	.object({
		hostname: z.string(),
		expected: z.string(),
		resolved: z.array(z.string()),
		ok: z.boolean(),
	})
	.openapi("DnsCheck");

export const SetupInput = z
	.object({
		owner: z.object({
			name: Name,
			email: z.email().toLowerCase(),
			password: z.string().min(8).max(128),
		}),
		organization: z.object({ name: Name, slug: Slug.optional() }),
		instance: z
			.object({
				publicUrl: z.url(),
				generatedDomainBase: GeneratedDomainBase,
				/** Wildcard such as `*.srv1.example.com`, only with `custom`. */
				customWildcard: z
					.string()
					.regex(/^\*\.[a-z0-9.-]+$/)
					.optional(),
				letsencryptEmail: z.email(),
				localRegistryEnabled: z.boolean(),
				/**
				 * Only with `custom`: stored as the organization's first DNS provider, used to create
				 * the `*.base` and `base` records and to issue one wildcard certificate over DNS-01.
				 */
				dnsProvider: DnsProviderInput.optional(),
				/**
				 * Where the records created through `dnsProvider` point: `lan` at the server's own
				 * address (reachable only inside its network), `internet` at the public IP.
				 */
				reachFrom: z.enum(["lan", "internet"]).default("internet"),
			})
			.refine(
				(i) =>
					(i.generatedDomainBase === "custom") === Boolean(i.customWildcard),
				{
					message:
						"customWildcard is required for, and only allowed with, 'custom'",
					path: ["customWildcard"],
				},
			)
			.refine((i) => !i.dnsProvider || i.generatedDomainBase === "custom", {
				message: "dnsProvider is only allowed with 'custom'",
				path: ["dnsProvider"],
			}),
	})
	.openapi("SetupInput");

type SetupDnsProvider = {
	kind: DnsKind;
	credentialsEncrypted: string;
	zone: DnsZone;
};

/**
 * Verifies the credentials and finds the zone that owns `base`, before anything is written.
 * Throws a 400 the wizard can show when either fails.
 */
async function prepareDnsProvider(
	input: z.infer<typeof DnsProviderInput>,
	base: string,
) {
	const provider = connect(input.kind, input.credentials);
	const zones = await viaProvider(async () => {
		await provider.verify();
		return provider.listZones();
	});
	const zone = findZoneForHostname(base, zones);
	if (!zone)
		throw new Failure(
			"bad_request",
			`The token works, but none of its ${zones.length} zone${zones.length === 1 ? "" : "s"} contains ${base}`,
		);
	return {
		provider,
		zone,
		credentials: parseCredentials(input.kind, input.credentials),
	};
}

const SetupRecord = z.object({
	name: z.string(),
	type: z.enum(["A", "AAAA"]),
	content: z.string(),
	error: z.string().nullable(),
});

/** `*.base` and `base` pointing at the server. Per-record failures are reported, not thrown: setup has committed. */
async function createBaseRecords(
	provider: DnsProvider,
	zone: DnsZone,
	base: string,
	ip: string,
): Promise<z.infer<typeof SetupRecord>[]> {
	const type = isIP(ip) === 6 ? "AAAA" : "A";
	const out: z.infer<typeof SetupRecord>[] = [];
	for (const name of [`*.${base}`, base]) {
		const error = await provider
			.upsertRecord({ zoneId: zone.id, name, type, content: ip, ttl: 300 })
			.then(
				() => null,
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
		out.push({ name, type, content: ip, error });
	}
	return out;
}

// Arbitrary constant: serializes concurrent setup attempts across all server replicas.
const SETUP_LOCK = 0x4c535355;

async function isSetUp(db: Pick<Db, "select">) {
	const [anyUser] = await db.select({ id: user.id }).from(user).limit(1);
	const [settings] = await db
		.select({
			done: instanceSettings.setupCompleted,
			publicUrl: instanceSettings.publicUrl,
		})
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return {
		setupCompleted: settings?.done ?? false,
		hasUsers: Boolean(anyUser),
		publicUrl: settings?.done ? settings.publicUrl : null,
	};
}

/** The whole first run in one transaction; throws 409 once any user exists. */
export async function completeSetup(
	db: Db,
	input: z.infer<typeof SetupInput>,
	passwordHash: string,
	dns?: SetupDnsProvider,
) {
	const userId = crypto.randomUUID();
	const organizationId = crypto.randomUUID();
	const now = new Date();
	await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
		const current = await isSetUp(tx);
		if (current.hasUsers || current.setupCompleted)
			throw new Failure("conflict", "setup is already completed");
		await tx.insert(user).values({
			id: userId,
			name: input.owner.name,
			email: input.owner.email,
			emailVerified: true,
			kind: "human",
			role: "admin",
		});
		await tx.insert(account).values({
			id: crypto.randomUUID(),
			accountId: userId,
			providerId: "credential",
			userId,
			password: passwordHash,
		});
		await tx.insert(organization).values({
			id: organizationId,
			name: input.organization.name,
			slug: input.organization.slug ?? slugify(input.organization.name),
			createdAt: now,
		});
		await tx.insert(member).values({
			id: crypto.randomUUID(),
			organizationId,
			userId,
			role: "owner",
			createdAt: now,
		});
		const settings = {
			setupCompleted: true,
			publicUrl: input.instance.publicUrl,
			letsencryptEmail: input.instance.letsencryptEmail,
			generatedDomainBase: input.instance.generatedDomainBase,
			customWildcard: input.instance.customWildcard ?? null,
			localRegistryEnabled: input.instance.localRegistryEnabled,
		};
		await tx
			.insert(instanceSettings)
			.values({ id: "singleton", ...settings })
			.onConflictDoUpdate({ target: instanceSettings.id, set: settings });
		if (dns)
			await tx.insert(dnsProvider).values({
				organizationId,
				kind: dns.kind,
				name: dns.zone.name,
				credentialsEncrypted: dns.credentialsEncrypted,
				zonesCache: [dns.zone],
			});
	});
	return { userId, organizationId };
}

export const SETUP_TOKEN_HEADER = "x-setup-token";

const SetupTokenHeader = z.object({
	[SETUP_TOKEN_HEADER]: z.string().optional().openapi({
		description:
			"The one-time token install.sh --public-setup printed. Needed until setup completes, ignored after.",
	}),
});

/**
 * Who may use a setup route: `open` before setup when no token is configured (the installer's
 * default, where only the loopback tunnel reaches the api) or the right one is given; `done` once
 * anyone exists, which also retires the token.
 */
export type SetupGate = "open" | "token_missing" | "token_invalid" | "done";

const digest = (v: string) => createHash("sha256").update(v).digest();

export function setupGate(
	done: boolean,
	expected: string | undefined,
	given: string | undefined,
): SetupGate {
	if (done) return "done";
	if (!expected) return "open";
	if (!given) return "token_missing";
	return timingSafeEqual(digest(expected), digest(given))
		? "open"
		: "token_invalid";
}

/** Applies {@link setupGate}; after setup the DNS probes need an organization admin and POST /setup is a conflict. */
const setupAccess =
	(afterSetup: "admin" | "conflict"): MiddlewareHandler<Env> =>
	async (c, next) => {
		const { db, config } = c.var.deps;
		const { setupCompleted, hasUsers } = await isSetUp(db);
		const gate = setupGate(
			setupCompleted || hasUsers,
			config.LOGISTACK_SETUP_TOKEN,
			c.req.header(SETUP_TOKEN_HEADER),
		);
		switch (gate) {
			case "open":
				break;
			case "token_missing":
				throw new Failure(
					"unauthorized",
					"This server needs its setup token: install.sh printed it",
				);
			case "token_invalid":
				throw new Failure("unauthorized", "The setup token is wrong");
			case "done":
				if (afterSetup === "conflict")
					throw new Failure("conflict", "setup is already completed");
				check(c, "admin", organizationResource(requireActor(c).organizationId));
		}
		await next();
	};

export const setup = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/setup/status",
			tags: ["setup"],
			summary: "Whether first-run setup is done",
			responses: { 200: json(SetupStatus, "Setup status") },
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			const [status, ip] = await Promise.all([isSetUp(db), publicIp(config)]);
			return c.json(
				{
					...status,
					setupTokenRequired:
						setupGate(
							status.setupCompleted || status.hasUsers,
							config.LOGISTACK_SETUP_TOKEN,
							undefined,
						) === "token_missing",
					publicIp: ip,
					lanAddress: config.LAN_ADDRESS ?? null,
					authProviders: {
						github: Boolean(
							config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET,
						),
						google: Boolean(
							config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET,
						),
					},
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"setup.dns_check",
			createRoute({
				method: "post",
				path: "/setup/dns-check",
				tags: ["setup"],
				security,
				summary: "Resolve a hostname over DNS-over-HTTPS and compare it",
				description:
					"Anyone may call it before setup completes, with the setup token when the installer set one; afterwards it needs `admin` on the organization. `expected` defaults to the server's public IP.",
				middleware: [setupAccess("admin")],
				request: {
					headers: SetupTokenHeader,
					...body(z.object({ hostname: Hostname, expected: Ip.optional() })),
				},
				responses: { 200: json(DnsCheck, "Lookup result"), ...errors },
			}),
		),
		async (c) => {
			const { hostname, expected: given } = c.req.valid("json");
			const expected = given ?? (await publicIp(c.var.deps.config));
			if (!expected)
				throw new Failure(
					"bad_request",
					"public IP unknown; pass `expected` or set PUBLIC_IP",
				);
			const resolved = await resolveHost(hostname).catch((err: unknown) => {
				throw new Failure("internal", `DNS lookup failed: ${String(err)}`);
			});
			return c.json(
				{ hostname, expected, resolved, ok: resolved.includes(expected) },
				200,
			);
		},
	)
	.openapi(
		mutation(
			"setup.dns_provider_check",
			createRoute({
				method: "post",
				path: "/setup/dns-provider-check",
				tags: ["setup"],
				security,
				summary:
					"Verify a DNS provider token and find the zone owning the base",
				description:
					"Writes nothing. Open before setup completes, with the setup token when the installer set one; afterwards it needs `admin` on the organization.",
				middleware: [setupAccess("admin")],
				request: {
					headers: SetupTokenHeader,
					...body(DnsProviderInput.extend({ base: Hostname })),
				},
				responses: {
					200: json(
						z.object({ zone: z.object({ id: z.string(), name: z.string() }) }),
						"The zone that will hold the records",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { base, ...input } = c.req.valid("json");
			const { zone } = await prepareDnsProvider(input, base);
			return c.json({ zone }, 200);
		},
	)
	.openapi(
		mutation(
			"setup.complete",
			createRoute({
				method: "post",
				path: "/setup",
				tags: ["setup"],
				summary: "Create the owner, the organization and the instance settings",
				description:
					"Allowed only while no user exists, with the setup token when the installer set one. Exactly one of any concurrent calls succeeds; the rest get 409.",
				middleware: [setupAccess("conflict")],
				request: { headers: SetupTokenHeader, ...body(SetupInput) },
				responses: {
					201: json(
						z.object({
							userId: z.string(),
							organizationId: z.string(),
							/** The records created through `dnsProvider`; empty without one. */
							dnsRecords: z.array(SetupRecord),
							/**
							 * Where the wizard moves the browser. `resolvesTo` is the public DNS answer right
							 * after the records were written, empty when the name does not resolve (yet).
							 */
							dashboard: z.object({
								url: z.string(),
								hostname: z.string(),
								resolvesTo: z.array(z.string()),
							}),
							/** The address the server reaches the internet from; null when undetectable. */
							publicIp: z.string().nullable(),
						}),
						"Setup completed",
					),
					400: errors[400],
					401: errors[401],
					409: errors[409],
				},
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, auth, masterKey, config } = c.var.deps;
			const base = input.instance.customWildcard?.slice(2);
			const lan = input.instance.reachFrom === "lan";
			if (lan && !config.LAN_ADDRESS)
				throw new Failure(
					"bad_request",
					"This server's LAN address is unknown; re-run install.sh, or choose the internet",
				);
			const dns =
				input.instance.dnsProvider && base
					? await prepareDnsProvider(input.instance.dnsProvider, base)
					: undefined;
			const passwordHash = await (await auth.$context).password.hash(
				input.owner.password,
			);
			const { userId, organizationId } = await completeSetup(
				db,
				input,
				passwordHash,
				dns && input.instance.dnsProvider
					? {
							kind: input.instance.dnsProvider.kind,
							credentialsEncrypted: await sealCredentials(
								masterKey,
								dns.credentials,
							),
							zone: dns.zone,
						}
					: undefined,
			);
			const ip = await publicIp(config);
			const target = lan ? config.LAN_ADDRESS : ip;
			const dnsRecords =
				dns && base && target
					? await createBaseRecords(dns.provider, dns.zone, base, target)
					: [];
			if (dns)
				await requestProxySync(config.REDIS_URL, "setup").catch(() => {});
			const { hostname } = new URL(input.instance.publicUrl);
			const resolvesTo = await resolveHost(hostname).catch(() => []);
			// The new owner is the actor of the audit row.
			c.set("actor", {
				kind: "user",
				id: userId,
				userId,
				organizationId,
				grants: [],
			});
			c.set("auditResourceId", organizationId);
			return c.json(
				{
					userId,
					organizationId,
					dnsRecords,
					dashboard: { url: input.instance.publicUrl, hostname, resolvesTo },
					publicIp: ip,
				},
				201,
			);
		},
	);
