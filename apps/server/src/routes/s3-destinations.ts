import { createRoute, z } from "@hono/zod-openapi";
import { encrypt } from "@logistack/core";
import { backupPolicy, s3Destination } from "@logistack/db";
import { ProviderError } from "@logistack/providers";
import { and, asc, count, eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
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
import { guardedDestination } from "../s3.ts";
import { inOrganization, requirePermission } from "../scope.ts";
import { BlockedHostError, hostPolicy } from "../ssrf.ts";

export const S3DestinationView = z
	.object({
		id: z.string(),
		name: z.string(),
		endpoint: z.string(),
		region: z.string(),
		bucket: z.string(),
		prefix: z.string(),
		accessKeyId: z.string(),
		forcePathStyle: z.boolean(),
		/** Backup policies writing here; a destination in use cannot be deleted. */
		usedBy: z.int(),
		createdAt: z.string(),
	})
	.openapi("S3Destination");

export const Connection = z.object({
	endpoint: z.url({ protocol: /^https?$/ }),
	region: z.string().trim().min(1).default("us-east-1"),
	bucket: z
		.string()
		.trim()
		.regex(
			/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
			"3 to 63 lowercase letters, digits, dots and dashes",
		),
	prefix: z
		.string()
		.trim()
		.max(200)
		.regex(/^[A-Za-z0-9!_.*'()/-]*$/, "letters, digits and / - _ . only")
		.transform((p) => p.replace(/^\/+/, ""))
		.default(""),
	accessKeyId: z.string().trim().min(1),
	secretAccessKey: z.string().min(1),
	forcePathStyle: z.boolean().default(false),
});

const Check = z
	.object({
		ok: z.boolean(),
		message: z.string(),
		detail: z.string().optional(),
	})
	.openapi("S3Check");

export const s3Destinations = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/s3-destinations",
			tags: ["backups"],
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(S3DestinationView), "Destinations"),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const rows = await db
				.select({ d: s3Destination, usedBy: count(backupPolicy.id) })
				.from(s3Destination)
				.leftJoin(
					backupPolicy,
					eq(backupPolicy.s3DestinationId, s3Destination.id),
				)
				.where(eq(s3Destination.organizationId, requireActor(c).organizationId))
				.groupBy(s3Destination.id)
				.orderBy(asc(s3Destination.name));
			return c.json(
				rows.map(({ d, usedBy }) => ({
					id: d.id,
					name: d.name,
					endpoint: d.endpoint,
					region: d.region,
					bucket: d.bucket,
					prefix: d.prefix,
					accessKeyId: d.accessKeyId,
					forcePathStyle: d.forcePathStyle,
					usedBy,
					createdAt: d.createdAt.toISOString(),
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"s3_destination.test",
			createRoute({
				method: "post",
				path: "/s3-destinations/test",
				tags: ["backups"],
				security,
				summary: "Put, read back and delete a probe object",
				description:
					"Writes `<prefix>/.logistack-probe-<uuid>`, reads it, deletes it. Nothing is stored in LogiStack.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(Connection),
				responses: { 200: json(Check, "Result"), ...errors },
			}),
		),
		async (c) => {
			const config = c.req.valid("json");
			const started = performance.now();
			try {
				const dest = await guardedDestination(
					config,
					await hostPolicy(c.var.deps.db),
				);
				await dest.test();
				const ms = Math.round(performance.now() - started);
				return c.json(
					{
						ok: true,
						message: `Wrote, read and deleted a probe object in ${config.bucket}`,
						detail: `Round trip in ${ms} ms`,
					},
					200,
				);
			} catch (e) {
				if (!(e instanceof ProviderError || e instanceof BlockedHostError))
					throw e;
				return c.json(
					{
						ok: false,
						message:
							e instanceof BlockedHostError
								? "Endpoint not allowed"
								: "The bucket refused the probe",
						detail: e.message,
					},
					200,
				);
			}
		},
	)
	.openapi(
		mutation(
			"s3_destination.create",
			createRoute({
				method: "post",
				path: "/s3-destinations",
				tags: ["backups"],
				security,
				summary: "Add an S3-compatible destination",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(Connection.extend({ name: Name })),
				responses: {
					201: json(z.object({ id: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { secretAccessKey, ...input } = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const row = one(
				await db
					.insert(s3Destination)
					.values({
						...input,
						organizationId: requireActor(c).organizationId,
						secretEncrypted: await encrypt(masterKey, secretAccessKey),
					})
					.returning({ id: s3Destination.id }),
			);
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	)
	.openapi(
		mutation(
			"s3_destination.delete",
			createRoute({
				method: "delete",
				path: "/s3-destinations/{id}",
				tags: ["backups"],
				security,
				summary: "Remove a destination no backup policy uses",
				description:
					"Objects already in the bucket stay. Refused with 409 while a policy still writes here.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			c.set("auditResourceId", id);
			const orgId = requireActor(c).organizationId;
			const owned = and(
				eq(s3Destination.id, id),
				eq(s3Destination.organizationId, orgId),
			);
			one(
				await db
					.select({ id: s3Destination.id })
					.from(s3Destination)
					.where(owned),
				"s3 destination",
			);
			const inUse = await db.$count(
				backupPolicy,
				eq(backupPolicy.s3DestinationId, id),
			);
			if (inUse)
				throw new Failure(
					"conflict",
					`${inUse} backup ${inUse === 1 ? "policy writes" : "policies write"} here; move or delete ${inUse === 1 ? "it" : "them"} first`,
					{ usedBy: inUse },
				);
			const rows = await db
				.delete(s3Destination)
				.where(owned)
				.returning({ id: s3Destination.id });
			if (!rows.length) throw notFound("s3 destination");
			return c.body(null, 204);
		},
	);
