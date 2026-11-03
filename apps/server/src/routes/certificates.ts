import { X509Certificate } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { encrypt } from "@logistack/core";
import { certificate, domain, instanceSettings } from "@logistack/db";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { managedCertificates } from "../certs.ts";
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
import { commonName, parseCertificate } from "../pem.ts";
import { requestProxySync } from "../redis.ts";
import { inOrganization, requirePermission } from "../scope.ts";

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

export const certificates = router()
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
