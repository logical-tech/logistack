import { isIP } from "node:net";
import { createRoute, z } from "@hono/zod-openapi";
import {
	Domain,
	DomainInput,
	type GeneratedDomainBase,
} from "@logistack/contracts";
import {
	certificate,
	cloudflareTunnel,
	type Db,
	domain,
	environment,
	folder,
	instanceSettings,
	project,
	service,
} from "@logistack/db";
import { findZoneForHostname } from "@logistack/providers";
import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { managedCertificates } from "../certs.ts";
import { managedZones, openProvider, providerRow } from "../dns.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { covers } from "../pem.ts";
import { publicIp } from "../probe.ts";
import { requestProxySync } from "../redis.ts";
import { actorCan, byParam, requirePermission } from "../scope.ts";

/**
 * `<svc-slug>-<short>.<ip-dashed>.sslip.io` (or nip.io), or `<svc-slug>-<short>.<wildcard>`
 * for a custom wildcard such as `*.srv1.example.com`. `short` is the id's last 6 characters.
 */
export function generatedHostname(input: {
	slug: string;
	serviceId: string;
	base: GeneratedDomainBase;
	ip?: string;
	customWildcard?: string | null;
}): string {
	const short = input.serviceId.slice(-6);
	const label = `${input.slug.slice(0, 63 - short.length - 1).replace(/-+$/, "")}-${short}`;
	if (input.base === "custom") {
		if (!input.customWildcard?.startsWith("*."))
			throw new Failure(
				"bad_request",
				"no custom wildcard domain is configured",
			);
		return `${label}.${input.customWildcard.slice(2)}`;
	}
	const family = input.ip ? isIP(input.ip) : 0;
	if (family === 0)
		throw new Failure("bad_request", "PUBLIC_IP is not configured");
	if (family === 6 && input.base === "nip")
		throw new Failure("bad_request", "nip.io does not support IPv6; use sslip");
	// sslip.io reads IPv6 with dashes for colons; a label cannot start or end with a dash.
	const dashed = (input.ip as string)
		.replaceAll(/[.:]/g, "-")
		.replace(/^-/, "0-")
		.replace(/-$/, "-0");
	return `${label}.${dashed}.${input.base}.io`;
}

/** DomainInput plus the id of a record created through `/services/{id}/dns-records`. */
const DomainBody = z
	.object({
		...DomainInput.shape,
		dnsRecordId: z.string().nullable().optional(),
	})
	.refine((d) => (d.cert === "custom") === Boolean(d.customCertificateId), {
		message:
			"customCertificateId is required for, and only allowed with, cert 'custom'",
		path: ["customCertificateId"],
	});
type DomainBody = z.infer<typeof DomainBody>;

/** How a domain gets its certificate. A linked DNS provider means DNS-01. */
export const tlsMode = (d: {
	https: boolean;
	cert: string;
	dnsProviderId?: string | null;
}) =>
	!d.https || d.cert === "none"
		? ("none" as const)
		: d.cert === "custom"
			? ("custom" as const)
			: d.dnsProviderId
				? ("dns-01" as const)
				: ("http-01" as const);

/**
 * Rejects what the proxy compiler cannot route, so one bad row never reaches a sync: a
 * wildcard needs DNS-01 through a provider managing its zone, a linked provider must manage
 * the hostname, and a custom certificate must name it. Every referenced row must belong to
 * the organization.
 */
async function assertRoutable(
	db: Db,
	organizationId: string,
	input: DomainBody,
) {
	if (input.tunnel) {
		if (!input.dnsProviderId)
			throw new Failure(
				"bad_request",
				"a tunnel domain needs its Cloudflare provider",
			);
		if (input.https || input.cert !== "none")
			throw new Failure(
				"bad_request",
				"a tunnel domain is plain HTTP behind Cloudflare: https false, cert none",
			);
		const [t] = await db
			.select({ id: cloudflareTunnel.id })
			.from(cloudflareTunnel)
			.where(
				and(
					eq(cloudflareTunnel.dnsProviderId, input.dnsProviderId),
					eq(cloudflareTunnel.organizationId, organizationId),
				),
			);
		if (!t)
			throw new Failure(
				"bad_request",
				"this DNS provider has no Cloudflare Tunnel",
			);
	} else if (input.hostname.startsWith("*.") && tlsMode(input) !== "dns-01")
		throw new Failure(
			"bad_request",
			"A wildcard domain needs automatic HTTPS through a DNS provider (DNS-01)",
		);
	if (input.dnsRecordId && !input.dnsProviderId)
		throw new Failure("bad_request", "dnsRecordId needs its dnsProviderId");
	if (input.dnsProviderId) {
		const p = await providerRow(db, organizationId, input.dnsProviderId);
		if (!findZoneForHostname(input.hostname, managedZones(p)))
			throw new Failure(
				"bad_request",
				`${p.name} does not manage a zone for ${input.hostname}`,
			);
	}
	if (input.customCertificateId) {
		const [crt] = await db
			.select({ sans: certificate.sans })
			.from(certificate)
			.where(
				and(
					eq(certificate.id, input.customCertificateId),
					eq(certificate.organizationId, organizationId),
				),
			);
		if (!crt) throw notFound("certificate");
		if (!crt.sans.some((n) => covers(n, input.hostname)))
			throw new Failure(
				"bad_request",
				`The certificate does not cover ${input.hostname}`,
			);
	}
}

type DomainRow = typeof domain.$inferSelect;

/** Access rules have their own endpoint, which never returns basic auth hashes. */
const withoutAccess = ({ access: _, ...d }: DomainRow) => d;

/** Best effort: a record LogiStack created goes away with its domain. */
async function deleteRecord(c: Context<Env>, row: DomainRow) {
	if (!row.dnsProviderId || !row.dnsRecordId) return;
	const { db, masterKey } = c.var.deps;
	try {
		const p = await providerRow(
			db,
			requireActor(c).organizationId,
			row.dnsProviderId,
		);
		const zone = findZoneForHostname(row.hostname, managedZones(p));
		if (zone)
			await (await openProvider(masterKey, p)).deleteRecord(
				zone.id,
				row.dnsRecordId,
			);
	} catch (err) {
		log("warn", "dns record cleanup failed", {
			domainId: row.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

const sync = (c: Context<Env>, reason: string) =>
	requestProxySync(c.var.deps.config.REDIS_URL, reason).catch((err: unknown) =>
		log("warn", "proxy sync request failed", { error: String(err) }),
	);

const DomainListItem = z
	.object({
		id: z.string(),
		hostname: z.string(),
		port: z.int(),
		pathPrefix: z.string().nullable(),
		https: z.boolean(),
		cert: z.enum(["auto", "custom", "none"]),
		tls: z.enum(["http-01", "dns-01", "custom", "none"]),
		isGenerated: z.boolean(),
		dnsProviderId: z.string().nullable(),
		dnsRecordId: z.string().nullable(),
		tunnel: z.boolean(),
		customCertificateId: z.string().nullable(),
		redirectTo: z.string().nullable(),
		/** Rule types checked before the upstream; GET /domains/{id}/access has the rules. */
		access: z.array(z.enum(["ip_allow", "forward_auth", "basic_auth"])),
		status: z.enum(["pending", "active", "error"]),
		statusMessage: z.string().nullable(),
		service: z.object({ id: z.string(), name: z.string() }),
		project: z.object({ id: z.string(), name: z.string() }),
		environment: z.object({ id: z.string(), name: z.string() }),
		/** null while no certificate serves the hostname (pending issuance, or HTTP only). */
		certificate: z
			.object({
				source: z.enum(["managed", "custom"]),
				name: z.string().nullable(),
				issuer: z.string(),
				notAfter: z.string(),
			})
			.nullable(),
		createdAt: z.string(),
	})
	.openapi("DomainListItem");

const tags = ["domains"];

export const domains = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/domains",
			tags,
			security,
			summary:
				"Every domain the caller can read, with its service and certificate",
			description:
				"Filtered per service, so a grant on one project lists only that project's domains.",
			responses: { 200: json(z.array(DomainListItem), "Domains"), ...errors },
		}),
		async (c) => {
			const actor = requireActor(c);
			const { db, config } = c.var.deps;
			const [rows, managed] = await Promise.all([
				db
					.select({
						domain,
						service: { id: service.id, name: service.name },
						environment: { id: environment.id, name: environment.name },
						project: {
							id: project.id,
							name: project.name,
							folderId: project.folderId,
						},
						parentFolderId: folder.parentId,
						cert: { name: certificate.name, notAfter: certificate.notAfter },
					})
					.from(domain)
					.innerJoin(service, eq(service.id, domain.serviceId))
					.innerJoin(environment, eq(environment.id, service.environmentId))
					.innerJoin(project, eq(project.id, environment.projectId))
					.leftJoin(folder, eq(folder.id, project.folderId))
					.leftJoin(certificate, eq(certificate.id, domain.customCertificateId))
					.where(eq(project.organizationId, actor.organizationId))
					.orderBy(asc(domain.hostname)),
				managedCertificates(config.REDIS_URL),
			]);
			const visible = rows.filter((r) =>
				actorCan(actor, "read", {
					type: "service",
					organizationId: actor.organizationId,
					folderIds: [r.parentFolderId, r.project.folderId].filter(
						(id): id is string => id !== null,
					),
					projectId: r.project.id,
					environmentId: r.environment.id,
					serviceId: r.service.id,
				}),
			);
			return c.json(
				visible.map(({ domain: d, service, environment, project, cert }) => {
					const tls = tlsMode(d);
					// The newest managed certificate naming the host; Caddy serves the freshest.
					const auto =
						tls === "http-01" || tls === "dns-01"
							? managed
									.filter((m) => m.names.some((n) => covers(n, d.hostname)))
									.sort((a, b) => b.notAfter.localeCompare(a.notAfter))[0]
							: undefined;
					return {
						id: d.id,
						hostname: d.hostname,
						port: d.port,
						pathPrefix: d.pathPrefix,
						https: d.https,
						cert: d.cert,
						tls,
						isGenerated: d.isGenerated,
						dnsProviderId: d.dnsProviderId,
						dnsRecordId: d.dnsRecordId,
						tunnel: d.tunnel,
						customCertificateId: d.customCertificateId,
						redirectTo: d.redirectTo,
						access: d.access.map((r) => r.type),
						status: d.status,
						statusMessage: d.statusMessage,
						service,
						environment,
						project: { id: project.id, name: project.name },
						certificate:
							tls === "custom" && cert?.notAfter
								? {
										source: "custom" as const,
										name: cert.name,
										issuer: "Uploaded",
										notAfter: cert.notAfter.toISOString(),
									}
								: auto
									? {
											source: "managed" as const,
											name: null,
											issuer: auto.issuer,
											notAfter: auto.notAfter,
										}
									: null,
						createdAt: d.createdAt.toISOString(),
					};
				}),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/domains",
			tags,
			security,
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(z.array(Domain), "Domains"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(domain)
				.where(eq(domain.serviceId, c.req.valid("param").id))
				.orderBy(asc(domain.hostname));
			return c.json(rows.map(withoutAccess), 200);
		},
	)
	.openapi(
		mutation(
			"domain.create",
			createRoute({
				method: "post",
				path: "/services/{id}/domains",
				tags,
				security,
				description:
					"A wildcard hostname is refused unless it uses DNS-01 through a provider that manages its zone.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(DomainBody) },
				responses: { 201: json(Domain, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			await assertRoutable(db, requireActor(c).organizationId, input);
			const row = one(
				await db
					.insert(domain)
					.values({ ...input, serviceId: c.req.valid("param").id })
					.returning(),
			);
			c.set("auditResourceId", row.id);
			await sync(c, "domain created");
			return c.json(withoutAccess(row), 201);
		},
	)
	.openapi(
		mutation(
			"domain.create",
			createRoute({
				method: "post",
				path: "/services/{id}/domains/generated",
				tags,
				security,
				summary: "Add a generated sslip.io / nip.io / wildcard hostname",
				middleware: [requirePermission("write", byParam("service"))],
				request: {
					params: IdParam,
					...body(z.object({ port: z.int().min(1).max(65535) })),
				},
				responses: { 201: json(Domain, "Created"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db, config } = c.var.deps;
			const [svc] = await db
				.select({ slug: service.slug })
				.from(service)
				.where(eq(service.id, id));
			const [settings] = await db.select().from(instanceSettings);
			const hostname = generatedHostname({
				slug: svc?.slug ?? "svc",
				serviceId: id,
				base: settings?.generatedDomainBase ?? "sslip",
				ip: (await publicIp(config)) ?? undefined,
				customWildcard: settings?.customWildcard,
			});
			const row = one(
				await db
					.insert(domain)
					.values({
						serviceId: id,
						hostname,
						port: c.req.valid("json").port,
						isGenerated: true,
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			await sync(c, "domain created");
			return c.json(withoutAccess(row), 201);
		},
	)
	.openapi(
		mutation(
			"domain.update",
			createRoute({
				method: "put",
				path: "/domains/{id}",
				tags,
				security,
				summary: "Replace a domain's routing; status returns to pending",
				middleware: [requirePermission("write", byParam("domain"))],
				request: { params: IdParam, ...body(DomainBody) },
				responses: { 200: json(Domain, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			await assertRoutable(db, requireActor(c).organizationId, input);
			const [before] = await db.select().from(domain).where(eq(domain.id, id));
			const row = one(
				await db
					.update(domain)
					.set({
						pathPrefix: null,
						customCertificateId: null,
						redirectTo: null,
						dnsProviderId: null,
						dnsRecordId: null,
						tunnel: false,
						...input,
						status: "pending",
						statusMessage: null,
					})
					.where(eq(domain.id, id))
					.returning(),
			);
			// A record the domain no longer points at is no longer ours to keep.
			if (
				before?.dnsRecordId &&
				(before.dnsRecordId !== row.dnsRecordId ||
					before.dnsProviderId !== row.dnsProviderId)
			)
				await deleteRecord(c, before);
			c.set("auditResourceId", id);
			await sync(c, "domain updated");
			return c.json(withoutAccess(row), 200);
		},
	)
	.openapi(
		mutation(
			"domain.delete",
			createRoute({
				method: "delete",
				path: "/domains/{id}",
				tags,
				security,
				description:
					"Also deletes the DNS record LogiStack created for it, best effort.",
				middleware: [requirePermission("write", byParam("domain"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const [row] = await c.var.deps.db
				.delete(domain)
				.where(eq(domain.id, id))
				.returning();
			if (row) await deleteRecord(c, row);
			c.set("auditResourceId", id);
			await sync(c, "domain deleted");
			return c.body(null, 204);
		},
	);
