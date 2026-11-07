import { createRoute } from "@hono/zod-openapi";
import {
	ServiceVulnerabilities,
	VulnSeverity,
	vulnBadge,
} from "@logistack/contracts";
import {
	type Db,
	imageScan,
	imageVulnerability,
	service,
	serviceImage,
} from "@logistack/db";
import { asc, eq, sql } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { notFound } from "../errors.ts";
import { errors, IdParam, json, router, security } from "../openapi.ts";
import { runQueues } from "../run-queues.ts";
import { byParam, requirePermission } from "../scope.ts";

const tags = ["services"];

async function view(
	db: Db,
	serviceId: string,
): Promise<ServiceVulnerabilities> {
	const [svc] = await db
		.select({ id: service.id })
		.from(service)
		.where(eq(service.id, serviceId));
	if (!svc) throw notFound("service");
	const [row] = await db
		.select({ link: serviceImage, scan: imageScan })
		.from(serviceImage)
		.leftJoin(imageScan, eq(imageScan.digest, serviceImage.digest))
		.where(eq(serviceImage.serviceId, serviceId));
	if (!row)
		return {
			image: null,
			digest: null,
			status: null,
			badge: null,
			counts: null,
			scannedAt: null,
			error: null,
			findings: [],
		};
	const rank = sql`array_position(array[${sql.join(
		VulnSeverity.options.map((s) => sql`${s}`),
		sql`, `,
	)}]::text[], ${imageVulnerability.severity})`;
	const findings = await db
		.select({
			id: imageVulnerability.vulnerabilityId,
			severity: imageVulnerability.severity,
			pkgName: imageVulnerability.pkgName,
			installedVersion: imageVulnerability.installedVersion,
			fixedVersion: imageVulnerability.fixedVersion,
			title: imageVulnerability.title,
			url: imageVulnerability.url,
		})
		.from(imageVulnerability)
		.where(eq(imageVulnerability.digest, row.link.digest))
		.orderBy(
			rank,
			asc(imageVulnerability.pkgName),
			asc(imageVulnerability.vulnerabilityId),
		);
	const counts = row.scan?.counts ?? null;
	return {
		image: row.link.image,
		digest: row.link.digest,
		status: row.scan?.status ?? null,
		badge: counts ? vulnBadge(counts) : null,
		counts,
		scannedAt: row.scan?.scannedAt ?? null,
		error: row.scan?.error ?? null,
		findings,
	};
}

export const vulnerabilities = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/vulnerabilities",
			tags,
			security,
			summary: "Known vulnerabilities in the image a service runs",
			description:
				"The last scan of the service's current image digest: a badge (`clean`, `low`, `high` or `critical`; medium and unknown count as low), counts per severity, and each finding with its package, installed version and fixed version, worst first. Images are scanned with Trivy after each deployment and daily; services running the same digest share one result. All fields but `findings` are null before the first scan.",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: {
				200: json(ServiceVulnerabilities, "Vulnerabilities"),
				...errors,
			},
		}),
		async (c) =>
			c.json(await view(c.var.deps.db, c.req.valid("param").id), 200),
	)
	.openapi(
		mutation(
			"service.scan",
			createRoute({
				method: "post",
				path: "/services/{id}/vulnerabilities/scan",
				tags,
				security,
				summary: "Scan a service's image again now",
				description:
					"Queues a scan of the image the service runs, even if it was scanned recently. Poll `GET /services/{id}/vulnerabilities` until `status` is no longer `running`. A new critical finding emits `image.vulnerable`.",
				middleware: [requirePermission("deploy", byParam("service"))],
				request: { params: IdParam },
				responses: {
					202: json(ServiceVulnerabilities, "Queued"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const before = await view(db, id);
			await runQueues(c.var.deps.config.REDIS_URL).scan.add(
				"service",
				{ serviceId: id, force: true },
				{ deduplication: { id: `scan:${id}:force`, ttl: 10_000 } },
			);
			return c.json(before, 202);
		},
	);
