import type { StorageEngine, StorageKeyAccess } from "@logistack/contracts";
import { S3Client } from "bun";
import { ProviderError } from "../http.ts";
import { signV4 } from "../sigv4.ts";
import { madminEncrypt } from "./madmin.ts";

export type StorageConnection = {
	engine: StorageEngine;
	/** Base URL of the S3 API, e.g. `http://ls-svc-ab12:9000`. Path-style addressing. */
	endpoint: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Garage only: admin API base URL and bearer token. */
	admin?: { endpoint: string; token: string };
};

export type BucketInfo = { name: string; createdAt: string };
export type ObjectInfo = {
	key: string;
	size: number;
	lastModified: string;
	etag: string;
};
export type ObjectPage = {
	/** Common prefixes one level below `prefix`, each ending in `/`. */
	folders: string[];
	objects: ObjectInfo[];
	nextCursor: string | null;
};
export type ObjectHead = {
	size: number;
	contentType: string | null;
	etag: string | null;
	lastModified: string | null;
	metadata: Record<string, string>;
};
export type BucketUsage = { size: number; objects: number };

const PART_SIZE = 8 * 1024 * 1024;
/** RustFS (strictest) wants a letter first, then letters, digits, _ and -, at most 32. */
const engineName = (name: string) =>
	`ls-${name.replace(/[^A-Za-z0-9_-]+/g, "-")}`.slice(0, 32);
const EMPTY_SHA = new Bun.CryptoHasher("sha256").update("").digest("hex");

// RFC 3986: SigV4 wants everything but unreserved characters percent-encoded, `/` kept between segments.
const encodeSegment = (s: string) =>
	encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
const encodeKey = (key: string) => key.split("/").map(encodeSegment).join("/");

const entities: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};
const unxml = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
		e[0] === "#"
			? String.fromCodePoint(
					e[1] === "x" || e[1] === "X"
						? Number.parseInt(e.slice(2), 16)
						: Number(e.slice(1)),
				)
			: (entities[e] ?? m),
	);
const xmlEscape = (s: string) =>
	s.replace(
		/[<>&'"]/g,
		(c) =>
			({
				"<": "&lt;",
				">": "&gt;",
				"&": "&amp;",
				"'": "&apos;",
				'"': "&quot;",
			})[c] as string,
	);

/** Every `<tag>...</tag>` block, for the flat XML S3 returns. */
const blocks = (xml: string, tag: string) =>
	[...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
		(m) => m[1] as string,
	);
const field = (xml: string, tag: string) => {
	const v = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
	return v === undefined ? undefined : unxml(v);
};

export class StorageError extends ProviderError {
	constructor(
		op: string,
		message: string,
		status: number,
		readonly code?: string,
	) {
		super("storage", op, message, status);
	}
}

/** The S3 and admin operations LogiStack runs against one storage service, per engine. */
export function storageClient(conn: StorageConnection) {
	const base = conn.endpoint.replace(/\/+$/, "");
	const credentials = {
		accessKeyId: conn.accessKeyId,
		secretAccessKey: conn.secretAccessKey,
	};

	async function signed(
		op: string,
		method: string,
		path: string,
		init: {
			query?: Record<string, string>;
			body?: Uint8Array<ArrayBuffer> | string;
			headers?: Record<string, string>;
			service?: string;
			ok?: number[];
		} = {},
	): Promise<Response> {
		const url = new URL(`${base}${path}`);
		// URLSearchParams would send spaces as `+`, which S3 reads literally.
		url.search = Object.entries(init.query ?? {})
			.map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`)
			.join("&");
		const body =
			typeof init.body === "string"
				? new TextEncoder().encode(init.body)
				: init.body;
		const headers: Record<string, string> = {
			...init.headers,
			"x-amz-content-sha256": body
				? new Bun.CryptoHasher("sha256").update(body).digest("hex")
				: EMPTY_SHA,
		};
		const auth = await signV4(
			{ method, url: url.href, headers },
			{ credentials, region: conn.region, service: init.service ?? "s3" },
		);
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers: { ...headers, ...auth },
				...(body ? { body } : {}),
				signal: AbortSignal.timeout(60_000),
			});
		} catch (e) {
			throw new StorageError(
				op,
				`unreachable: ${e instanceof Error ? e.message : String(e)}`,
				502,
			);
		}
		if (!res.ok && !init.ok?.includes(res.status)) {
			const text = await res.text().catch(() => "");
			const code =
				field(text, "Code") ?? /"Code"\s*:\s*"([^"]+)"/.exec(text)?.[1];
			const message =
				field(text, "Message") ??
				/"Message"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
				(text.slice(0, 200) || res.statusText);
			throw new StorageError(op, message, res.status, code);
		}
		return res;
	}

	async function garage<T>(
		op: string,
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		ok: number[] = [],
	): Promise<{ status: number; data: T }> {
		if (!conn.admin) throw new StorageError(op, "no admin endpoint", 500);
		let res: Response;
		try {
			res = await fetch(`${conn.admin.endpoint.replace(/\/+$/, "")}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${conn.admin.token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (e) {
			throw new StorageError(
				op,
				`unreachable: ${e instanceof Error ? e.message : String(e)}`,
				502,
			);
		}
		const text = await res.text();
		if (!res.ok && !ok.includes(res.status)) {
			const msg =
				/"message"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 200);
			throw new StorageError(op, msg, res.status);
		}
		return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
	}

	async function minioAdmin(
		op: string,
		method: string,
		path: string,
		init: { query?: Record<string, string>; json?: unknown } = {},
	) {
		return signed(op, method, `/minio/admin/v3/${path}`, {
			...(init.query ? { query: init.query } : {}),
			...(init.json === undefined
				? {}
				: {
						body: await madminEncrypt(
							conn.secretAccessKey,
							new TextEncoder().encode(JSON.stringify(init.json)),
						),
						headers: { "content-type": "application/octet-stream" },
					}),
		});
	}

	const iam = (op: string, params: Record<string, string>) =>
		signed(op, "POST", "/", {
			body: new URLSearchParams({
				...params,
				Version: "2010-05-08",
			}).toString(),
			headers: {
				"content-type": "application/x-www-form-urlencoded; charset=utf-8",
			},
			service: "iam",
		}).then((r) => r.text());

	const garageBucketId = async (name: string) =>
		(
			await garage<{ id: string }>(
				"bucket",
				"GET",
				`/v2/GetBucketInfo?globalAlias=${encodeURIComponent(name)}`,
			)
		).data.id;

	const bun = new S3Client({
		endpoint: base,
		region: conn.region,
		...credentials,
	});

	async function listObjectVersions(bucket: string) {
		const out: { key: string; versionId?: string }[] = [];
		let keyMarker: string | undefined;
		let versionMarker: string | undefined;
		for (;;) {
			const xml = await (
				await signed("list versions", "GET", `/${bucket}`, {
					query: {
						versions: "",
						...(keyMarker ? { "key-marker": keyMarker } : {}),
						...(versionMarker ? { "version-id-marker": versionMarker } : {}),
					},
				})
			).text();
			for (const tag of ["Version", "DeleteMarker"])
				for (const b of blocks(xml, tag)) {
					const key = field(b, "Key");
					const versionId = field(b, "VersionId");
					if (key)
						out.push({
							key,
							// "null" names the pre-versioning version; leaving it out would only add a delete marker.
							...(versionId ? { versionId } : {}),
						});
				}
			if (field(xml, "IsTruncated") !== "true") return out;
			keyMarker = field(xml, "NextKeyMarker");
			versionMarker = field(xml, "NextVersionIdMarker");
		}
	}

	async function listAll(bucket: string, prefix: string) {
		const keys: { key: string }[] = [];
		let cursor: string | null = null;
		do {
			const page = await client.listObjects(bucket, {
				prefix,
				delimiter: false,
				...(cursor ? { cursor } : {}),
			});
			keys.push(...page.objects);
			cursor = page.nextCursor;
		} while (cursor);
		return keys;
	}

	async function deleteBatch(
		bucket: string,
		items: { key: string; versionId?: string }[],
	): Promise<number> {
		let deleted = 0;
		for (let i = 0; i < items.length; i += 1000) {
			const xml = `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${items
				.slice(i, i + 1000)
				.map(
					(o) =>
						`<Object><Key>${xmlEscape(o.key)}</Key>${o.versionId ? `<VersionId>${xmlEscape(o.versionId)}</VersionId>` : ""}</Object>`,
				)
				.join("")}</Delete>`;
			const md5 = new Bun.CryptoHasher("md5").update(xml).digest("base64");
			const res = await (
				await signed("delete objects", "POST", `/${bucket}`, {
					query: { delete: "" },
					body: xml,
					headers: { "content-md5": md5, "content-type": "application/xml" },
				})
			).text();
			const failed = blocks(res, "Error");
			if (failed.length)
				throw new StorageError(
					"delete objects",
					`${failed.length} not deleted: ${field(failed[0] as string, "Message") ?? ""}`,
					409,
				);
			deleted += Math.min(1000, items.length - i);
		}
		return deleted;
	}

	const client = {
		/** Garage starts without a layout or keys: assign this node and import the root key. Idempotent. */
		async ensureReady(): Promise<void> {
			if (conn.engine !== "garage") return;
			type Status = {
				nodes: {
					id: string;
					role: unknown;
					dataPartition?: { total: number };
				}[];
			};
			const status = (
				await garage<Status>("bootstrap", "GET", "/v2/GetClusterStatus")
			).data;
			const pending = status.nodes.filter((n) => !n.role);
			if (pending.length) {
				const layout = (
					await garage<{ version: number }>(
						"bootstrap",
						"GET",
						"/v2/GetClusterLayout",
					)
				).data;
				await garage("bootstrap", "POST", "/v2/UpdateClusterLayout", {
					roles: pending.map((n) => ({
						id: n.id,
						zone: "dc1",
						// Capacity only weighs nodes against each other; one node takes every partition.
						capacity: n.dataPartition?.total || 1e12,
						tags: [],
					})),
				});
				await garage("bootstrap", "POST", "/v2/ApplyClusterLayout", {
					version: layout.version + 1,
				});
			}
			const key = await garage<{ permissions?: { createBucket?: boolean } }>(
				"bootstrap",
				"GET",
				`/v2/GetKeyInfo?id=${conn.accessKeyId}`,
				undefined,
				[400, 404],
			);
			if (key.status !== 200)
				await garage("bootstrap", "POST", "/v2/ImportKey", {
					accessKeyId: conn.accessKeyId,
					secretAccessKey: conn.secretAccessKey,
					name: "logistack-root",
				});
			if (!key.data?.permissions?.createBucket)
				await garage(
					"bootstrap",
					"POST",
					`/v2/UpdateKey?id=${conn.accessKeyId}`,
					{
						allow: { createBucket: true },
					},
				);
		},

		async listBuckets(): Promise<BucketInfo[]> {
			const xml = await (await signed("list buckets", "GET", "/")).text();
			return blocks(xml, "Bucket")
				.map((b) => ({
					name: field(b, "Name") ?? "",
					createdAt: field(b, "CreationDate") ?? "",
				}))
				.filter((b) => b.name)
				.sort((a, b) => (a.name < b.name ? -1 : 1));
		},

		async createBucket(name: string): Promise<void> {
			if (conn.engine === "garage") {
				// A bucket made over S3 only gets a key-local alias; a global one lets scoped keys use the name.
				const { data } = await garage<{ id: string }>(
					"create bucket",
					"POST",
					"/v2/CreateBucket",
					{ globalAlias: name },
				);
				await garage("create bucket", "POST", "/v2/AllowBucketKey", {
					bucketId: data.id,
					accessKeyId: conn.accessKeyId,
					permissions: { read: true, write: true, owner: true },
				});
				return;
			}
			await signed("create bucket", "PUT", `/${name}`);
		},

		/** Empties the bucket (every version where the engine keeps them), then removes it. */
		async deleteBucket(name: string): Promise<number> {
			const items =
				conn.engine === "garage"
					? await listAll(name, "")
					: await listObjectVersions(name);
			const deleted = await deleteBatch(name, items);
			if (conn.engine === "garage")
				await garage(
					"delete bucket",
					"POST",
					`/v2/DeleteBucket?id=${await garageBucketId(name)}`,
				);
			else await signed("delete bucket", "DELETE", `/${name}`);
			return deleted;
		},

		async getVersioning(bucket: string): Promise<boolean> {
			const xml = await (
				await signed("versioning", "GET", `/${bucket}`, {
					query: { versioning: "" },
				})
			).text();
			return field(xml, "Status") === "Enabled";
		},

		async setVersioning(bucket: string, enabled: boolean): Promise<void> {
			await signed("versioning", "PUT", `/${bucket}`, {
				query: { versioning: "" },
				body: `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${enabled ? "Enabled" : "Suspended"}</Status></VersioningConfiguration>`,
				headers: { "content-type": "application/xml" },
			});
		},

		/** The bucket policy, or null when it has none. */
		async getPolicy(bucket: string): Promise<unknown> {
			const res = await signed("policy", "GET", `/${bucket}`, {
				query: { policy: "" },
				ok: [404],
			});
			if (res.status === 404) return null;
			return res.json().catch(() => null);
		},

		async setPolicy(bucket: string, policy: object | null): Promise<void> {
			if (policy === null)
				await signed("policy", "DELETE", `/${bucket}`, {
					query: { policy: "" },
					ok: [404],
				});
			else
				await signed("policy", "PUT", `/${bucket}`, {
					query: { policy: "" },
					body: JSON.stringify(policy),
					headers: { "content-type": "application/json" },
				});
		},

		/** Sizes and object counts per bucket, or null when the engine has no cheap source. */
		async usage(): Promise<Record<string, BucketUsage> | null> {
			if (conn.engine === "seaweedfs") return null;
			if (conn.engine === "garage") {
				const { data } = await garage<{ id: string }[]>(
					"usage",
					"GET",
					"/v2/ListBuckets",
				);
				const out: Record<string, BucketUsage> = {};
				for (const b of data) {
					const info = (
						await garage<{
							globalAliases: string[];
							objects: number;
							bytes: number;
						}>("usage", "GET", `/v2/GetBucketInfo?id=${b.id}`)
					).data;
					for (const alias of info.globalAliases)
						out[alias] = { size: info.bytes, objects: info.objects };
				}
				return out;
			}
			type Usage = {
				bucketsUsageInfo?: Record<
					string,
					{ size: number; objectsCount: number }
				>;
				buckets_usage?: Record<string, { size: number; objects_count: number }>;
			};
			// MinIO and RustFS refresh this from their background scanner, so it lags fresh writes.
			const u = (await (
				await minioAdmin("usage", "GET", "datausageinfo")
			).json()) as Usage;
			const out: Record<string, BucketUsage> = {};
			for (const [k, v] of Object.entries(u.bucketsUsageInfo ?? {}))
				out[k] = { size: v.size, objects: v.objectsCount };
			for (const [k, v] of Object.entries(u.buckets_usage ?? {}))
				out[k] = { size: v.size, objects: v.objects_count };
			return out;
		},

		async listObjects(
			bucket: string,
			opts: {
				prefix?: string;
				cursor?: string;
				limit?: number;
				/** false lists every key below the prefix, without folders. */
				delimiter?: boolean;
			} = {},
		): Promise<ObjectPage> {
			const xml = await (
				await signed("list objects", "GET", `/${bucket}`, {
					query: {
						"list-type": "2",
						"max-keys": String(opts.limit ?? 1000),
						prefix: opts.prefix ?? "",
						...(opts.delimiter === false ? {} : { delimiter: "/" }),
						...(opts.cursor ? { "continuation-token": opts.cursor } : {}),
					},
				})
			).text();
			return {
				folders: blocks(xml, "CommonPrefixes")
					.map((b) => field(b, "Prefix") ?? "")
					.filter(Boolean),
				objects: blocks(xml, "Contents")
					.map((b) => ({
						key: field(b, "Key") ?? "",
						size: Number(field(b, "Size") ?? 0),
						lastModified: field(b, "LastModified") ?? "",
						etag: (field(b, "ETag") ?? "").replaceAll('"', ""),
					}))
					// Some engines list the folder marker object itself.
					.filter((o) => o.key && o.key !== opts.prefix),
				nextCursor:
					field(xml, "IsTruncated") === "true"
						? (field(xml, "NextContinuationToken") ?? null)
						: null,
			};
		},

		async head(bucket: string, key: string): Promise<ObjectHead> {
			const res = await signed("head", "HEAD", `/${bucket}/${encodeKey(key)}`);
			const metadata: Record<string, string> = {};
			res.headers.forEach((v, k) => {
				if (k.startsWith("x-amz-meta-")) metadata[k.slice(11)] = v;
			});
			return {
				size: Number(res.headers.get("content-length") ?? 0),
				contentType: res.headers.get("content-type"),
				etag: res.headers.get("etag")?.replaceAll('"', "") ?? null,
				lastModified: res.headers.get("last-modified"),
				metadata,
			};
		},

		/** Streams `body` into a multipart upload; it is never buffered whole. */
		async upload(
			bucket: string,
			key: string,
			body: ReadableStream<Uint8Array>,
			contentType?: string,
		): Promise<void> {
			const writer = bun
				.file(key, { bucket, ...(contentType ? { type: contentType } : {}) })
				.writer({ partSize: PART_SIZE, queueSize: 2, retry: 3 });
			try {
				let pending = 0;
				for await (const chunk of body) {
					writer.write(chunk);
					pending += chunk.length;
					// Back-pressure: hold at most about one part in memory before the engine takes it.
					if (pending >= PART_SIZE) {
						await writer.flush();
						pending = 0;
					}
				}
				await writer.end();
			} catch (e) {
				const err = e as { message?: string; code?: string };
				throw new StorageError(
					"upload",
					err.message ?? String(e),
					502,
					err.code,
				);
			}
		},

		/** The engine's response, streamed: status, length and type headers included. */
		download(bucket: string, key: string): Promise<Response> {
			return signed("download", "GET", `/${bucket}/${encodeKey(key)}`);
		},

		/** Deletes keys; a key ending in `/` deletes everything under that prefix. */
		async deleteObjects(bucket: string, keys: string[]): Promise<number> {
			const items: { key: string }[] = [];
			for (const k of keys)
				if (k.endsWith("/"))
					items.push(...(await listAll(bucket, k)), { key: k });
				else items.push({ key: k });
			return deleteBatch(bucket, items);
		},

		async copy(bucket: string, from: string, to: string): Promise<void> {
			await signed("copy", "PUT", `/${bucket}/${encodeKey(to)}`, {
				headers: { "x-amz-copy-source": `/${bucket}/${encodeKey(from)}` },
			});
		},

		/** A presigned GET; `publicEndpoint` signs for the host clients will use. */
		presign(
			bucket: string,
			key: string,
			expiresIn: number,
			publicEndpoint?: string,
		): string {
			const signer = publicEndpoint
				? new S3Client({
						endpoint: publicEndpoint,
						region: conn.region,
						...credentials,
					})
				: bun;
			return signer.presign(key, { bucket, expiresIn, method: "GET" });
		},

		/** A key limited by `policy` (MinIO, RustFS, SeaweedFS) or per-bucket grants (Garage). */
		async createKey(o: {
			name: string;
			buckets: string[];
			access: StorageKeyAccess;
			policy: object;
			generated: { accessKeyId: string; secretAccessKey: string };
		}): Promise<{ accessKeyId: string; secretAccessKey: string }> {
			switch (conn.engine) {
				case "minio":
				case "rustfs":
					await minioAdmin("create key", "PUT", "add-service-account", {
						json: {
							policy: o.policy,
							accessKey: o.generated.accessKeyId,
							secretKey: o.generated.secretAccessKey,
							name: engineName(o.name),
							description: `LogiStack: ${o.name}`.slice(0, 256),
						},
					});
					return o.generated;
				case "garage": {
					const ids = await Promise.all(o.buckets.map(garageBucketId));
					const { data } = await garage<{
						accessKeyId: string;
						secretAccessKey: string;
					}>("create key", "POST", "/v2/CreateKey", {
						name: engineName(o.name),
					});
					for (const bucketId of ids)
						await garage("create key", "POST", "/v2/AllowBucketKey", {
							bucketId,
							accessKeyId: data.accessKeyId,
							permissions: {
								read: true,
								write: o.access === "readwrite",
								owner: false,
							},
						});
					return {
						accessKeyId: data.accessKeyId,
						secretAccessKey: data.secretAccessKey,
					};
				}
				case "seaweedfs": {
					const user = `ls-${o.generated.accessKeyId.toLowerCase()}`;
					await iam("create key", { Action: "CreateUser", UserName: user });
					const xml = await iam("create key", {
						Action: "CreateAccessKey",
						UserName: user,
					});
					await iam("create key", {
						Action: "PutUserPolicy",
						UserName: user,
						PolicyName: "logistack-scope",
						PolicyDocument: JSON.stringify(o.policy),
					});
					const accessKeyId = field(xml, "AccessKeyId");
					const secretAccessKey = field(xml, "SecretAccessKey");
					if (!accessKeyId || !secretAccessKey)
						throw new StorageError(
							"create key",
							"no key in the IAM reply",
							502,
						);
					return { accessKeyId, secretAccessKey };
				}
			}
		},

		async deleteKey(accessKeyId: string): Promise<void> {
			switch (conn.engine) {
				case "minio":
				case "rustfs":
					await minioAdmin("revoke key", "DELETE", "delete-service-account", {
						query: { accessKey: accessKeyId },
					});
					return;
				case "garage":
					await garage("revoke key", "POST", `/v2/DeleteKey?id=${accessKeyId}`);
					return;
				case "seaweedfs": {
					const users = blocks(
						await iam("revoke key", { Action: "ListUsers" }),
						"UserName",
					).filter((u) => u.startsWith("ls-"));
					for (const user of users) {
						const keys = await iam("revoke key", {
							Action: "ListAccessKeys",
							UserName: user,
						});
						if (!blocks(keys, "AccessKeyId").includes(accessKeyId)) continue;
						await iam("revoke key", {
							Action: "DeleteAccessKey",
							UserName: user,
							AccessKeyId: accessKeyId,
						});
						await iam("revoke key", {
							Action: "DeleteUserPolicy",
							UserName: user,
							PolicyName: "logistack-scope",
						});
						await iam("revoke key", { Action: "DeleteUser", UserName: user });
						return;
					}
					throw new StorageError("revoke key", "no such key", 404);
				}
			}
		},
	};
	return client;
}

export type StorageClient = ReturnType<typeof storageClient>;
