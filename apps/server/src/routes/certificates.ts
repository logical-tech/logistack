import { X509Certificate } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { decrypt, encrypt } from "@logistack/core";
import {
	certificate,
	dnsProvider,
	domain,
	instanceSettings,
} from "@logistack/db";
import {
	cloudflare,
	cloudflareOriginCa,
	findZoneForHostname,
	originCaPermission,
	originKeyAndCsr,
	originValidityDays,
	ProviderError,
} from "@logistack/providers";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import { managedCertificates } from "../certs.ts";
import { managedZones, Zone } from "../dns.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { commonName, covers, parseCertificate } from "../pem.ts";
import { requestProxySync } from "../redis.ts";
import { byParam, inOrganization, requirePermission } from "../scope.ts";

// `privateKey`, not `keyPem`: the audit redactor masks keys matching /private/.
const Upload = z.object({
	certPem: z.string().min(1).max(64_000),
	privateKey: z.string().min(1).max(16_000),
});

const Parsed = z
	.object({
		sans: z.array(z.string()),
		issuer: z.string(),
		notBefore: z.string(),
		notAfter: z.string(),
	})
	.openapi("ParsedCertificate");

const CustomCertificate = Parsed.extend({
	id: z.string(),
	name: z.string(),
	domains: z.int(),
	createdAt: z.string(),
}).openapi("CustomCertificate");

const ManagedCertificate = z
	.object({
		names: z.array(z.string()),
		issuer: z.string(),
		notBefore: z.string(),
		notAfter: z.string(),
	})
	.openapi("ManagedCertificate");

const iso = (p: ReturnType<typeof parseCertificate>) => ({
	sans: p.sans,
	issuer: p.issuer,
	notBefore: p.notBefore.toISOString(),
	notAfter: p.notAfter.toISOString(),
});

const tags = ["certificates"];
const admin = [requirePermission("admin", inOrganization)];

/** Mirrors `acmeDirectories` in apps/worker/src/proxy.ts, which maps each to Caddy issuers. */
const AcmeDirectory = z
	.enum(["letsencrypt", "letsencrypt-staging", "zerossl", "internal"])
	.openapi("AcmeDirectory");
const Issuer = z.object({ directory: AcmeDirectory });

const OriginTarget = z
	.object({
		hostname: z.string(),
		provider: z.object({ id: z.string(), name: z.string() }),
		zone: Zone,
		permission: z.string(),
	})
	.openapi("OriginCertificateTarget");

const OriginRequest = z.object({
	keyType: z.enum(["rsa", "ecc"]),
	validityDays: z.literal(originValidityDays),
});

/**
 * The Cloudflare provider whose managed zones own the domain's hostname (the domain's own
 * provider first) and an Origin CA client on its token.
 */
async function originTarget(c: Context<Env>, domainId: string) {
	const { db, masterKey } = c.var.deps;
	const [d] = await db.select().from(domain).where(eq(domain.id, domainId));
	if (!d) throw notFound("domain");
	if (d.tunnel)
		throw new Failure(
			"bad_request",
			"A tunnel domain reaches this server through cloudflared over plain HTTP; it needs no origin certificate",
		);
	if (d.hostname.startsWith("*."))
		throw new Failure(
			"bad_request",
			"A wildcard domain keeps automatic HTTPS over DNS-01; issue origin certificates for exact hostnames",
		);
	const providers = await db
		.select()
		.from(dnsProvider)
		.where(
			and(
				eq(dnsProvider.organizationId, requireActor(c).organizationId),
				eq(dnsProvider.kind, "cloudflare"),
			),
		);
	providers.sort(
		(a, b) =>
			Number(b.id === d.dnsProviderId) - Number(a.id === d.dnsProviderId),
	);
	for (const p of providers) {
		const zone = findZoneForHostname(d.hostname, managedZones(p));
		if (!zone) continue;
		const { apiToken } = cloudflare.configSchema.parse(
			JSON.parse(await decrypt(masterKey, p.credentialsEncrypted)),
		);
		return { domain: d, provider: p, zone, ca: cloudflareOriginCa(apiToken) };
	}
	throw new Failure(
		"bad_request",
		`No Cloudflare DNS provider manages a zone for ${d.hostname}. Connect one under Integrations, DNS first.`,
	);
}

/** Cloudflare failures as 400s; a refused token names the permission it lacks. */
async function viaOriginCa<T>(zone: string, fn: () => Promise<T>) {
	try {
		return await fn();
	} catch (err) {
		if (!(err instanceof ProviderError)) throw err;
		throw new Failure(
			"bad_request",
			err.status === 401 || err.status === 403
				? `Cloudflare refused the token for Origin CA. Give it ${originCaPermission} on ${zone}.`
				: err.message,
		);
	}
}

const originMiddleware = [
	...admin,
	requirePermission("write", byParam("domain")),
];

export const certificates = router()
	.openapi(
		mutation(
			"certificate.origin_test",
			createRoute({
				method: "post",
				path: "/domains/{id}/origin-certificate/test",
				tags,
				security,
				summary:
					"Check that a Cloudflare provider can issue an Origin CA certificate for a domain",
				description: `Finds the Cloudflare DNS provider managing the domain's zone and lists that zone's origin certificates with its token, which needs ${originCaPermission}. Issues nothing.`,
				middleware: originMiddleware,
				request: { params: IdParam },
				responses: { 200: json(OriginTarget, "Ready to issue"), ...errors },
			}),
		),
		async (c) => {
			const t = await originTarget(c, c.req.valid("param").id);
			await viaOriginCa(t.zone.name, () => t.ca.verify(t.zone.id));
			return c.json(
				{
					hostname: t.domain.hostname,
					provider: { id: t.provider.id, name: t.provider.name },
					zone: t.zone,
					permission: originCaPermission,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"certificate.origin_issue",
			createRoute({
				method: "post",
				path: "/domains/{id}/origin-certificate",
				tags,
				security,
				summary:
					"Issue a Cloudflare Origin CA certificate and serve it on a domain",
				description:
					"Generates the private key and CSR on this server, has Cloudflare's Origin CA sign it, stores the pair as a custom certificate (key encrypted) and switches the domain to it. Browsers trust it only through Cloudflare's proxy: keep the record proxied and set the zone's SSL mode to Full (strict).",
				middleware: originMiddleware,
				request: { params: IdParam, ...body(OriginRequest) },
				responses: {
					201: json(CustomCertificate, "Issued and bound"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { keyType, validityDays } = c.req.valid("json");
			const { db, masterKey, config } = c.var.deps;
			const t = await originTarget(c, c.req.valid("param").id);
			const hostnames = [t.domain.hostname];
			const { keyPem, csrPem } = originKeyAndCsr(hostnames, keyType);
			const { certPem } = await viaOriginCa(t.zone.name, () =>
				t.ca.issue({ csrPem, hostnames, keyType, validityDays }),
			);
			const parsed = parseCertificate(certPem, keyPem);
			if (!parsed.sans.some((n) => covers(n, t.domain.hostname)))
				throw new Failure(
					"bad_request",
					`Cloudflare returned a certificate for ${parsed.sans.join(", ")}, not ${t.domain.hostname}`,
				);
			const row = await db.transaction(async (tx) => {
				const crt = one(
					await tx
						.insert(certificate)
						.values({
							organizationId: requireActor(c).organizationId,
							name: `${t.domain.hostname} (Cloudflare Origin)`.slice(0, 100),
							certPem: certPem.trim(),
							keyPemEncrypted: await encrypt(masterKey, keyPem),
							notAfter: parsed.notAfter,
							sans: parsed.sans,
						})
						.returning(),
				);
				await tx
					.update(domain)
					.set({
						https: true,
						cert: "custom",
						customCertificateId: crt.id,
						status: "pending",
						statusMessage: null,
					})
					.where(eq(domain.id, t.domain.id));
				await auditInTx(c, tx, { resourceId: crt.id });
				return crt;
			});
			await requestProxySync(config.REDIS_URL, "origin certificate").catch(
				() => {},
			);
			return c.json(
				{
					id: row.id,
					name: row.name,
					...iso(parsed),
					domains: 1,
					createdAt: row.createdAt.toISOString(),
				},
				201,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/certificates/issuer",
			tags,
			security,
			summary: "Where automatic certificates come from, for the whole instance",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(Issuer, "Issuer"), ...errors },
		}),
		async (c) => {
			const [s] = await c.var.deps.db
				.select({ directory: instanceSettings.acmeDirectory })
				.from(instanceSettings);
			return c.json(
				{ directory: AcmeDirectory.catch("letsencrypt").parse(s?.directory) },
				200,
			);
		},
	)
	.openapi(
		mutation(
			"certificate.issuer",
			createRoute({
				method: "put",
				path: "/certificates/issuer",
				tags,
				security,
				summary: "Switch the ACME directory Caddy issues from",
				description:
					"Takes effect at the next proxy sync. Certificates already issued stay until they renew.",
				middleware: admin,
				request: body(Issuer),
				responses: { 200: json(Issuer, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { directory } = c.req.valid("json");
			const { db, config } = c.var.deps;
			const updated = await db
				.update(instanceSettings)
				.set({ acmeDirectory: directory })
				.returning({ id: instanceSettings.id });
			if (updated.length === 0) throw notFound("instance settings");
			await requestProxySync(config.REDIS_URL, "acme directory changed").catch(
				() => {},
			);
			return c.json({ directory }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/certificates",
			tags,
			security,
			summary: "Uploaded certificates and the ones Caddy manages",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(
					z.object({
						custom: z.array(CustomCertificate),
						managed: z.array(ManagedCertificate),
					}),
					"Certificates",
				),
				...errors,
			},
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			const rows = await db
				.select()
				.from(certificate)
				.where(eq(certificate.organizationId, requireActor(c).organizationId))
				.orderBy(asc(certificate.notAfter));
			const used = rows.length
				? await db
						.select({ id: domain.customCertificateId, n: count() })
						.from(domain)
						.where(
							inArray(
								domain.customCertificateId,
								rows.map((r) => r.id),
							),
						)
						.groupBy(domain.customCertificateId)
				: [];
			const uses = new Map(used.map((u) => [u.id, u.n]));
			const managed = await managedCertificates(config.REDIS_URL);
			return c.json(
				{
					custom: rows.map((r) => {
						const x = new X509Certificate(r.certPem);
						return {
							id: r.id,
							name: r.name,
							sans: r.sans,
							issuer: commonName(x.issuer),
							notBefore: new Date(x.validFrom).toISOString(),
							notAfter: r.notAfter.toISOString(),
							domains: uses.get(r.id) ?? 0,
							createdAt: r.createdAt.toISOString(),
						};
					}),
					managed: managed.sort((a, b) => a.notAfter.localeCompare(b.notAfter)),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"certificate.inspect",
			createRoute({
				method: "post",
				path: "/certificates/inspect",
				tags,
				security,
				summary: "Validate a PEM certificate and key without storing them",
				middleware: admin,
				request: body(Upload),
				responses: { 200: json(Parsed, "Parsed"), ...errors },
			}),
		),
		(c) => {
			const { certPem, privateKey } = c.req.valid("json");
			return c.json(iso(parseCertificate(certPem, privateKey)), 200);
		},
	)
	.openapi(
		mutation(
			"certificate.create",
			createRoute({
				method: "post",
				path: "/certificates",
				tags,
				security,
				summary: "Upload a certificate (with its chain) and private key",
				middleware: admin,
				request: body(Upload.extend({ name: Name })),
				responses: { 201: json(CustomCertificate, "Stored"), ...errors },
			}),
		),
		async (c) => {
			const { name, certPem, privateKey } = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const parsed = parseCertificate(certPem, privateKey);
			const row = one(
				await db
					.insert(certificate)
					.values({
						organizationId: requireActor(c).organizationId,
						name,
						certPem: certPem.trim(),
						keyPemEncrypted: await encrypt(masterKey, privateKey.trim()),
						notAfter: parsed.notAfter,
						sans: parsed.sans,
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(
				{
					id: row.id,
					name: row.name,
					...iso(parsed),
					domains: 0,
					createdAt: row.createdAt.toISOString(),
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"certificate.delete",
			createRoute({
				method: "delete",
				path: "/certificates/{id}",
				tags,
				security,
				description: "Refused with 409 while a domain uses it.",
				middleware: admin,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const inUse = await c.var.deps.db.$count(
				domain,
				eq(domain.customCertificateId, id),
			);
			if (inUse > 0)
				throw new Failure(
					"conflict",
					`${inUse} domain${inUse === 1 ? "" : "s"} still use this certificate`,
				);
			const deleted = await c.var.deps.db
				.delete(certificate)
				.where(
					and(
						eq(certificate.id, id),
						eq(certificate.organizationId, requireActor(c).organizationId),
					),
				)
				.returning({ id: certificate.id });
			if (deleted.length === 0) throw notFound("certificate");
			c.set("auditResourceId", id);
			return c.body(null, 204);
		},
	);
