import { createRoute, z } from "@hono/zod-openapi";
import {
	BucketAccess,
	BucketName,
	ObjectKey,
	ObservedState,
	StorageEngine,
	StorageKeyAccess,
} from "@logistack/contracts";
import {
	encrypt,
	isPublicRead,
	newStorageKey,
	publicReadPolicy,
	type Resource,
	STORAGE_REGION,
	scopedKeyPolicy,
	storageEngineDefs,
} from "@logistack/core";
import {
	type Db,
	environment,
	folder,
	project,
	s3Destination,
	service,
	serviceStatus,
	storageAccessKey,
} from "@logistack/db";
import { and, asc, eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, one } from "../errors.ts";
import { body, errors, json, Name, router, security } from "../openapi.ts";
import { actorCan, byParam, check, requirePermission } from "../scope.ts";
import {
	downloadHeaders,
	openStorage,
	readShareToken,
	shareToken,
} from "../storage.ts";

const Id = z.object({ id: z.string() });
const BucketParams = z.object({ id: z.string(), bucket: BucketName });
const KeyQuery = z.object({ key: ObjectKey });
const svc = byParam("service");

const Capabilities = z
	.object({
		versioning: z.boolean(),
		bucketPolicy: z.boolean(),
		accessKeys: z.boolean(),
		usage: z.boolean(),
		console: z.boolean(),
	})
	.openapi("StorageCapabilities");

const StorageListItem = z
	.object({
		id: z.string(),
		name: z.string(),
		slug: z.string(),
		engine: StorageEngine,
		projectId: z.string(),
		projectName: z.string(),
		environmentId: z.string(),
		environmentName: z.string(),
		observed: ObservedState,
		createdAt: z.string(),
	})
	.openapi("StorageListItem");

const Connection = z
	.object({
		engine: StorageEngine,
		version: z.string(),
		region: z.string(),
		pathStyle: z.literal(true),
		/** Apps in the same environment reach it here (the service slug on the environment network). */
		internalEndpoint: z.string(),
		publicEndpoint: z.string().nullable(),
		consoleUrl: z.string().nullable(),
		accessKeyId: z.string(),
		capabilities: Capabilities,
	})
	.openapi("StorageConnection");

const Bucket = z
	.object({
		name: z.string(),
		createdAt: z.string(),
		/** null when the engine has no versioning. */
		versioning: z.boolean().nullable(),
		/** null when the engine has no bucket policies. */
		access: BucketAccess.nullable(),
		size: z.number().nullable(),
		objects: z.number().nullable(),
	})
	.openapi("StorageBucket");

const ObjectList = z
	.object({
		folders: z.array(z.string()),
		objects: z.array(
			z.object({
				key: z.string(),
				size: z.number(),
				lastModified: z.string(),
				etag: z.string(),
			}),
		),
		nextCursor: z.string().nullable(),
	})
	.openapi("StorageObjectList");

const AccessKey = z
	.object({
		id: z.string(),
		name: z.string(),
		accessKeyId: z.string(),
		buckets: z.array(z.string()),
		access: StorageKeyAccess,
		createdAt: z.string(),
	})
	.openapi("StorageAccessKey");

const KeyInput = z.object({
	name: Name,
	buckets: z.array(BucketName).min(1).max(50),
	access: StorageKeyAccess,
});

/** Engines answer slowly to many policy lookups; cap the per-bucket detail calls. */
const DETAIL_LIMIT = 200;
const MAX_SHARE_SECONDS = 7 * 24 * 3600;

async function keyRow(db: Db, serviceId: string, keyId: string) {
	return one(
		await db
			.select()
			.from(storageAccessKey)
			.where(
				and(
					eq(storageAccessKey.id, keyId),
					eq(storageAccessKey.serviceId, serviceId),
				),
			),
		"access key",
	);
}

export const storage = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/storage",
			tags: ["storage"],
			security,
			summary: "Storage services across every project the caller can read",
			responses: {
				200: json(z.array(StorageListItem), "Storage services"),
				...errors,
			},
		}),
		async (c) => {
			const actor = requireActor(c);
			const rows = await c.var.deps.db
				.select({
					s: service,
					projectId: project.id,
					projectName: project.name,
					folderId: project.folderId,
					parentFolderId: folder.parentId,
					environmentName: environment.name,
					observed: serviceStatus.observed,
				})
				.from(service)
				.innerJoin(environment, eq(environment.id, service.environmentId))
				.innerJoin(project, eq(project.id, environment.projectId))
				.leftJoin(folder, eq(folder.id, project.folderId))
				.leftJoin(serviceStatus, eq(serviceStatus.serviceId, service.id))
				.where(
					and(
						eq(service.kind, "storage"),
						eq(project.organizationId, actor.organizationId),
					),
				)
				.orderBy(asc(project.name), asc(service.name));
			return c.json(
				rows
					.filter((r) => {
						const resource: Resource = {
							type: "service",
							organizationId: actor.organizationId,
							folderIds: [r.parentFolderId, r.folderId].filter(
								(f): f is string => f !== null,
							),
							projectId: r.projectId,
							environmentId: r.s.environmentId,
							serviceId: r.s.id,
						};
						return actorCan(actor, "read", resource);
					})
					.flatMap((r) =>
						r.s.spec.kind === "storage"
							? [
									{
										id: r.s.id,
										name: r.s.name,
										slug: r.s.slug,
										engine: r.s.spec.engine,
										projectId: r.projectId,
										projectName: r.projectName,
										environmentId: r.s.environmentId,
										environmentName: r.environmentName,
										observed: r.observed ?? ("unknown" as const),
										createdAt: r.s.createdAt.toISOString(),
									},
								]
							: [],
					),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/{id}/connection",
			tags: ["storage"],
			security,
			summary:
				"Endpoints, region and capabilities; the root secret needs read:secrets",
			middleware: [requirePermission("read", svc)],
			request: { params: Id },
			responses: { 200: json(Connection, "Connection"), ...errors },
		}),
		async (c) => {
			const s = await openStorage(c, c.req.valid("param").id);
			const def = storageEngineDefs[s.engine];
			return c.json(
				{
					engine: s.engine,
					version: def.version,
					region: STORAGE_REGION,
					pathStyle: true as const,
					internalEndpoint: `http://${s.slug}:${def.s3Port}`,
					publicEndpoint: s.publicEndpoint,
					consoleUrl: s.consoleUrl,
					accessKeyId: s.accessKeyId,
					capabilities: def.capabilities,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/{id}/credentials",
			tags: ["storage"],
			security,
			summary: "The root access key and secret",
			middleware: [requirePermission("read:secrets", svc)],
			request: { params: Id },
			responses: {
				200: json(
					z.object({ accessKeyId: z.string(), secretAccessKey: z.string() }),
					"Root credentials",
				),
				...errors,
			},
		}),
		async (c) => {
			const s = await openStorage(c, c.req.valid("param").id);
			return c.json(
				{ accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/{id}/buckets",
			tags: ["storage"],
			security,
			summary:
				"Buckets with versioning, access and usage where the engine has them",
			middleware: [requirePermission("read", svc)],
			request: { params: Id },
			responses: { 200: json(z.array(Bucket), "Buckets"), ...errors },
		}),
		async (c) => {
			const s = await openStorage(c, c.req.valid("param").id);
			const caps = storageEngineDefs[s.engine].capabilities;
			const [buckets, usage] = await Promise.all([
				s.client.listBuckets(),
				s.client.usage().catch(() => null),
			]);
			const detailed = buckets.length <= DETAIL_LIMIT;
			const rows = await Promise.all(
				buckets.map(async (b) => ({
					name: b.name,
					createdAt: b.createdAt,
					versioning:
						caps.versioning && detailed
							? await s.client.getVersioning(b.name).catch(() => null)
							: null,
					access:
						caps.bucketPolicy && detailed
							? await s.client
									.getPolicy(b.name)
									.then((p) =>
										isPublicRead(p)
											? ("public-read" as const)
											: ("private" as const),
									)
									.catch(() => null)
							: null,
					size: usage?.[b.name]?.size ?? (usage ? 0 : null),
					objects: usage?.[b.name]?.objects ?? (usage ? 0 : null),
				})),
			);
			return c.json(rows, 200);
		},
	)
	.openapi(
		mutation(
			"storage.bucket_create",
			createRoute({
				method: "post",
				path: "/storage/{id}/buckets",
				tags: ["storage"],
				security,
				middleware: [requirePermission("write", svc)],
				request: { params: Id, ...body(z.object({ name: BucketName })) },
				responses: {
					201: json(z.object({ name: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { name } = c.req.valid("json");
			const s = await openStorage(c, c.req.valid("param").id);
			await s.client.createBucket(name);
			return c.json({ name }, 201);
		},
	)
	.openapi(
		mutation(
			"storage.bucket_update",
			createRoute({
				method: "patch",
				path: "/storage/{id}/buckets/{bucket}",
				tags: ["storage"],
				security,
				summary: "Toggle versioning or switch between private and public-read",
				middleware: [requirePermission("write", svc)],
				request: {
					params: BucketParams,
					...body(
						z.object({
							versioning: z.boolean().optional(),
							access: BucketAccess.optional(),
						}),
					),
				},
				responses: { 204: { description: "Updated" }, ...errors },
			}),
		),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const input = c.req.valid("json");
			const s = await openStorage(c, id);
			const caps = storageEngineDefs[s.engine].capabilities;
			if (input.versioning !== undefined) {
				if (!caps.versioning)
					throw new Failure("bad_request", `${s.engine} has no versioning`);
				await s.client.setVersioning(bucket, input.versioning);
			}
			if (input.access) {
				if (!caps.bucketPolicy)
					throw new Failure(
						"bad_request",
						`${s.engine} has no bucket policies`,
					);
				await s.client.setPolicy(
					bucket,
					input.access === "public-read" ? publicReadPolicy(bucket) : null,
				);
			}
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"storage.bucket_delete",
			createRoute({
				method: "delete",
				path: "/storage/{id}/buckets/{bucket}",
				tags: ["storage"],
				security,
				summary: "Delete a bucket and every object in it",
				description:
					"`confirm` must repeat the bucket name. Every object (and version) is deleted first.",
				middleware: [requirePermission("delete", svc)],
				request: {
					params: BucketParams,
					query: z.object({ confirm: z.string() }),
				},
				responses: {
					200: json(z.object({ deletedObjects: z.int() }), "Deleted"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			if (c.req.valid("query").confirm !== bucket)
				throw new Failure("bad_request", "type the bucket name to confirm");
			const s = await openStorage(c, id);
			const inUse = await c.var.deps.db.$count(
				s3Destination,
				and(
					eq(s3Destination.storageServiceId, id),
					eq(s3Destination.bucket, bucket),
				),
			);
			if (inUse)
				throw new Failure(
					"conflict",
					"a backup destination writes to this bucket; remove it first",
				);
			return c.json(
				{ deletedObjects: await s.client.deleteBucket(bucket) },
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/{id}/buckets/{bucket}/objects",
			tags: ["storage"],
			security,
			summary: "One folder level of a bucket, paginated",
			middleware: [requirePermission("read", svc)],
			request: {
				params: BucketParams,
				query: z.object({
					prefix: z.string().max(1024).default(""),
					cursor: z.string().optional(),
					limit: z.coerce.number().int().min(1).max(1000).default(200),
				}),
			},
			responses: { 200: json(ObjectList, "Objects"), ...errors },
		}),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const q = c.req.valid("query");
			const s = await openStorage(c, id);
			return c.json(
				await s.client.listObjects(bucket, {
					prefix: q.prefix,
					limit: q.limit,
					...(q.cursor ? { cursor: q.cursor } : {}),
				}),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/{id}/buckets/{bucket}/object",
			tags: ["storage"],
			security,
			summary: "An object's size, type and metadata",
			middleware: [requirePermission("read", svc)],
			request: { params: BucketParams, query: KeyQuery },
			responses: {
				200: json(
					z
						.object({
							key: z.string(),
							size: z.number(),
							contentType: z.string().nullable(),
							etag: z.string().nullable(),
							lastModified: z.string().nullable(),
							metadata: z.record(z.string(), z.string()),
							s3Url: z.string(),
						})
						.openapi("StorageObject"),
					"Object",
				),
				...errors,
			},
		}),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const { key } = c.req.valid("query");
			const s = await openStorage(c, id);
			return c.json(
				{
					key,
					...(await s.client.head(bucket, key)),
					s3Url: `s3://${bucket}/${key}`,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/{id}/buckets/{bucket}/download",
			tags: ["storage"],
			security,
			summary: "Stream an object (always as an attachment)",
			middleware: [requirePermission("read", svc)],
			request: { params: BucketParams, query: KeyQuery },
			responses: { 200: { description: "The object bytes" }, ...errors },
		}),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const { key } = c.req.valid("query");
			const s = await openStorage(c, id);
			const res = await s.client.download(bucket, key);
			return new Response(res.body, { headers: downloadHeaders(res, key) });
		},
	)
	.openapi(
		mutation(
			"storage.object_upload",
			createRoute({
				method: "put",
				path: "/storage/{id}/buckets/{bucket}/upload",
				tags: ["storage"],
				security,
				summary: "Stream the request body into an object",
				description:
					"The raw body is piped into a multipart upload, never buffered; `Content-Type` is stored with the object.",
				middleware: [requirePermission("write", svc)],
				request: { params: BucketParams, query: KeyQuery },
				responses: {
					201: json(z.object({ key: z.string() }), "Stored"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const { key } = c.req.valid("query");
			const body = c.req.raw.body;
			if (!body) throw new Failure("bad_request", "empty body");
			const type = c.req.header("content-type");
			c.set("auditDiff", {
				bucket,
				key,
				size: Number(c.req.header("content-length") ?? 0) || null,
			});
			const s = await openStorage(c, id);
			await s.client.upload(bucket, key, body, type);
			return c.json({ key }, 201);
		},
	)
	.openapi(
		mutation(
			"storage.object_delete",
			createRoute({
				method: "post",
				path: "/storage/{id}/buckets/{bucket}/delete",
				tags: ["storage"],
				security,
				summary: "Delete objects; a key ending in / deletes that whole folder",
				middleware: [requirePermission("write", svc)],
				request: {
					params: BucketParams,
					...body(z.object({ keys: z.array(ObjectKey).min(1).max(1000) })),
				},
				responses: {
					200: json(z.object({ deleted: z.int() }), "Deleted"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const s = await openStorage(c, id);
			return c.json(
				{
					deleted: await s.client.deleteObjects(
						bucket,
						c.req.valid("json").keys,
					),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"storage.object_copy",
			createRoute({
				method: "post",
				path: "/storage/{id}/buckets/{bucket}/copy",
				tags: ["storage"],
				security,
				summary: "Copy an object, or rename it with move",
				middleware: [requirePermission("write", svc)],
				request: {
					params: BucketParams,
					...body(
						z.object({
							from: ObjectKey,
							to: ObjectKey,
							move: z.boolean().default(false),
						}),
					),
				},
				responses: { 204: { description: "Copied" }, ...errors },
			}),
		),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const { from, to, move } = c.req.valid("json");
			if (from === to)
				throw new Failure("bad_request", "source and target are the same");
			const s = await openStorage(c, id);
			await s.client.copy(bucket, from, to);
			if (move) await s.client.deleteObjects(bucket, [from]);
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"storage.object_share",
			createRoute({
				method: "post",
				path: "/storage/{id}/buckets/{bucket}/share",
				tags: ["storage"],
				security,
				summary: "A download link that expires",
				description:
					"With a public S3 domain: an S3 presigned URL. Without one: a LogiStack link sealed with the instance key, served by the api.",
				middleware: [requirePermission("write", svc)],
				request: {
					params: BucketParams,
					...body(
						z.object({
							key: ObjectKey,
							expiresIn: z.int().min(60).max(MAX_SHARE_SECONDS),
						}),
					),
				},
				responses: {
					200: json(
						z
							.object({
								url: z.string(),
								expiresAt: z.string(),
								via: z.enum(["s3", "logistack"]),
							})
							.openapi("StorageShareLink"),
						"Link",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id, bucket } = c.req.valid("param");
			const { key, expiresIn } = c.req.valid("json");
			const s = await openStorage(c, id);
			await s.client.head(bucket, key);
			const expiresAt = new Date(Date.now() + expiresIn * 1000);
			if (s.publicEndpoint)
				return c.json(
					{
						url: s.client.presign(bucket, key, expiresIn, s.publicEndpoint),
						expiresAt: expiresAt.toISOString(),
						via: "s3" as const,
					},
					200,
				);
			const token = await shareToken(c.var.deps, {
				s: id,
				b: bucket,
				k: key,
				e: expiresAt.getTime(),
			});
			const origin = new URL(c.var.deps.config.BETTER_AUTH_URL).origin;
			return c.json(
				{
					url: `${origin}/api/storage/shared/${token}`,
					expiresAt: expiresAt.toISOString(),
					via: "logistack" as const,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/shared/{token}",
			tags: ["storage"],
			summary:
				"Download through a share link; no session needed until it expires",
			request: { params: z.object({ token: z.string().max(4096) }) },
			responses: { 200: { description: "The object bytes" }, ...errors },
		}),
		async (c) => {
			const p = await readShareToken(c.var.deps, c.req.valid("param").token);
			const s = await openStorage(c, p.s);
			const res = await s.client.download(p.b, p.k);
			return new Response(res.body, { headers: downloadHeaders(res, p.k) });
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/storage/{id}/keys",
			tags: ["storage"],
			security,
			summary: "Scoped access keys LogiStack created",
			middleware: [requirePermission("read", svc)],
			request: { params: Id },
			responses: { 200: json(z.array(AccessKey), "Keys"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(storageAccessKey)
				.where(eq(storageAccessKey.serviceId, c.req.valid("param").id))
				.orderBy(asc(storageAccessKey.name));
			return c.json(
				rows.map((r) => ({
					id: r.id,
					name: r.name,
					accessKeyId: r.accessKeyId,
					buckets: r.buckets,
					access: r.access,
					createdAt: r.createdAt.toISOString(),
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"storage.key_create",
			createRoute({
				method: "post",
				path: "/storage/{id}/keys",
				tags: ["storage"],
				security,
				summary:
					"Create a key limited to some buckets; the secret is returned once",
				middleware: [
					requirePermission("write", svc),
					requirePermission("read:secrets", svc),
				],
				request: { params: Id, ...body(KeyInput) },
				responses: {
					201: json(
						AccessKey.extend({ secretAccessKey: z.string() }),
						"Created",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const s = await openStorage(c, id);
			const buckets = [...new Set(input.buckets)];
			const key = await s.client.createKey({
				name: input.name,
				buckets,
				access: input.access,
				policy: scopedKeyPolicy(buckets, input.access),
				generated: newStorageKey(s.engine),
			});
			const row = one(
				await c.var.deps.db
					.insert(storageAccessKey)
					.values({
						serviceId: id,
						name: input.name,
						accessKeyId: key.accessKeyId,
						buckets,
						access: input.access,
						createdBy: requireActor(c).userId,
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(
				{
					id: row.id,
					name: row.name,
					accessKeyId: row.accessKeyId,
					buckets: row.buckets,
					access: row.access,
					createdAt: row.createdAt.toISOString(),
					secretAccessKey: key.secretAccessKey,
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"storage.key_delete",
			createRoute({
				method: "delete",
				path: "/storage/{id}/keys/{keyId}",
				tags: ["storage"],
				security,
				summary: "Revoke a key in the engine and forget it",
				middleware: [requirePermission("write", svc)],
				request: { params: z.object({ id: z.string(), keyId: z.string() }) },
				responses: { 204: { description: "Revoked" }, ...errors },
			}),
		),
		async (c) => {
			const { id, keyId } = c.req.valid("param");
			const { db } = c.var.deps;
			const row = await keyRow(db, id, keyId);
			c.set("auditResourceId", row.id);
			const s = await openStorage(c, id);
			await s.client
				.deleteKey(row.accessKeyId)
				.catch((e: { status?: number }) => {
					// Already gone in the engine: forgetting it is the converged state.
					if (e.status !== 404) throw e;
				});
			await db.delete(storageAccessKey).where(eq(storageAccessKey.id, row.id));
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"storage.backup_destination",
			createRoute({
				method: "post",
				path: "/storage/{id}/backup-destination",
				tags: ["storage"],
				security,
				summary: "Make this storage an S3 backup destination",
				description:
					"Creates the bucket when missing, a key scoped to it, and an S3 destination the worker reaches on the storage network.",
				middleware: [requirePermission("write", svc)],
				request: {
					params: Id,
					...body(
						z.object({
							bucket: BucketName.default("logistack-backups"),
							name: Name.optional(),
						}),
					),
				},
				responses: {
					201: json(z.object({ id: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const actor = requireActor(c);
			// Destinations are org-wide integrations, so this needs what adding one by hand needs.
			check(c, "admin", {
				type: "organization",
				organizationId: actor.organizationId,
			});
			const { db, masterKey } = c.var.deps;
			const s = await openStorage(c, id);
			const [own] = await db
				.select({ name: service.name })
				.from(service)
				.where(eq(service.id, id));
			const existing = await s.client.listBuckets();
			if (!existing.some((b) => b.name === input.bucket))
				await s.client.createBucket(input.bucket);
			const name = input.name ?? `${own?.name ?? "storage"} backups`;
			const key = await s.client.createKey({
				name: `backups ${input.bucket}`,
				buckets: [input.bucket],
				access: "readwrite",
				policy: scopedKeyPolicy([input.bucket], "readwrite"),
				generated: newStorageKey(s.engine),
			});
			const row = await db.transaction(async (tx) => {
				await tx.insert(storageAccessKey).values({
					serviceId: id,
					name: `Backups (${name})`,
					accessKeyId: key.accessKeyId,
					buckets: [input.bucket],
					access: "readwrite",
					createdBy: actor.userId,
				});
				return one(
					await tx
						.insert(s3Destination)
						.values({
							organizationId: actor.organizationId,
							name,
							endpoint: `http://${s.slug}:${storageEngineDefs[s.engine].s3Port}`,
							region: STORAGE_REGION,
							bucket: input.bucket,
							prefix: "",
							accessKeyId: key.accessKeyId,
							secretEncrypted: await encrypt(masterKey, key.secretAccessKey),
							forcePathStyle: true,
							storageServiceId: id,
						})
						.returning({ id: s3Destination.id }),
				);
			});
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	);
